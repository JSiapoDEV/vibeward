// Seven ways to say the same sentence.
//
// Every host here runs an external command on lifecycle events, and every one of them spells
// that differently: a `hooks` key merged into a shared settings file, a standalone manifest we
// own outright, or — for opencode — a TypeScript module, because it has no config-file hooks
// at all and calls exported functions instead.
//
// The event names and JSON shapes were verified against first-party documentation; each host's
// `docs` URL in capabilities.ts is where to re-check a row that stops working. Writing a
// manifest a host does not read is the failure this whole file is arranged to avoid: it
// installs cleanly, it runs nothing, and the user believes they are covered.

import type { Moment } from '../guard/verdict.js';
import type { Host, HostId } from './capabilities.js';
import { MARK } from './templates.js';

export interface HookContext {
  /** What the hook will run. Resolved once per `init` run — see binary.ts. */
  guardCommand: string;
  guardTimeout: number;
}

/**
 * Which tools carry each moment, per host. A matcher that is too broad runs the guard on
 * every `ls`; one that is too narrow misses the write that matters. `null` means the event is
 * not tool-scoped and takes no matcher — and on several hosts, passing one anyway silently
 * stops the hook from ever firing.
 */
const MATCHERS: Record<HostId, Partial<Record<Moment, string | null>>> = {
  'claude-code': {
    prompt: null,
    action: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
    content: 'Read|WebFetch|WebSearch|Grep',
  },
  codex: {
    prompt: null,
    action: '^(Bash|Edit|Write|apply_patch)$',
    content: '^(Read|WebFetch|WebSearch)$',
  },
  cursor: { action: null, content: null },
  copilot: { action: 'bash|edit|create|write', content: 'read|fetch|search' },
  gemini: {
    prompt: null,
    action: 'write_file|replace|run_shell_command',
    content: 'read_file|read_many_files|web_fetch|google_web_search',
  },
  windsurf: { prompt: null, action: null },
  opencode: {},
};

/** The host's event name for a moment, or null when it has none we can use. */
function eventOf(host: Host, moment: Moment): string | null {
  return host.moments[moment].event;
}

/**
 * Cursor's `action` moment spans two events — one for shell, one for every other tool — so the
 * table in capabilities.ts names the shell one and this fills in the rest.
 */
function eventsFor(host: Host, moment: Moment): string[] {
  const primary = eventOf(host, moment);
  if (!primary) return [];
  if (host.id === 'cursor' && moment === 'action') return ['beforeShellExecution', 'preToolUse'];
  return [primary];
}

// ---------------------------------------------------------------------------
// The canonical structure, then one serializer per dialect
// ---------------------------------------------------------------------------

/** Claude Code and Codex share this shape exactly, down to the nested `hooks` array. */
function claudeShaped(host: Host, ctx: HookContext, moments: Moment[]): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const moment of moments) {
    for (const event of eventsFor(host, moment)) {
      const matcher = MATCHERS[host.id][moment];
      const group: Record<string, unknown> = {
        hooks: [
          {
            type: 'command',
            command: ctx.guardCommand,
            timeout: ctx.guardTimeout,
            // JSON carries no comments, so the stamp has to be a field. Without it a re-run
            // cannot tell a manifest it wrote from one a person wrote, and `init` refuses to
            // touch its own file forever with "already there and not written by vibeward".
            vibeward: MARK,
          },
        ],
      };
      // Omitted rather than set to "*": on an event that takes no matcher, including the key
      // is what stops the hook loading on some versions.
      if (matcher) group.matcher = matcher;
      (hooks[event] ??= []).push(group);
    }
  }
  return hooks;
}

function cursorShaped(host: Host, ctx: HookContext, moments: Moment[]): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const moment of moments) {
    for (const event of eventsFor(host, moment)) {
      (hooks[event] ??= []).push({
        command: ctx.guardCommand,
        timeout: ctx.guardTimeout,
        // Fail open on purpose. A guard that cannot run must not become a wall between the
        // user and their editor; a missed check is recoverable, a blocked session is not.
        failClosed: false,
        vibeward: MARK,
      });
    }
  }
  return { version: 1, hooks };
}

