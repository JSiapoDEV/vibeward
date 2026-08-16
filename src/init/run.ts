// `vibeward init` — the one command in this tool that writes to disk. Everything it does is
// file in, file out: detect what the repo already uses, ask, show the exact plan, and only
// then write. It never overwrites: a file it did not author is left alone, a merge only
// touches its own delimited block or its own hook entries, and the first modification of any
// existing file leaves a `.vibeward.bak` beside it.
//
// It also explains rather than just installing. Six hosts enforce different amounts of this —
// one cannot gate a prompt at all, two can only block where others can warn — and a user
// choosing between them has to be able to see that before they rely on it, not after.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';
import type { Moment } from '../guard/verdict.js';
import type { Choice } from '../core/prompt.js';
import { isInteractive, multiselect, select } from '../core/prompt.js';
import { C, confirm, log } from '../core/terminal.js';
import { stalenessNotice } from '../core/version.js';
import { resolveGuard, upgradeGuardCommand, vendorGuard } from './binary.js';
import { guardHandlers } from './hooks.js';
import type { RenderContext } from './templates.js';
import { MARK, MARKER_END, MARKER_START } from './templates.js';
import type { Scope, Target, TargetFile } from './targets.js';
import { TARGETS, findTarget, targetsFor } from './targets.js';

export interface InitOptions {
  scope?: 'project' | 'user';
  targets?: string[];
  moments?: string[];
  all?: boolean;
  yes?: boolean;
}

/** `merge` covers both "replace our block" and "regenerate our own file". */
type Action = 'create' | 'merge' | 'skip';

interface PlanRow {
  target: Target;
  file: TargetFile;
  path: string;
  action: Action;
  detail: string;
  /** Exactly what will land on disk. Null when nothing will be written. */
  content: string | null;
}

/** The version stamp of any previous run, whatever version wrote it. */
const OWNED = /vibeward v\d+\.\d+\.\d+/;

/** Skip reason that still means "this file is installed". */
const UP_TO_DATE = 'already up to date';

const ALL_MOMENTS: Moment[] = ['prompt', 'action', 'content'];

const MOMENT_LABEL: Record<Moment, string> = {
  prompt: 'When you send a prompt',
  action: 'When the agent edits a file or runs a command',
  content: 'When the agent reads a page, file or tool result',
};

const MOMENT_HINT: Record<Moment, string> = {
  prompt: 'catches "disable RLS so it works" before the agent acts on it',
  action: 'catches the agent doing it on its own after a failing query — nobody asked for this one',
  content: 'catches instructions hidden in a README, a web page or an MCP result',
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
    `${C.red}vibeward init needs a terminal to ask its questions.${C.reset}`,
    `${C.dim}Pass the answers instead:${C.reset}`,
    '',
    `  vibeward init --scope project --targets claude-code,cursor --moments prompt,action --yes`,
    `  vibeward init --scope user --all --yes`,
    '',
    `${C.dim}Targets: ${TARGETS.map((t) => t.id).join(', ')}${C.reset}`,
    `${C.dim}Moments: ${ALL_MOMENTS.join(', ')}${C.reset}`,
    '',
  ]);
}

// ---------------------------------------------------------------------------
// Merging — never destructive
// ---------------------------------------------------------------------------

/**
 * Replaces the delimited block, or appends it when the file has no markers yet. Returns null
 * when the markers are in a state this cannot resolve safely — an unterminated start, a stray
 * end, or two blocks. Any guess there deletes text somebody wrote: an orphan `vibeward:start`
 * followed by our own appended block turns the whole gap between them into "our block", and
 * the next run silently swallows it.
 */
function mergeMarkers(existing: string, block: string): string | null {
  const start = existing.indexOf(MARKER_START);
  const strayEnd = existing.indexOf(MARKER_END);

  if (start < 0) {
    if (strayEnd >= 0) return null; // an end with no start: someone edited it by hand
    const base = existing.trimEnd();
    return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  }

  // More than one start marker is unresolvable, and checking for it BEFORE picking an end is
  // what makes that true. Searching only after the first end let a stray earlier
  // `vibeward:start` pair up with the real block's `vibeward:end`, so everything a person had
  // written between them was swallowed as "our block" and replaced.
  if (existing.indexOf(MARKER_START, start + MARKER_START.length) >= 0) return null;

  // Search from the start marker, never from position 0: an end that precedes it is not ours.
  const end = existing.indexOf(MARKER_END, start + MARKER_START.length);
  if (end < 0) return null;
  if (existing.indexOf(MARKER_END, end + MARKER_END.length) >= 0) return null; // two ends

  return existing.slice(0, start) + block + existing.slice(end + MARKER_END.length);
}

type MergeOutcome = 'added' | 'upgraded' | 'unchanged';

