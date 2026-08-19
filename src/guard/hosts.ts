// Six hosts, one verdict. Everything host-specific is in this file and nowhere else.
//
// Each adapter does two things: read the host's stdin payload into a canonical shape, and
// render a Verdict into whatever that host actually honours. The second half is where the
// real differences live, and they are not cosmetic — `additionalContext` vs `agent_message`
// vs "exit 2 and write to stderr" are three different products of three different teams, and
// printing the wrong one is indistinguishable, from the user's side, from having no hook.

import type { HostId } from '../init/capabilities.js';
import type { Moment, Verdict } from './verdict.js';
import { humanNote, modelNote } from './verdict.js';

/** What a hook was handed, once the host's own vocabulary is stripped off. */
export interface Incoming {
  moment: Moment | null;
  /** `prompt` moment. */
  prompt?: string;
  /** `action` moment: a pending file write. */
  filePath?: string;
  content?: string;
  /** `action` moment: a pending shell command. */
  command?: string;
  /** `content` moment: what a tool returned, flattened to text. */
  received?: string;
  /** Where the content came from, for the report. */
  source?: string;
  /** The host's own event name, echoed back in responses that require it. */
  event?: string;
}

/** What to print, and what to exit with. */
export interface Reply {
  stdout?: string;
  stderr?: string;
  code: 0 | 2;
}

export interface Adapter {
  read(payload: Record<string, unknown>): Incoming;
  reply(verdict: Verdict, incoming: Incoming): Reply;
}

const CLEAN: Reply = { code: 0 };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * A tool result flattened to text. Hosts return wildly different shapes here — a string, a
 * `{stdout, stderr}` pair, an MCP content array — and the injection rules only care about the
 * words, so anything unrecognised is stringified rather than dropped. Dropping it would mean
 * the one payload shape nobody anticipated is also the one that goes unscanned.
 */
function flatten(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (depth > 4) return '';
  if (Array.isArray(v)) return v.map((x) => flatten(x, depth + 1)).join('\n');
  return Object.values(v as Record<string, unknown>)
    .map((x) => flatten(x, depth + 1))
    .join('\n');
}

/**
 * The text a write tool is about to put on disk, whatever shape the host wraps it in.
 *
 * `content` covers Write, `new_string` covers Edit — and neither covers MultiEdit, which
 * carries an `edits` array, or apply_patch, which carries a diff under `patch`/`input`. Those
 * two were registered in every manifest and then silently skipped here for want of a key, so
 * an agent writing a service key through MultiEdit walked past the gate that exists for it.
 * Anything unrecognised is flattened rather than dropped: the rules only need the words.
 */
function pendingContent(input: Record<string, unknown>): string | undefined {
  const direct =
    str(input.content) ??
    str(input.new_string) ??
    str(input.new_str) ??
    str(input.patch) ??
    str(input.diff) ??
    str(input.text);
  if (direct) return direct;

  const edits = input.edits ?? input.replacements ?? input.changes;
  if (Array.isArray(edits)) {
    const joined = edits.map((e) => flatten(e)).join('\n');
    if (joined.trim()) return joined;
  }
  const nested = str(input.input);
  return nested && nested.trim() ? nested : undefined;
}

/** Tool names that mean "the agent is about to write a file", across every host. */
const WRITE_TOOL =
  /^(write|edit|create|apply_patch|multiedit|notebookedit|str_replace|replace|write_file|developer__write|developer__edit)$/i;
/** Tool names that mean "the agent is about to run a command". */
const SHELL_TOOL =
  /^(bash|shell|powershell|runcommand|run_shell_command|terminal|developer__shell|execute)$/i;

/**
 * The Claude Code shape, which Codex reuses almost exactly. Both send `hook_event_name` plus
 * `tool_name` / `tool_input` / `tool_response`, and both read `hookSpecificOutput`.
 */
