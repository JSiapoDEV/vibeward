// `vibeward guard` — read stdin, work out which host and which moment, run the rules, and
// answer in that host's own dialect.
//
// One entry point for six hosts and three moments, because the alternative is six binaries
// that drift. The dispatch is driven entirely by the payload: `hook_event_name` says what
// moment it is, and the fields present say which host sent it, so a user's settings file
// needs no arguments beyond `vibeward guard` and cannot be wrong about its own event.

import { readStdin } from '../core/terminal.js';
import { stalenessNotice } from '../core/version.js';
import { findHost, type Host, type HostId } from '../init/capabilities.js';
import { ADAPTERS, detectHost, type Incoming } from './hosts.js';
import {
  scanCommandMoment,
  scanContentMoment,
  scanPromptMoment,
  scanWriteMoment,
} from './moments.js';
import type { Action, Moment, Risk, Verdict } from './verdict.js';

export interface GuardOptions {
  /** Override host detection. Needed only where a host sends nothing identifying. */
  host?: HostId;
  /** Escalate `prompt` matches from a note to a block. Opt-in; see the note below. */
  block?: boolean;
}

/**
 * How hard to push, given what happened and what the host can express.
 *
 * The default is always the softest thing that still reaches the model, and the reason is the
 * asymmetry of being wrong. A false positive that only adds a paragraph costs one ignored
 * note. A false positive that blocks costs the user the work they just did — and a user who
 * loses a paragraph they typed uninstalls the hook, after which it protects nobody.
 *
 * `action` is the exception. Nobody asked for that specific edit; the agent chose it. So the
 * right default there is to put the decision in front of the human WITH our reasoning
 * attached, which is what `ask` means — not to decide for them.
 */
function decide(moment: Moment, host: Host, opts: GuardOptions): Action {
  const support = host.moments[moment];
  if (moment === 'action') return support.canBlock ? 'ask' : 'note';
  if (moment === 'prompt' && opts.block) return support.canBlock ? 'deny' : 'note';
  // Everything else is a note. Where the host cannot carry one, the adapter turns it into
  // silence — saying nothing is the honest answer rather than escalating to a block the user
  // never asked for, and `init` tells them so before they rely on it.
  //
  // This deliberately does NOT branch on `support.canNote`. An earlier version wrote
  // `canNote ? 'note' : 'note'`, which reads like a capability check and is not one; the real
  // decision belongs in the adapter, which is the only place that knows what its host will
  // accept. Leaving a dead ternary here would keep suggesting otherwise.
  return 'note';
}

function risksFor(moment: Moment, incoming: Incoming): Risk[] {
  if (moment === 'prompt') return incoming.prompt ? scanPromptMoment(incoming.prompt) : [];
  if (moment === 'action') {
    const risks: Risk[] = [];
    if (incoming.command) risks.push(...scanCommandMoment(incoming.command));
    if (incoming.filePath && incoming.content) {
      risks.push(...scanWriteMoment({ filePath: incoming.filePath, content: incoming.content }));
    }
    return risks;
  }
  return incoming.received
    ? scanContentMoment(incoming.received, incoming.source ?? 'a tool result')
    : [];
}

/**
 * The pure half: payload in, verdict and reply out, no I/O and no process exit. Exported so
 * the conformance suite can drive every host and moment without spawning anything.
 */
export function evaluate(
  payload: Record<string, unknown>,
  opts: GuardOptions = {},
): { host: Host; verdict: Verdict; stdout?: string; stderr?: string; code: 0 | 2 } {
  const hostId = opts.host ?? detectHost(payload);
  const host = findHost(hostId) ?? findHost('claude-code')!;
  const adapter = ADAPTERS[host.id];

  const incoming = adapter.read(payload);
  const moment = incoming.moment;

  // A moment the host cannot act on is not a silent pass — it is a hook that should never
  // have been registered, and `init` does not register it. Reaching here means the user
  // wired it by hand, so stay quiet rather than printing JSON the host will not read.
  if (!moment || host.moments[moment].event === null) {
    return { host, verdict: { moment: moment ?? 'prompt', risks: [], action: 'note' }, code: 0 };
  }

  const risks = risksFor(moment, incoming);
  const verdict: Verdict = { moment, risks, action: decide(moment, host, opts) };
  if (risks.length === 0) return { host, verdict, code: 0 };

  const reply = adapter.reply(verdict, incoming);
  return { host, verdict, stdout: reply.stdout, stderr: reply.stderr, code: reply.code };
}

export async function runGuard(opts: GuardOptions = {}): Promise<never> {
  let result: ReturnType<typeof evaluate>;

  // Fail OPEN, always. This wrapper is the difference between a bug in vibeward being a missed
  // check and a bug in vibeward being a wall between someone and their editor. The guard sits
  // on the hot path of every prompt, every write and every tool result; an unhandled throw
  // here would exit non-zero, which on at least one host means "block", and the user would
  // have no idea why their agent stopped working. A missed check is recoverable. A jammed
  // editor gets the hook deleted, and then nothing is checked ever again.
  try {
    const raw = await readStdin();
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      payload =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : { prompt: raw };
    } catch {
      // Not JSON: treat the whole of stdin as a prompt. This is what the older `guard` did and
      // what a hand-rolled hook is most likely to send.
      payload = { prompt: raw };
    }
    result = evaluate(payload, opts);
  } catch (err) {
    // stderr only, and exit 0: on several hosts stderr is shown to the user or the model, and
    // on none of them does exit 0 stop anything.
    process.stderr.write(
      `vibeward guard could not run: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(0);
  }

  if (result.verdict.risks.length === 0) process.exit(0);

  // Only ever rides along with a real match. Appending it to every quiet run would put a
  // maintenance notice into thousands of unrelated conversations, which is how a useful nudge
  // becomes noise the model learns to skip.
  const stale = stalenessNotice();

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(`${result.stderr}\n${stale ? `${stale}\n` : ''}`);
  process.exit(result.code);
}