/**
 * Adds our hooks to a settings file the user also owns, keeping every other setting exactly as
 * it was. Returns null when the file is not JSON we can safely rewrite — a settings file with
 * a typo in it is the user's problem to fix, not ours to reformat.
 *
 * Per event, our previous entries are dropped and the current ones appended, so a re-run is
 * how you update and never how you accumulate. Entries that are not ours are never touched:
 * the filter only removes handlers whose command runs `vibeward … guard`.
 */
export function mergeHookSettings(
  raw: string,
  rendered: Record<string, unknown>,
  guardCommand: string,
): { content: string; outcome: MergeOutcome } | null {
  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return null;
  }
  const settings = asRecord(parsed);
  if (!settings) return null;

  const before = JSON.stringify(settings);
  const block = asRecord(rendered.hooks) ?? {};
  const hooks = asRecord(settings.hooks) ?? {};
  let carriedLegacy = false;
  /**
   * Flags the user added to our command, carried across the rewrite.
   *
   * `upgradeGuardCommand` has always preserved them, but its result was read as a boolean and
   * thrown away: our handlers were dropped and the freshly rendered ones appended, flags and
   * all. That was survivable while a rewrite only happened to the rare legacy `@latest` hook.
   * Now every re-run raises the pin, so discarding them would silently turn a `--block` guard
   * back into a warning on the next update — enforcement quietly downgraded, in a file nobody
   * re-reads, by the command whose job is to keep the guard current.
   */
  let carriedFlags = '';

  // Sibling keys the host requires alongside `hooks` — Cursor and Copilot both version their
  // manifest. Only ever filled in when absent: if the user pinned a different version, that is
  // their file and their decision.
  for (const [key, value] of Object.entries(rendered)) {
    if (key === 'hooks') continue;
    if (settings[key] === undefined) settings[key] = value;
  }

  for (const [event, groups] of Object.entries(block)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const kept: unknown[] = [];

    for (const group of existing) {
      const ours = guardHandlers(group);
      if (ours.length === 0) {
        kept.push(group);
        continue;
      }
      // A hook written by an older vibeward runs an older pin, or — before pinning existed —
      // `npx vibeward@latest guard`. Noting it here is what tells the user their install is
      // being brought forward rather than merely rewritten.
      for (const handler of ours) {
        const upgraded = upgradeGuardCommand(
          String(handler.command ?? handler.bash ?? ''),
          guardCommand,
        );
        if (upgraded) {
          carriedLegacy = true;
          if (!carriedFlags) carriedFlags = upgraded.slice(guardCommand.length);
        }
      }
      // Drop OUR handlers out of the group, not the whole group. Several hosts let one matcher
      // group hold a list of commands, so a user who put their own formatter beside our guard
      // had it deleted by a filter that worked at group granularity. Only when nothing but
      // ours was in there does the group itself go.
      const record = asRecord(group);
      const handlers = record && Array.isArray(record.hooks) ? record.hooks : null;
      if (!handlers) continue;
      const foreignHandlers = handlers.filter((h) => guardHandlers({ hooks: [h] }).length === 0);
      if (foreignHandlers.length > 0) kept.push({ ...record, hooks: foreignHandlers });
    }

    const incoming = Array.isArray(groups) ? groups : [groups];
    if (carriedFlags) {
      // Assigned, never appended: `rendered` is reused across the files of a multi-target
      // install, and `+=` would stack the same flags once per file.
      for (const group of incoming) {
        for (const handler of guardHandlers(group)) {
          if (typeof handler.command === 'string') handler.command = guardCommand + carriedFlags;
          else if (typeof handler.bash === 'string') handler.bash = guardCommand + carriedFlags;
        }
      }
    }
    hooks[event] = [...kept, ...incoming];
  }

  settings.hooks = hooks;
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  if (JSON.stringify(settings) === before) return { content: raw, outcome: 'unchanged' };
  return { content, outcome: carriedLegacy ? 'upgraded' : 'added' };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function row(
  target: Target,
  file: TargetFile,
  action: Action,
  detail: string,
  content: string | null,
): PlanRow {
  return { target, file, path: file.path, action, detail, content };
}

function planCreate(
  target: Target,
  file: TargetFile,
  current: string | null,
  ctx: RenderContext,
): PlanRow {
  const content = file.render(ctx);
  if (current === null) return row(target, file, 'create', 'new file', content);
  if (current === content) return row(target, file, 'skip', UP_TO_DATE, null);

  const previous = current.match(OWNED)?.[0];
  if (previous) return row(target, file, 'merge', `regenerated from ${previous}`, content);
  // Someone else wrote this file. Refusing is the only safe answer.
  return row(target, file, 'skip', 'already there and not written by vibeward', null);
}

