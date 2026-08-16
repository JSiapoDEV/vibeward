// What each host can actually enforce, as data, in one place.
//
// This table is the reason `init` can promise anything at all. Six hosts disagree about
// where files live, what the events are called, which JSON key means "stop", and — the part
// that matters most — whether a hook can put text in front of the MODEL or only in front of
// the human. Getting that last one backwards produces the worst possible outcome: a hook that
// installs cleanly, runs on every prompt, and does nothing, while the user believes they are
// covered.
//
// Every path and every event name below was verified against first-party documentation.
// `docs` is the source, and it is not decoration: these products change, and the next person
// to touch a row needs to know where to check it.
//
// Consumed by BOTH `init` (what to write, and what to tell the user it cannot do) and `guard`
// (how to phrase the answer). One table, so the two can never drift.

import type { Moment } from '../guard/verdict.js';

export type HostId =
  'claude-code' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'windsurf' | 'opencode';

/**
 * How the host's hook manifest is shaped. Not a formatting detail — each one has a different
 * container (a settings file that must be merged key-by-key, a standalone file we own, a
 * TypeScript module), and that decides whether `init` can write it without destroying
 * something the user put there.
 */
export type HookFormat =
  | 'claude-settings'
  | 'codex-hooks'
  | 'cursor-hooks'
  | 'copilot-hooks'
  | 'gemini-settings'
  | 'windsurf-hooks'
  | 'opencode-plugin';

export interface MomentSupport {
  /** The host's own event name, or null when the moment does not exist here. */
  event: string | null;
  /**
   * Can the hook put text in front of the MODEL while letting the turn continue?
   *
   * This is the capability vibeward is built around: warn, explain, and let the user keep
   * what they typed. Where it is false, the only lever is blocking — and blocking a false
   * positive costs the user their work, which is how a guardrail gets uninstalled.
   */
  canNote: boolean;
  /** Can the hook stop the thing from happening? */
  canBlock: boolean;
  /** What a user needs to know before trusting this. Shown verbatim by `init`. */
  caveat?: string;
}

export interface Host {
  id: HostId;
  label: string;
  /** Where the SKILL.md goes. `user` is null when the host has no global location. */
  skill: { project: string; user: string | null };
  hooks: { project: string; user: string; format: HookFormat } | null;
  moments: Record<Moment, MomentSupport>;
  /**
   * Anything true about this host that the moment table cannot express — most importantly,
   * when the skill and the guard reach different products under the same brand name. Printed
   * verbatim by `init`.
   */
  note?: string;
  /** First-party documentation, so the next person can re-verify a row that broke. */
  docs: string;
}

const NONE: MomentSupport = { event: null, canNote: false, canBlock: false };