function copilotShaped(host: Host, ctx: HookContext, moments: Moment[]): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const moment of moments) {
    for (const event of eventsFor(host, moment)) {
      const matcher = MATCHERS[host.id][moment];
      const entry: Record<string, unknown> = {
        type: 'command',
        bash: ctx.guardCommand,
        timeoutSec: ctx.guardTimeout,
        vibeward: MARK,
      };
      if (matcher) entry.matcher = matcher;
      (hooks[event] ??= []).push(entry);
    }
  }
  return { version: 1, hooks };
}

function geminiShaped(host: Host, ctx: HookContext, moments: Moment[]): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const moment of moments) {
    for (const event of eventsFor(host, moment)) {
      const matcher = MATCHERS[host.id][moment];
      const group: Record<string, unknown> = {
        hooks: [
          {
            name: 'vibeward-guard',
            type: 'command',
            command: ctx.guardCommand,
            // Gemini counts this one in milliseconds, unlike every other host here.
            timeout: ctx.guardTimeout * 1000,
            vibeward: MARK,
          },
        ],
      };
      if (matcher) group.matcher = matcher;
      (hooks[event] ??= []).push(group);
    }
  }
  return hooks;
}

function windsurfShaped(host: Host, ctx: HookContext, moments: Moment[]): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const moment of moments) {
    // Windsurf splits `action` into a write event and a command event, and neither takes a
    // matcher — the event name is the matcher.
    const events =
      moment === 'action' ? ['pre_write_code', 'pre_run_command'] : eventsFor(host, moment);
    for (const event of events) {
      (hooks[event] ??= []).push({
        command: ctx.guardCommand,
        show_output: true,
        vibeward: MARK,
      });
    }
  }
  return { hooks };
}

/**
 * opencode loads a module, not a manifest, so `init` writes a small plugin that normalises the
 * callback arguments into vibeward's own wire shape and shells out to the same binary every
 * other host runs. The rules stay in one place; only the doorway differs.
 */
function opencodePlugin(ctx: HookContext, moments: Moment[]): string {
  const wants = (m: Moment): boolean => moments.includes(m);
  const parts: string[] = [
    `// ${MARK} — regenerate with \`npx vibeward@latest init\``,
    '//',
    '// opencode has no config-file command hooks, so this module is the manifest. It does no',
    '// detection of its own: it reshapes the callback arguments and hands them to the same',
    '// `vibeward guard` every other editor runs, so there is one rule table and not two.',
    'import type { Plugin } from "@opencode-ai/plugin"',
    '',
    'const GUARD = ' + JSON.stringify(ctx.guardCommand),
    '',
    'async function ask($: any, payload: unknown) {',
    '  const res = await $`${{ raw: GUARD }}`.stdin(JSON.stringify(payload)).nothrow().quiet()',
    '  const out = res.stdout.toString().trim()',
    '  if (!out) return null',
    '  try {',
    '    return JSON.parse(out) as { action: string; note: string }',
    '  } catch {',
    '    return null',
    '  }',
    '}',
    '',
    'export const Vibeward: Plugin = async ({ $ }) => ({',
  ];

  if (wants('prompt')) {
    parts.push(
      '  "chat.message": async (_input, output) => {',
      '    const text = String(output?.message?.text ?? "")',
      '    if (!text) return',
      '    const v = await ask($, { moment: "prompt", prompt: text })',
      '    // Appended rather than substituted: the user keeps every word they typed, and the',
      '    // model reads the warning alongside it.',
      '    if (v?.note) output.message.text = `${text}\\n\\n${v.note}`',
      '  },',
    );
  }
  if (wants('action')) {
    parts.push(
      '  "tool.execute.before": async (input, output) => {',
      '    const args = (output?.args ?? {}) as Record<string, unknown>',
      '    const v = await ask($, {',
      '      moment: "action",',
      '      command: typeof args.command === "string" ? args.command : undefined,',
      '      filePath: typeof args.filePath === "string" ? args.filePath : args.path,',
      '      content: typeof args.content === "string" ? args.content : undefined,',
      '    })',
      '    // Throwing is the only way to stop a call here, and the message is what the model',
      '    // is told — so the whole explanation has to travel in it.',
      '    if (v && v.action !== "note") throw new Error(v.note)',
      '  },',
    );
  }
  // A separate gate, not a continuation of the action one. Both handlers used to sit inside
  // `wants('action')`, so choosing only the content moment produced a plugin with no handlers
  // at all, and choosing only the action moment silently installed the content one too.
  if (wants('content')) {
    parts.push(
      '  "tool.execute.after": async (input, output) => {',
      '    const v = await ask($, {',
      '      moment: "content",',
      '      received: output?.output,',
      '      source: String(input?.tool ?? "a tool result"),',
      '    })',
      '    if (v?.note) output.output = `${v.note}\\n\\n${String(output?.output ?? "")}`',
      '  },',
    );
  }

  parts.push('})', '');
  return parts.join('\n');
}