function planMarkers(
  target: Target,
  file: TargetFile,
  current: string | null,
  ctx: RenderContext,
): PlanRow {
  const block = file.render(ctx);
  if (current === null) return row(target, file, 'create', 'new file', `${block}\n`);

  const next = mergeMarkers(current, block);
  if (next === null) {
    return row(target, file, 'skip', 'vibeward markers are malformed — left untouched', null);
  }
  if (next === current) return row(target, file, 'skip', UP_TO_DATE, null);
  const detail = current.includes(MARKER_START)
    ? 'replacing the vibeward block'
    : 'appending the vibeward block';
  return row(target, file, 'merge', detail, next);
}

function planJson(
  target: Target,
  file: TargetFile,
  current: string | null,
  ctx: RenderContext,
): PlanRow {
  const rendered = file.render(ctx);
  if (current === null) return row(target, file, 'create', 'new file', rendered);

  let manifest: Record<string, unknown>;
  try {
    manifest = asRecord(JSON.parse(rendered)) ?? {};
  } catch {
    return row(target, file, 'skip', 'could not build the hook manifest', null);
  }

  const merged = mergeHookSettings(current, manifest, ctx.guardCommand);
  if (merged === null) return row(target, file, 'skip', 'not valid JSON — left untouched', null);
  if (merged.outcome === 'unchanged') return row(target, file, 'skip', UP_TO_DATE, null);
  const events = Object.keys(asRecord(manifest.hooks) ?? {}).length;
  const detail =
    merged.outcome === 'upgraded'
      ? `raising the hook to ${ctx.guardCommand}`
      : `adding ${events} hook event(s)`;
  return row(target, file, 'merge', detail, merged.content);
}

function buildRow(target: Target, file: TargetFile, ctx: RenderContext): PlanRow {
  const current = existsSync(file.path) ? safeRead(file.path) : null;
  if (file.strategy === 'merge-json') return planJson(target, file, current, ctx);
  if (file.strategy === 'merge-markers') return planMarkers(target, file, current, ctx);
  return planCreate(target, file, current, ctx);
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
    const supported = t.scopes.includes(scope) && !t.unavailable?.(scope);
    const reason = supported ? null : (t.unavailable?.(scope) ?? 'not available in this scope');
    return {
      value: t.id,
      label: t.label,
      hint: supported ? t.hint : undefined,
      disabled: reason ?? undefined,
      selected: supported && t.detect(scope, cwd, home),
    };
  });
  return multiselect('What should I install?', choices);
}

/**
 * Which moments to guard. Asked only when a chosen host can actually run a hook, and asked
 * with the limitations visible: the whole point of this question is that the answer means
 * something different on Cursor than on Claude Code, and the user should see that here rather
 * than discover it when a prompt vanishes.
 */