export const HOSTS: Host[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    skill: {
      project: '.claude/skills/vibeward/SKILL.md',
      user: '.claude/skills/vibeward/SKILL.md',
    },
    hooks: {
      project: '.claude/settings.json',
      user: '.claude/settings.json',
      format: 'claude-settings',
    },
    moments: {
      prompt: { event: 'UserPromptSubmit', canNote: true, canBlock: true },
      action: { event: 'PreToolUse', canNote: true, canBlock: true },
      content: {
        event: 'PostToolUse',
        canNote: true,
        canBlock: false,
        caveat:
          'The tool has already run by the time this fires, so a warning explains rather than prevents. Files the user pulls in with `@` are inlined without a tool call and are never seen.',
      },
    },
    docs: 'https://code.claude.com/docs/en/hooks',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    // Not `.codex/skills`: Codex reads the shared `.agents/skills` location, and a file under
    // `.codex/skills` is never loaded no matter how right it looks next to `.codex/hooks.json`.
    skill: {
      project: '.agents/skills/vibeward/SKILL.md',
      user: '.agents/skills/vibeward/SKILL.md',
    },
    hooks: { project: '.codex/hooks.json', user: '.codex/hooks.json', format: 'codex-hooks' },
    moments: {
      prompt: { event: 'UserPromptSubmit', canNote: true, canBlock: true },
      action: { event: 'PreToolUse', canNote: true, canBlock: true },
      content: { event: 'PostToolUse', canNote: true, canBlock: true },
    },
    docs: 'https://learn.chatgpt.com/docs/hooks',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    skill: {
      project: '.cursor/skills/vibeward/SKILL.md',
      user: '.cursor/skills/vibeward/SKILL.md',
    },
    hooks: { project: '.cursor/hooks.json', user: '.cursor/hooks.json', format: 'cursor-hooks' },
    moments: {
      prompt: {
        event: 'beforeSubmitPrompt',
        canNote: false,
        canBlock: true,
        caveat:
          'This event returns only `continue` and `user_message` — there is no way to pass a note to the model. The choice here is to block the prompt or do nothing, and blocking discards what the user just typed.',
      },
      action: { event: 'beforeShellExecution', canNote: true, canBlock: true },
      content: { event: 'postToolUse', canNote: true, canBlock: false },
    },
    docs: 'https://cursor.com/docs/hooks',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    skill: {
      project: '.github/skills/vibeward/SKILL.md',
      user: '.copilot/skills/vibeward/SKILL.md',
    },
    hooks: {
      project: '.github/hooks/vibeward.json',
      user: '.copilot/hooks/vibeward.json',
      format: 'copilot-hooks',
    },
    moments: {
      prompt: {
        // The event exists, but a config-file hook's output is discarded — documented
        // explicitly, not inferred. Registering one would run a process on every prompt and
        // achieve nothing, which is worse than not registering it.
        ...NONE,
        caveat:
          'Copilot drops the output of a config-file hook on this event, so there is no way to warn or block from one. Only the SDK can gate a prompt here.',
      },
      action: {
        event: 'preToolUse',
        canNote: false,
        canBlock: true,
        caveat:
          'The reason reaches the model only when the action is denied. There is no way to let it through with a warning attached.',
      },
      content: { event: 'postToolUse', canNote: true, canBlock: false },
    },
    // The one host where "Copilot" names more than one product, and the two halves land in
    // different places. Worth saying out loud: someone installing this from VS Code would
    // otherwise reasonably conclude the guard is now running there, and it is not.
    note: 'the skill also loads in VS Code and JetBrains agent mode, but the guard does NOT — hooks exist only in Copilot CLI and the cloud agent. Skills there are also model-discretion and user-toggleable, so the skill is never a guaranteed-every-turn channel.',
    docs: 'https://docs.github.com/en/copilot/concepts/agents/hooks',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    skill: {
      project: '.gemini/skills/vibeward/SKILL.md',
      user: '.gemini/skills/vibeward/SKILL.md',
    },
    hooks: {
      project: '.gemini/settings.json',
      user: '.gemini/settings.json',
      format: 'gemini-settings',
    },
    moments: {
      prompt: { event: 'BeforeAgent', canNote: true, canBlock: true },
      action: {
        event: 'BeforeTool',
        canNote: false,
        canBlock: true,
        caveat:
          'Only a denial reaches the model here. An allow carries no message, so a warning has to become a block or nothing.',
      },
      content: { event: 'AfterTool', canNote: true, canBlock: true },
    },
    docs: 'https://geminicli.com/docs/hooks/reference/',
  },
  {
    id: 'windsurf',
    label: 'Windsurf / Devin',
    skill: {
      project: '.windsurf/skills/vibeward/SKILL.md',
      user: '.codeium/windsurf/skills/vibeward/SKILL.md',
    },
    hooks: {
      project: '.windsurf/hooks.json',
      user: '.codeium/windsurf/hooks.json',
      format: 'windsurf-hooks',
    },
    moments: {
      // No JSON protocol at all on this host: a pre-hook blocks by exiting 2, and the agent
      // reads stderr. So the only way to say anything is to stop the action while saying it.
      prompt: {
        event: 'pre_user_prompt',
        canNote: false,
        canBlock: true,
        caveat:
          'Windsurf has no JSON output protocol — a hook speaks by exiting 2 and writing to stderr, which also blocks. There is no way to warn without stopping.',
      },
      action: {
        event: 'pre_run_command',
        canNote: false,
        canBlock: true,
        caveat: 'Same as above: the message and the block are the same act.',
      },
      content: {
        ...NONE,
        caveat:
          'The post-read events exist but their output is display-only — nothing a hook prints there ever reaches the model.',
      },
    },
    docs: 'https://docs.windsurf.com/windsurf/cascade/hooks',
  },
  {
    id: 'opencode',
    label: 'opencode',
    skill: {
      project: '.opencode/skills/vibeward/SKILL.md',
      user: '.config/opencode/skills/vibeward/SKILL.md',
    },
    // Not a manifest: opencode loads a TypeScript module and calls exported functions. `init`
    // writes a small plugin that shells out to this same binary, so the rules stay in one place.
    hooks: {
      project: '.opencode/plugins/vibeward.ts',
      user: '.config/opencode/plugins/vibeward.ts',
      format: 'opencode-plugin',
    },
    moments: {
      prompt: { event: 'chat.message', canNote: true, canBlock: true },
      action: { event: 'tool.execute.before', canNote: true, canBlock: true },
      content: { event: 'tool.execute.after', canNote: true, canBlock: true },
    },
    docs: 'https://opencode.ai/docs/plugins',
  },
];

export function findHost(id: string): Host | null {
  return HOSTS.find((h) => h.id === id) ?? null;
}

/** The moments this host can do anything useful at all with. */
export function usableMoments(host: Host): Moment[] {
  return (['prompt', 'action', 'content'] as Moment[]).filter(
    (m) => host.moments[m].event !== null,
  );
}

/**
 * One line per moment, in plain words, for the `init` picker and its summary. This is the
 * "explain, do not just install" half of the contract: a user choosing between hosts has to
 * be able to see that Cursor cannot warn without blocking and Copilot cannot gate a prompt
 * at all, without reading this file.
 */
export function explain(host: Host, chosen?: Moment[]): string[] {
  const label: Record<Moment, string> = {
    prompt: 'when you send a prompt',
    action: 'when the agent edits a file or runs a command',
    content: 'when the agent reads a page, file or tool result',
  };
  const out: string[] = [];
  for (const moment of ['prompt', 'action', 'content'] as Moment[]) {
    const m = host.moments[moment];
    // A moment the user did not pick is not installed, so claiming it here would describe
    // protection they do not have. Said plainly instead — the summary exists to be trusted.
    if (chosen && !chosen.includes(moment)) {
      if (m.event) out.push(`${label[moment]}: not installed — you did not select it`);
      continue;
    }
    // Describes what the guard actually DOES, which is not the same as what the host can
    // express. `action` resolves to an ask wherever the host can stop something — nobody
    // asked for that edit, so the decision goes to the human — while `prompt` and `content`
    // stay passive. Reporting all three as "warns without interrupting" was wrong about the
    // one moment that interrupts.
    const verdict = !m.event
      ? 'not available'
      : moment === 'action' && m.canBlock
        ? 'asks you first, with the reason attached'
        : m.canNote
          ? 'warns without interrupting'
          : 'can only block, not warn';
    out.push(`${label[moment]}: ${verdict}${m.caveat ? ` — ${m.caveat}` : ''}`);
  }
  if (host.note) out.push(host.note);
  return out;
}