/** The hook block for a host, as the object that belongs under its `hooks` key. */
export function hookBlock(
  host: Host,
  ctx: HookContext,
  moments: Moment[],
): Record<string, unknown> {
  const format = host.hooks?.format;
  if (format === 'claude-settings' || format === 'codex-hooks') {
    return claudeShaped(host, ctx, moments);
  }
  if (format === 'gemini-settings') return geminiShaped(host, ctx, moments);
  if (format === 'cursor-hooks') return cursorShaped(host, ctx, moments);
  if (format === 'copilot-hooks') return copilotShaped(host, ctx, moments);
  if (format === 'windsurf-hooks') return windsurfShaped(host, ctx, moments);
  return {};
}

/**
 * A COMPLETE, valid file for this host — never the bare block that gets merged into one.
 *
 * The distinction is the whole bug this comment exists to prevent. For a shared-settings host
 * the merge path unwraps this again and grafts the events onto whatever is already in the
 * user's file; but when that file does not exist yet, `init` writes this output verbatim. An
 * earlier version returned the bare event map for those hosts, which produced a
 * `.claude/settings.json` whose events sat at the top level instead of under `hooks` — valid
 * JSON, silently ignored, and indistinguishable from a working install.
 *
 * So: always the outer wrapper. Unwrapping is the merge's job, and it already does it.
 */
export function hookFile(host: Host, ctx: HookContext, moments: Moment[]): string {
  if (host.hooks?.format === 'opencode-plugin') return opencodePlugin(ctx, moments);
  const body = hookBlock(host, ctx, moments);
  // Cursor and Copilot carry a schema version alongside their hooks; the rest are just the key.
  const shaped = 'hooks' in body ? body : { hooks: body };
  return `${JSON.stringify(shaped, null, 2)}\n`;
}

/**
 * True when the host's hook file is also the user's, so it must be merged rather than created.
 *
 * Almost all of them are. `.cursor/hooks.json`, `.codex/hooks.json` and `.windsurf/hooks.json`
 * are not vibeward's files with a coincidental name — they are THE hooks file for that editor,
 * the one place the user registers their own. Treating them as ours to create means a repo
 * that already has one either gets clobbered or, as this did first, gets skipped with
 * "already there and not written by vibeward" — a refusal that is safe and still leaves the
 * user with no guard.
 *
 * The only two we genuinely own are the ones whose filename we chose: Copilot reads a whole
 * directory of manifests (`.github/hooks/vibeward.json`), and opencode loads every module in
 * its plugins directory.
 */
export function isSharedSettings(host: Host): boolean {
  const format = host.hooks?.format;
  return format !== undefined && format !== 'copilot-hooks' && format !== 'opencode-plugin';
}

/** Every command in a parsed settings object that runs our guard. Read defensively: user JSON. */
export function guardHandlers(group: unknown): Record<string, unknown>[] {
  const record =
    typeof group === 'object' && group !== null ? (group as Record<string, unknown>) : {};
  const handlers = Array.isArray(record.hooks) ? record.hooks : [record];
  return handlers.filter((h): h is Record<string, unknown> => {
    if (typeof h !== 'object' || h === null) return false;
    const entry = h as Record<string, unknown>;
    const command = entry.command ?? entry.bash;
    return typeof command === 'string' && /vibeward/.test(command) && /\bguard\b/.test(command);
  });
}