async function askMoments(chosen: Target[]): Promise<Moment[] | null> {
  const notes: string[] = [];
  for (const t of chosen) {
    const lines = t.explain?.() ?? [];
    const limited = lines.filter((l) => /only block|not available|display-only|discards/i.test(l));
    for (const l of limited) notes.push(`${t.label} — ${l}`);
  }
  if (notes.length > 0) {
    log(`\n${C.yellow}Not every editor can do all three.${C.reset}`);
    for (const n of notes) log(`  ${C.dim}${n}${C.reset}`);
    log(
      `${C.dim}Where an editor can only block, vibeward stays silent rather than deleting your work.${C.reset}`,
    );
  }

  const choices: Choice[] = ALL_MOMENTS.map((m) => ({
    value: m,
    label: MOMENT_LABEL[m],
    hint: MOMENT_HINT[m],
    selected: true,
  }));
  const picked = await multiselect('What should the guard watch?', choices);
  return picked === null ? null : (picked as Moment[]);
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
      ? (target.unavailable?.(scope) ?? null)
      : 'not available in this scope';
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
 * shows: a `vibeward` already on PATH, else a pinned npx.
 *
 * There is no offer to install one any more. Recommending a global install made every user's
 * copy freeze at whatever they installed, and a security tool whose rules stopped moving is
 * the failure this is supposed to prevent. But removing it left every hook on `npx`, which
 * measures 2.06s per prompt with a warm cache against 0.13s for a local file — so for user
 * scope `init` now writes that file itself. The PATH lookup stays ahead of both, because
 * someone who does have the binary should not be made worse off by a docs decision.
 */
function resolveGuardContext(wanted: boolean, scope: Scope, moments: Moment[]): RenderContext {
  const guard = resolveGuard();
  if (!wanted || guard.binary) {
    return { guardCommand: guard.command, guardTimeout: guard.timeout, moments };
  }

  // Project scope keeps the pin. `.claude/settings.json` gets committed, so an absolute path
  // into one developer's home is two problems at once: a hook that fails for everybody else
  // on the team, and that developer's username published in a repository.
  const vendored = scope === 'user' ? vendorGuard(homedir()) : null;
  if (vendored) {
    log(
      `\n${C.green}✓${C.reset} ${C.dim}Guard copy at${C.reset} ${C.cyan}${vendored.binary}${C.reset}`,
    );
    log(
      `${C.dim}The hook runs that file directly — no npx, no network, nothing to resolve on${C.reset}`,
    );
    log(
      `${C.dim}the prompt you just typed. Re-run \`npx vibeward@latest init\` to update it.${C.reset}`,
    );
    return { guardCommand: vendored.command, guardTimeout: vendored.timeout, moments };
  }

  log(`\n${C.dim}The guard will run ${C.reset}${C.cyan}${guard.command}${C.reset}`);
  log(
    `${C.dim}Pinned on purpose: it runs on every prompt you type, and \`@latest\` there would${C.reset}`,
  );
  log(`${C.dim}execute whatever was published last, unreviewed, on your machine. Re-run${C.reset}`);
  log(
    `${C.dim}\`npx vibeward@latest init\` to raise the pin — it rewrites the hook in place.${C.reset}`,
  );
  if (scope === 'project') {
    log(
      `${C.dim}(A project settings file is shared, so it stays on npx. \`--scope user\` is faster.)${C.reset}`,
    );
  }
  return { guardCommand: guard.command, guardTimeout: guard.timeout, moments };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Copies the file aside before the first time vibeward changes it. Only the first time: a
 * second run must not bury the pristine original under its own output.
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
    `\n${C.bold}vibeward init${C.reset} ${C.dim}— install the audit skill and the guard into your AI tools${C.reset}\n`,
  );

  // Before anything is written, not after: the files this run is about to generate are frozen
  // copies of this version's templates, so installing from a stale binary bakes the staleness
  // into disk.
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

  const guardable = chosen.some((t) => t.guardable === true);
  let moments: Moment[] = ALL_MOMENTS;
  if (opts.moments?.length) {
    moments = opts.moments.filter((m): m is Moment => ALL_MOMENTS.includes(m as Moment));
  } else if (guardable && isInteractive() && !opts.all) {
    const picked = await askMoments(chosen);
    if (picked === null) cancelled();
    moments = picked;
  }

  const ctx = resolveGuardContext(guardable && moments.length > 0, scope, moments);

  // Copilot CLI reads a repository's `.claude/settings.json` as well as its own manifest, so
  // installing both in one project registers the guard twice there — two processes and two
  // identical notes per tool call. Harmless but wasteful, and confusing enough to be worth a
  // line. Not resolved automatically: which one to drop depends on whether they also use
  // Claude Code in this repo, and that is theirs to decide.
  const picked = new Set(chosen.map((t) => t.id));
  if (scope === 'project' && picked.has('claude-code') && picked.has('copilot') && moments.length) {
    log(
      `\n${C.yellow}⚠${C.reset} ${C.dim}Copilot CLI also reads .claude/settings.json, so with both installed the guard${C.reset}`,
    );
    log(
      `${C.dim}  runs twice per tool call there. Harmless, but drop one of the two if it bothers you.${C.reset}`,
    );
  }

  const rows: PlanRow[] = [];
  for (const target of chosen) {
    for (const file of target.files(scope, cwd, home, ctx)) rows.push(buildRow(target, file, ctx));
  }

  log(`\n${C.bold}Plan${C.reset} ${C.dim}(${MARK}, ${scope} scope)${C.reset}`);
  const width = Math.max(...rows.map((r) => display(r.path, cwd, home).length));
  for (const r of rows) {
    const color = r.action === 'create' ? C.green : r.action === 'merge' ? C.cyan : C.gray;
    const shown = display(r.path, cwd, home).padEnd(width);
    log(`  ${color}${r.action.padEnd(6)}${C.reset} ${shown}  ${C.dim}${r.detail}${C.reset}`);
  }

  // A skip only means "installed" when the file is already ours and current; a file we refused
  // to touch is not installed, and saying otherwise would be the whole point of this command,
  // missed.
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

  // What it does, and what it does not. The second half is the part a user cannot find out
  // any other way, and the part that decides whether they over-trust this.
  log(`\n${C.bold}What you now have${C.reset}`);
  const seen = new Set<string>();
  for (const r of installed) {
    if (seen.has(r.target.id)) continue;
    seen.add(r.target.id);
    const lines = r.target.explain?.(moments) ?? [];
    if (lines.length === 0) continue;
    log(`  ${C.cyan}${r.target.label}${C.reset}`);
    for (const line of lines) log(`    ${C.dim}${line}${C.reset}`);
  }

  log(
    `\n  ${C.dim}Try it:${C.reset} ${C.cyan}npx vibeward@latest https://your-site.com --passive --out vibeward-report.md --yes${C.reset}\n`,
  );

  process.exit(0);
}