function readClaudeLike(p: Record<string, unknown>): Incoming {
  const event = str(p.hook_event_name) ?? '';
  const toolName = str(p.tool_name) ?? '';
  const input = obj(p.tool_input);

  if (/UserPromptSubmit/i.test(event)) {
    return { moment: 'prompt', prompt: str(p.prompt), event };
  }
  if (/PreToolUse/i.test(event)) {
    if (SHELL_TOOL.test(toolName)) {
      return { moment: 'action', command: str(input.command), event };
    }
    if (WRITE_TOOL.test(toolName)) {
      return {
        moment: 'action',
        filePath: str(input.file_path) ?? str(input.path),
        content: pendingContent(input),
        event,
      };
    }
    return { moment: null, event };
  }
  if (/PostToolUse/i.test(event)) {
    const received = flatten(p.tool_response);
    return {
      moment: received ? 'content' : null,
      received,
      source: str(input.file_path) ?? str(input.url) ?? toolName,
      event,
    };
  }
  return { moment: null, event };
}

const claudeCode: Adapter = {
  read: readClaudeLike,
  reply(v, incoming) {
    const event = incoming.event ?? 'UserPromptSubmit';
    // `--block` at the prompt. `UserPromptSubmit` has no `permissionDecision` field — the only
    // way to stop a prompt on this host is exit 2, where stderr goes to the person and never
    // to the model. So this is `humanNote`, not `modelNote`: the prompt is gone, there is no
    // agent turn left to inform, and the reader is the one who has to decide what to retype.
    //
    // Without this branch a prompt-moment `deny` fell through to the plain-note return below
    // and exited 0, which made `--block` a no-op on the one editor the README documents it
    // for, while capabilities.ts kept advertising `canBlock: true`.
    if (v.action === 'deny' && incoming.moment === 'prompt') {
      return { stderr: humanNote(v), code: 2 };
    }
    if (v.action === 'deny' && incoming.moment === 'action') {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            permissionDecision: 'deny',
            permissionDecisionReason: modelNote(v),
          },
        }),
        code: 0,
      };
    }
    if (v.action === 'ask' && incoming.moment === 'action') {
      // `ask` hands the decision to the human WITH our reasoning attached, which is the whole
      // point: the permission dialog otherwise carries the agent's framing and none of ours.
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            permissionDecision: 'ask',
            permissionDecisionReason: humanNote(v),
            additionalContext: modelNote(v),
          },
        }),
        code: 0,
      };
    }
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: modelNote(v) },
      }),
      code: 0,
    };
  },
};

const codex: Adapter = {
  read: readClaudeLike,
  reply(v, incoming) {
    const event = incoming.event ?? 'UserPromptSubmit';
    if (v.action !== 'note' && incoming.moment === 'action') {
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            permissionDecision: v.action === 'deny' ? 'deny' : 'ask',
            permissionDecisionReason: modelNote(v),
          },
        }),
        code: 0,
      };
    }
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: modelNote(v) },
      }),
      code: 0,
    };
  },
};

const cursor: Adapter = {
  read(p) {
    // Read the event name like every other adapter, and fall back to the payload shape only
    // when it is absent (the plain-text stdin path).
    const event = str(p.hook_event_name) ?? str(p.event) ?? '';
    const input = obj(p.tool_input);

    if (/beforeSubmitPrompt/i.test(event) || (event === '' && str(p.prompt) !== undefined)) {
      return { moment: 'prompt', prompt: str(p.prompt), event: 'beforeSubmitPrompt' };
    }
    if (/beforeShellExecution/i.test(event) || (event === '' && str(p.command) !== undefined)) {
      return { moment: 'action', command: str(p.command), event: 'beforeShellExecution' };
    }
    if (/preToolUse/i.test(event)) {
      if (str(p.command) !== undefined || str(input.command) !== undefined) {
        return { moment: 'action', command: str(p.command) ?? str(input.command), event };
      }
      return {
        moment: 'action',
        filePath: str(input.file_path) ?? str(p.file_path),
        content: str(input.content) ?? str(p.content) ?? str(input.new_string),
        event,
      };
    }
    if (/postToolUse|afterFileEdit|beforeReadFile/i.test(event) || event === '') {
      const received = flatten(p.tool_response ?? p.content ?? p.tool_output);
      if (received) {
        return {
          moment: 'content',
          received,
          source: str(p.file_path) ?? str(p.url) ?? str(p.tool_name) ?? 'tool result',
          event: event || 'postToolUse',
        };
      }
    }
    return { moment: null, event };
  },
  reply(v, incoming) {
    if (incoming.moment === 'prompt') {
      // The only two fields this event honours are `continue` and `user_message`. There is no
      // channel to the model at all, so a note is unrepresentable: either the prompt is
      // stopped with an explanation for the human, or nothing happens.
      if (v.action === 'note') return CLEAN;
      return {
        stdout: JSON.stringify({ continue: false, user_message: humanNote(v) }),
        code: 0,
      };
    }
    if (incoming.moment === 'action') {
      return {
        stdout: JSON.stringify({
          permission: v.action === 'deny' ? 'deny' : 'ask',
          user_message: humanNote(v),
          agent_message: modelNote(v),
        }),
        code: 0,
      };
    }
    return { stdout: JSON.stringify({ additional_context: modelNote(v) }), code: 0 };
  },
};

