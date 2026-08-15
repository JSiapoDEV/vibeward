// `vibeward init` — the one command in this tool that writes to disk. Everything it does
// is file in, file out: detect what the repo already uses, ask, show the exact plan, and
// only then write. It never overwrites: a file it did not author is left alone, a merge
// only touches its own delimited block, and the first modification of any existing file
// leaves a `.vibeward.bak` beside it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';
import type { Choice } from '../core/prompt.js';
import { isInteractive, multiselect, select } from '../core/prompt.js';
import { C, confirm, log } from '../core/terminal.js';
import { stalenessNotice } from '../core/version.js';
import { resolveGuard, upgradeGuardCommand } from './binary.js';
import type { RenderContext } from './templates.js';
import { HOOK_EVENT, MARK, MARKER_END, MARKER_START, guardHook } from './templates.js';
import type { Scope, Target } from './targets.js';
import { TARGETS, findTarget, targetsFor } from './targets.js';

export interface InitOptions {
  scope?: 'project' | 'user';
  targets?: string[];
  all?: boolean;
  yes?: boolean;
}

/** `merge` covers both "replace our block" and "regenerate our own file". */
type Action = 'create' | 'merge' | 'skip';

interface PlanRow {
  target: Target;
  path: string;
  action: Action;
  detail: string;
  /** Exactly what will land on disk. Null when nothing will be written. */
  content: string | null;
}

/** The version stamp of any previous run, whatever version wrote it. */
const OWNED = /vibeward v\d+\.\d+\.\d+/;

/** Skip reason that still means "this target is installed". */
const UP_TO_DATE = 'already up to date';

const NEXT_STEPS: Record<string, string[]> = {
  'claude-skill': [
    'Claude Code — open a new session, then `/vibeward <url>`, or just ask it to audit the site.',
  ],
  'claude-hook': [
    'Claude Code — risky prompts ("disable RLS", "use the service_role key") are now checked',
    'before the agent acts, in English, Spanish and Portuguese. The prompt is not blocked:',
    "the rule is injected into the agent's context so it corrects itself. Add `--block` to",
    'the hook command for a hard stop instead.',
  ],
  cursor: ['Cursor — the rule applies from the next chat, no restart needed.'],
  'agents-md': [
    'AGENTS.md is read by Codex, Copilot, Cursor, Windsurf and ~20 more.',
    'Claude Code reads CLAUDE.md and not AGENTS.md: add `@AGENTS.md` as the first line of',
    'CLAUDE.md, or install the Claude Code skill above.',
  ],
  windsurf: ['Windsurf / Devin Desktop — the rule activates when a request looks related.'],
  'gh-action': [
    'GitHub Action — commit the workflow; findings land in the repository Security tab.',
  ],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function display(path: string, cwd: string, home: string): string {
  if (path.startsWith(cwd + sep)) return path.slice(cwd.length + 1);
  if (path.startsWith(home + sep)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bail(lines: string[]): never {
  for (const line of lines) log(line);
  process.exit(1);
}

function cancelled(): never {
  log(`\n${C.gray}Nothing was written.${C.reset}\n`);
  process.exit(0);
}

function usage(): never {
  return bail([
    `${C.red}vibeward init needs a terminal to ask its two questions.${C.reset}`,
    `${C.dim}Pass the answers instead:${C.reset}`,
    '',
    `  vibeward init --scope project --targets claude-skill,claude-hook,cursor --yes`,
    `  vibeward init --scope user --all --yes`,
    '',
    `${C.dim}Targets: ${TARGETS.map((t) => t.id).join(', ')}${C.reset}`,
    '',
  ]);
}

// ---------------------------------------------------------------------------
// Merging — never destructive
// ---------------------------------------------------------------------------

/**
 * Replaces the delimited block, or appends it when the file has no markers yet. Returns
 * null when the markers are in a state this cannot resolve safely — an unterminated start,
 * a stray end, or two blocks. Any guess there deletes text somebody wrote: an orphan
 * `vibeward:start` followed by our own appended block turns the whole gap between them into
 * "our block", and the next run silently swallows it.
 */
function mergeMarkers(existing: string, block: string): string | null {
  const start = existing.indexOf(MARKER_START);
  const strayEnd = existing.indexOf(MARKER_END);

  if (start < 0) {
    if (strayEnd >= 0) return null; // an end with no start: someone edited it by hand
    const base = existing.trimEnd();
    return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  }

  // Search from the start marker, never from position 0: an end that precedes it is not ours.
  const end = existing.indexOf(MARKER_END, start + MARKER_START.length);
  if (end < 0) return null;
  if (existing.indexOf(MARKER_START, end) >= 0) return null; // more than one block

  return existing.slice(0, start) + block + existing.slice(end + MARKER_END.length);
}

/** Every handler in this matcher group that runs the guard. Read defensively: user JSON. */
function guardHandlers(group: unknown): Record<string, unknown>[] {
  const handlers = asRecord(group)?.hooks;
  if (!Array.isArray(handlers)) return [];
  return handlers.filter((h): h is Record<string, unknown> => {
    const command = asRecord(h)?.command;
    return typeof command === 'string' && /vibeward/.test(command) && /\bguard\b/.test(command);
  });
}

type MergeOutcome = 'added' | 'upgraded' | 'unchanged';

/**
 * Adds the guard to `settings.json`, keeping every other setting exactly as it was.
 * Returns null when the file is not JSON we can safely rewrite — a settings file with a
 * typo in it is the user's problem to fix, not ours to reformat.
 *
 * A hook written by an older vibeward runs `npx vibeward@latest guard`, which re-resolves
 * against the registry on every prompt. Leaving it alone would mean nobody who ever ran
 * `init` migrates off it, so that exact prefix — and only that one — is rewritten in place.
 */
function mergeGuardHook(
  raw: string,
  ctx: RenderContext,
): { content: string; outcome: MergeOutcome } | null {
  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return null;
  }
  const settings = asRecord(parsed);
  if (!settings) return null;

  const hooks = asRecord(settings.hooks) ?? {};
  const existing = hooks[HOOK_EVENT];
  const groups: unknown[] = Array.isArray(existing) ? existing : [];

  const present = groups.flatMap(guardHandlers);
  if (present.length > 0) {
    let upgraded = false;
    for (const handler of present) {
      const next = upgradeGuardCommand(handler.command as string, ctx.guardCommand);
      if (next === null) continue;
      handler.command = next;
      handler.timeout = ctx.guardTimeout;
      upgraded = true;
    }
    if (!upgraded) return { content: raw, outcome: 'unchanged' };
    return { content: `${JSON.stringify(settings, null, 2)}\n`, outcome: 'upgraded' };
  }

  settings.hooks = { ...hooks, [HOOK_EVENT]: [...groups, guardHook(ctx)] };
  return { content: `${JSON.stringify(settings, null, 2)}\n`, outcome: 'added' };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function row(
  target: Target,
  path: string,
  action: Action,
  detail: string,
  content: string | null,
): PlanRow {
  return { target, path, action, detail, content };
}

function planCreate(
  target: Target,
  path: string,
  current: string | null,
  ctx: RenderContext,
): PlanRow {
  const content = target.render(ctx);
  if (current === null) return row(target, path, 'create', 'new file', content);
  if (current === content) return row(target, path, 'skip', UP_TO_DATE, null);

  const previous = current.match(OWNED)?.[0];
  if (previous) return row(target, path, 'merge', `regenerated from ${previous}`, content);
  // Someone else wrote this file. Refusing is the only safe answer.
  return row(target, path, 'skip', 'already there and not written by vibeward', null);
}

function planMarkers(
  target: Target,
  path: string,
  current: string | null,
  ctx: RenderContext,
): PlanRow {
  const block = target.render(ctx);
  if (current === null) return row(target, path, 'create', 'new file', `${block}\n`);

  const next = mergeMarkers(current, block);
  if (next === null) {
    return row(target, path, 'skip', 'vibeward markers are malformed — left untouched', null);
  }
  if (next === current) return row(target, path, 'skip', UP_TO_DATE, null);
  const detail = current.includes(MARKER_START)
    ? 'replacing the vibeward block'
    : 'appending the vibeward block';
  return row(target, path, 'merge', detail, next);
}

function planJson(
  target: Target,
  path: string,
  current: string | null,
  ctx: RenderContext,
): PlanRow {
  if (current === null) return row(target, path, 'create', 'new file', `${target.render(ctx)}\n`);

  const merged = mergeGuardHook(current, ctx);
  if (merged === null) {
    return row(target, path, 'skip', 'not valid JSON — left untouched', null);
  }
  if (merged.outcome === 'unchanged') return row(target, path, 'skip', UP_TO_DATE, null);
  const detail =
    merged.outcome === 'upgraded'
      ? `repointing the hook off npx @latest → ${ctx.guardCommand}`
      : `adding the ${HOOK_EVENT} hook`;
  return row(target, path, 'merge', detail, merged.content);
}

function buildRow(target: Target, path: string, ctx: RenderContext): PlanRow {
  const current = existsSync(path) ? safeRead(path) : null;
  if (target.strategy === 'merge-json') return planJson(target, path, current, ctx);
  if (target.strategy === 'merge-markers') return planMarkers(target, path, current, ctx);
  return planCreate(target, path, current, ctx);
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

async function askScope(cwd: string, home: string): Promise<Scope | null> {
  const picked = await select('Where do you want it?', [
    { value: 'project', label: 'This project', hint: cwd, selected: true },
    { value: 'user', label: 'My user account', hint: `${home} — available in every repo` },
  ]);
  return picked === 'project' || picked === 'user' ? picked : null;
}

async function askTargets(scope: Scope, cwd: string, home: string): Promise<string[] | null> {
  // Every target is listed, including the ones this scope cannot take: greyed out with the
  // reason beats hidden, which just reads as a missing feature.
  const choices: Choice[] = TARGETS.map((t) => {
    const supported = t.scopes.includes(scope);
    const reason = supported ? null : (t.unavailable?.(scope) ?? 'not available in this scope');
    const path = supported ? t.path(scope, cwd, home) : null;
    const suffix = t.strategy === 'create' ? '' : '   merge';
    return {
      value: t.id,
      label: t.label,
      hint: path ? `${display(path, cwd, home)}${suffix}` : undefined,
      disabled: reason ?? undefined,
      selected: supported && t.detect(scope, cwd, home),
    };
  });
  return multiselect('What should I install?', choices);
}

function resolveTargets(ids: string[], scope: Scope): Target[] {
  const chosen: Target[] = [];
  for (const id of ids) {
    const target = findTarget(id);
    if (!target) {
      bail([
        `${C.red}Unknown target "${id}".${C.reset}`,
        `${C.dim}Available: ${TARGETS.map((t) => t.id).join(', ')}${C.reset}`,
        '',
      ]);
    }
    const reason = target.scopes.includes(scope)
      ? null
      : (target.unavailable?.(scope) ?? 'not available in this scope');
    if (reason) {
      log(`${C.yellow}⚠ Skipping ${id}:${C.reset} ${reason}`);
      continue;
    }
    if (!chosen.includes(target)) chosen.push(target);
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// What the guard hook will run
// ---------------------------------------------------------------------------

/**
 * Decides the hook command before anything is planned, because it changes what the preview
 * shows. Order: an installed binary, else offer to install one, else a pinned npx. The
 * offer only happens on a terminal — a CI run gets the pin silently, which is the correct
 * answer there anyway.
 */
async function resolveGuardContext(wanted: boolean, yes: boolean): Promise<RenderContext> {
  let guard = resolveGuard();
  if (!wanted || guard.binary) {
    return { guardCommand: guard.command, guardTimeout: guard.timeout };
  }

  log(`\n${C.yellow}No installed \`vibeward\` on your PATH.${C.reset}`);
  log(
    `${C.dim}The guard runs on every prompt you type. Running it through npx would add a${C.reset}`,
  );
  log(
    `${C.dim}registry round-trip to each one, break with no network, and — the reason that${C.reset}`,
  );
  log(`${C.dim}matters — run whatever was published last, unreviewed, on your machine.${C.reset}`);

  if (isInteractive() && !yes) {
    const ok = await confirm(
      `\n${C.bold}Install it now?${C.reset} ${C.dim}npm i -g vibeward${C.reset} [y/N] `,
    );
    if (ok) {
      log(`\n${C.dim}$ npm i -g vibeward${C.reset}`);
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('npm', ['i', '-g', 'vibeward'], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      if (result.status === 0) {
        guard = resolveGuard();
        if (guard.binary) {
          log(
            `\n${C.green}✓${C.reset} installed — the hook will run ${C.cyan}${guard.command}${C.reset}`,
          );
          return { guardCommand: guard.command, guardTimeout: guard.timeout };
        }
        // Installed, but the global bin directory is not on this shell's PATH. Writing
        // the bare name would produce a hook that fails on every prompt.
        log(`\n${C.yellow}Installed, but not on this shell's PATH.${C.reset}`);
      } else {
        log(
          `\n${C.yellow}That did not work${C.reset} ${C.dim}(npm exited ${result.status ?? 'abnormally'})${C.reset}`,
        );
      }
    }
  }

  log(
    `${C.dim}Pinning to ${guard.command} instead — a future publish will not run until you${C.reset}`,
  );
  log(`${C.dim}raise the pin, or install the binary and re-run \`vibeward init\`.${C.reset}`);
  return { guardCommand: guard.command, guardTimeout: guard.timeout };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Copies the file aside before the first time vibeward changes it. Only the first time:
 * a second run must not bury the pristine original under its own output.
 */
function backupOnce(path: string): string | null {
  const backup = `${path}.vibeward.bak`;
  if (existsSync(backup)) return null;
  copyFileSync(path, backup);
  return backup;
}

function writeRow(plan: PlanRow, cwd: string, home: string): void {
  if (plan.content === null) return;
  const shown = display(plan.path, cwd, home);
  mkdirSync(dirname(plan.path), { recursive: true });

  const backup = existsSync(plan.path) ? backupOnce(plan.path) : null;
  writeFileSync(plan.path, plan.content, 'utf8');

  const verb = plan.action === 'create' ? 'created' : 'updated';
  const note = backup ? ` ${C.dim}(backup: ${display(backup, cwd, home)})${C.reset}` : '';
  log(`  ${C.green}✓${C.reset} ${verb} ${shown}${note}`);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function runInit(opts: InitOptions): Promise<never> {
  const cwd = process.cwd();
  const home = homedir();

  log(
    `\n${C.bold}vibeward init${C.reset} ${C.dim}— install the audit-and-fix skill into your AI tools${C.reset}\n`,
  );

  // Before anything is written, not after: the files this run is about to generate are
  // frozen copies of this version's templates, so installing from a stale binary bakes the
  // staleness into disk.
  const stale = stalenessNotice();
  if (stale) log(`${C.yellow}⚠${C.reset} ${C.dim}${stale}${C.reset}\n`);

  const needsScope = !opts.scope;
  const needsTargets = !opts.all && (opts.targets?.length ?? 0) === 0;
  if ((needsScope || needsTargets) && !isInteractive()) usage();

  const scope = opts.scope ?? (await askScope(cwd, home));
  if (!scope) cancelled();

  let chosen: Target[];
  if (opts.all) chosen = targetsFor(scope);
  else if (opts.targets && opts.targets.length > 0) chosen = resolveTargets(opts.targets, scope);
  else {
    const picked = await askTargets(scope, cwd, home);
    if (picked === null) cancelled();
    chosen = resolveTargets(picked, scope);
  }

  if (chosen.length === 0) {
    log(`\n${C.gray}No targets selected. Nothing was written.${C.reset}\n`);
    process.exit(0);
  }

  const ctx = await resolveGuardContext(
    chosen.some((t) => t.strategy === 'merge-json'),
    opts.yes ?? false,
  );

  const rows: PlanRow[] = [];
  for (const target of chosen) {
    const path = target.path(scope, cwd, home);
    if (path) rows.push(buildRow(target, path, ctx));
  }

  log(`\n${C.bold}Plan${C.reset} ${C.dim}(${MARK}, ${scope} scope)${C.reset}`);
  const width = Math.max(...rows.map((r) => display(r.path, cwd, home).length));
  for (const r of rows) {
    const color = r.action === 'create' ? C.green : r.action === 'merge' ? C.cyan : C.gray;
    const shown = display(r.path, cwd, home).padEnd(width);
    log(`  ${color}${r.action.padEnd(6)}${C.reset} ${shown}  ${C.dim}${r.detail}${C.reset}`);
  }

  // A skip only means "installed" when the file is already ours and current; a file we
  // refused to touch is not installed, and saying otherwise would be the whole point of
  // this command, missed.
  const installed = rows.filter((r) => r.content !== null || r.detail === UP_TO_DATE);
  const pending = rows.filter((r) => r.content !== null);
  if (pending.length === 0) {
    log(
      installed.length === rows.length
        ? `\n${C.green}Everything is already in place.${C.reset}\n`
        : `\n${C.yellow}Nothing to write — see the reasons above.${C.reset}\n`,
    );
    process.exit(0);
  }
  if (pending.some((r) => r.action === 'merge')) {
    log(
      `\n${C.dim}Existing files are merged, never overwritten, and copied to <file>.vibeward.bak first.${C.reset}`,
    );
  }

  if (!opts.yes && isInteractive()) {
    const ok = await confirm(`\n${C.bold}Write ${pending.length} file(s)?${C.reset} [y/N] `);
    if (!ok) cancelled();
  }

  log('');
  for (const r of pending) writeRow(r, cwd, home);

  log(`\n${C.bold}Now what${C.reset}`);
  for (const r of installed) {
    for (const line of NEXT_STEPS[r.target.id] ?? []) log(`  ${C.dim}${line}${C.reset}`);
  }
  log(
    `\n  ${C.dim}Try it:${C.reset} ${C.cyan}npx vibeward@latest https://your-site.com --json --stdout --yes${C.reset}\n`,
  );

  process.exit(0);
}