const copilot: Adapter = {
  read(p) {
    const event = str(p.hook_event_name) ?? str(p.event) ?? '';
    const toolName = str(p.tool_name) ?? str(p.toolName) ?? '';
    const input = obj(p.tool_input ?? p.args ?? p.arguments);
    if (/preToolUse/i.test(event)) {
      if (SHELL_TOOL.test(toolName))
        return { moment: 'action', command: str(input.command), event };
      return {
        moment: 'action',
        filePath: str(input.file_path) ?? str(input.path),
        content: str(input.content),
        event,
      };
    }
    if (/postToolUse/i.test(event)) {
      const received = flatten(p.tool_response ?? p.result);
      return { moment: received ? 'content' : null, received, source: toolName, event };
    }
    // userPromptSubmitted is deliberately unhandled: Copilot discards the output of a
    // config-file hook on that event, so there is nothing useful to return.
    return { moment: null, event };
  },
  reply(v, incoming) {
    if (incoming.moment === 'action') {
      // `permissionDecisionReason` is the only text that reaches the model here, and only on
      // a denial — so on this host a warning has to become an ask, or be silent.
      return {
        stdout: JSON.stringify({
          permissionDecision: v.action === 'deny' ? 'deny' : 'ask',
          permissionDecisionReason: modelNote(v),
        }),
        code: 0,
      };
    }
    return { stdout: JSON.stringify({ additionalContext: modelNote(v) }), code: 0 };
  },
};

const gemini: Adapter = {
  read(p) {
    const event = str(p.hook_event_name) ?? str(p.eventName) ?? '';
    const toolName = str(p.tool_name) ?? str(p.toolName) ?? '';
    const input = obj(p.tool_input ?? p.toolInput ?? p.args);
    if (/BeforeAgent/i.test(event)) {
      return { moment: 'prompt', prompt: str(p.prompt) ?? str(p.message), event };
    }
    if (/BeforeTool/i.test(event)) {
      if (SHELL_TOOL.test(toolName))
        return { moment: 'action', command: str(input.command), event };
      return {
        moment: 'action',
        filePath: str(input.file_path) ?? str(input.absolute_path) ?? str(input.path),
        content: str(input.content) ?? str(input.new_string),
        event,
      };
    }
    if (/AfterTool/i.test(event)) {
      const received = flatten(p.tool_response ?? p.toolResponse ?? p.result);
      return { moment: received ? 'content' : null, received, source: toolName, event };
    }
    return { moment: null, event };
  },
  reply(v, incoming) {
    const event = incoming.event ?? 'BeforeAgent';
    if (incoming.moment === 'action') {
      // BeforeTool honours no additive context — the switch that applies hook output handles
      // only `tool_input`. A denial is the one thing the model will be told about.
      if (v.action === 'note') return CLEAN;
      return { stdout: JSON.stringify({ decision: 'deny', reason: modelNote(v) }), code: 0 };
    }
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: modelNote(v) },
      }),
      code: 0,
    };
  },
};

const windsurf: Adapter = {
  read(p) {
    const event = str(p.hook_event_name) ?? str(p.event) ?? '';
    if (/pre_user_prompt/i.test(event)) return { moment: 'prompt', prompt: str(p.prompt), event };
    if (/pre_run_command/i.test(event)) return { moment: 'action', command: str(p.command), event };
    if (/pre_write_code/i.test(event)) {
      return {
        moment: 'action',
        filePath: str(p.file_path) ?? str(p.path),
        content: str(p.content) ?? str(p.new_content),
        event,
      };
    }
    return { moment: null, event };
  },
  reply(v) {
    // No JSON protocol exists on this host. A pre-hook speaks by exiting 2, and Cascade reads
    // stderr — which means saying anything and stopping the action are the same act. So only
    // a decision at least as strong as `ask` is worth expressing; a plain note would have to
    // block the user's work to be heard, and that trade is not worth making for a rule match.
    if (v.action === 'note') return CLEAN;
    return { stderr: modelNote(v), code: 2 };
  },
};

const opencode: Adapter = {
  // The plugin `init` writes normalises opencode's callback arguments into this shape before
  // shelling out, so the wire format here is vibeward's own rather than opencode's.
  read(p) {
    const moment = str(p.moment);
    if (moment === 'prompt') return { moment: 'prompt', prompt: str(p.prompt) };
    if (moment === 'action') {
      return {
        moment: 'action',
        command: str(p.command),
        filePath: str(p.filePath),
        content: str(p.content),
      };
    }
    if (moment === 'content') {
      return { moment: 'content', received: flatten(p.received), source: str(p.source) };
    }
    return { moment: null };
  },
  reply(v) {
    return { stdout: JSON.stringify({ action: v.action, note: modelNote(v) }), code: 0 };
  },
};

export const ADAPTERS: Record<HostId, Adapter> = {
  'claude-code': claudeCode,
  codex,
  cursor,
  copilot,
  gemini,
  windsurf,
  opencode,
};

/**
 * Which host is on the other end, when `--host` was not passed. Claude Code and Codex share a
 * payload shape and are told apart by the fields only one of them sends; the rest are
 * distinguishable by their event names.
 */
export function detectHost(p: Record<string, unknown>): HostId {
  const event = str(p.hook_event_name) ?? str(p.event) ?? str(p.eventName) ?? '';
  // opencode never lands here by accident: the plugin `init` writes sends vibeward's own wire
  // shape, and `moment` is a key no editor emits.
  if (str(p.moment) !== undefined) return 'opencode';

  // Cursor MUST be identified by its own fields, not by its event name.
  //
  // Two earlier attempts got this wrong in opposite directions, and both left Cursor users
  // with a hook that ran and protected nothing. First it was recognised by the absence of an
  // event name — but Cursor does send `hook_event_name`. Then the camelCase branch below
  // claimed it, because `preToolUse` and `postToolUse` are the same two strings Copilot uses.
  // No test on the event name can separate them.
  //
  // `conversation_id` / `generation_id` / `workspace_roots` are Cursor's common input fields
  // and no other host sends them, so they are the tiebreak — and they have to be tested
  // before the camelCase branch, not after.
  if (
    p.conversation_id !== undefined ||
    p.generation_id !== undefined ||
    p.workspace_roots !== undefined ||
    // Cursor is also the only host that puts `command` + `cwd` + `sandbox` at the top level.
    (p.sandbox !== undefined && str(p.command) !== undefined)
  ) {
    return 'cursor';
  }
  // A payload with no event name at all reaches us from the plain-text stdin fallback and from
  // anything hand-rolled. Cursor is the closest fit for the tool-shaped case, and the prompt
  // case is handled by run.ts wrapping bare text as `{prompt}` — which every adapter reads.
  if (event === '') return 'cursor';

  if (/^(BeforeAgent|BeforeTool|AfterTool)$/i.test(event)) return 'gemini';
  if (/^pre_(user_prompt|run_command|write_code)$/i.test(event)) return 'windsurf';
  // Copilot lowercases the first letter where Claude Code and Codex capitalise it.
  if (/^(before|after|pre|post|user)[A-Z]/.test(event)) return 'copilot';
  // `prompt_id` and `permission_mode` are Claude Code's alone; Codex sends neither.
  if (p.prompt_id !== undefined || p.permission_mode !== undefined) return 'claude-code';
  return 'codex';
}
