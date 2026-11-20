// `vibeward guard` — read stdin, work out which host and which moment, run the rules, and
// answer in that host's own dialect.
//
// One entry point for six hosts and three moments, because the alternative is six binaries
// that drift. The dispatch is driven entirely by the payload: `hook_event_name` says what
// moment it is, and the fields present say which host sent it, so a user's settings file
// needs no arguments beyond `vibeward guard` and cannot be wrong about its own event.

import { loadConfig } from '../core/config.js';
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
import { remember, summaryText, takeSeen, type Seen } from './session.js';
import {
  DEFAULT_GUARD_LEVEL,
  isGuardLevel,
  type Action,
  type GuardLevel,
  type Moment,
  type Risk,
  type Verdict,
} from './verdict.js';

export interface GuardOptions {
  /** Override host detection. Needed only where a host sends nothing identifying. */
  host?: HostId;
  /** Escalate `prompt` matches from a note to a block. Opt-in; see the note below. */
  block?: boolean;
  /** How often the person may be interrupted. Defaults to `medium`. */
  level?: GuardLevel;
}

/**
 * How hard to push, given what happened, what the host can express, and how often the person
 * agreed to be interrupted.
 *
 * The default is always the softest thing that still reaches the model, and the reason is the
 * asymmetry of being wrong. A false positive that only adds a paragraph costs one ignored
 * note. A false positive that blocks costs the user the work they just did — and a user who
 * loses a paragraph they typed uninstalls the hook, after which it protects nobody.
 *
 * `action` is where the level matters. Nobody asked for that specific edit; the agent chose
 * it. Up to 0.7 every flagged action stopped for the person, which is right for someone
 * watching and wrong for the vibe coder who started the agent and walked away: a run that
 * waits on a dialog for an hour is a run that gets the guard uninstalled. So the level picks:
 *
 *            prompt                      action                         content
 *   warn     note                        note                           note
 *   medium   note                        ask if critical, else note     note
 *   high     deny if critical, else note deny if critical, else ask     note
 *
 * Every row also feeds the end-of-turn summary, which is how a note the person never saw is
 * still read. `--block` keeps its old meaning — stop every flagged prompt — at any level.
 */
export function decide(moment: Moment, host: Host, opts: GuardOptions, risks: Risk[] = []): Action {
  const support = host.moments[moment];
  const level = opts.level ?? DEFAULT_GUARD_LEVEL;
  const critical = risks.some((r) => r.severity === 'critical');

  if (moment === 'action') {
    if (!support.canBlock || level === 'warn') return 'note';
    if (level === 'medium') return critical ? 'ask' : 'note';
    return critical ? 'deny' : 'ask';
  }
  if (moment === 'prompt' && (opts.block || (level === 'high' && critical))) {
    return support.canBlock ? 'deny' : 'note';
  }
  // Everything else is a note. Where the host cannot carry one, the adapter turns it into
  // silence — saying nothing is the honest answer rather than escalating to a block the user
  // never asked for, and `init` tells them so before they rely on it.
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
export interface Evaluation {
  host: Host;
  verdict: Verdict;
  incoming: Incoming;
  stdout?: string;
  stderr?: string;
  code: 0 | 2;
}

export function evaluate(payload: Record<string, unknown>, opts: GuardOptions = {}): Evaluation {
  const hostId = opts.host ?? detectHost(payload);
  const host = findHost(hostId) ?? findHost('claude-code')!;
  const adapter = ADAPTERS[host.id];

  const incoming = adapter.read(payload);
  const moment = incoming.moment;

  // A moment the host cannot act on is not a silent pass — it is a hook that should never
  // have been registered, and `init` does not register it. Reaching here means the user
  // wired it by hand, so stay quiet rather than printing JSON the host will not read.
  if (!moment || host.moments[moment].event === null) {
    const verdict: Verdict = { moment: moment ?? 'prompt', risks: [], action: 'note' };
    return { host, verdict, incoming, code: 0 };
  }

  const risks = risksFor(moment, incoming);
  const verdict: Verdict = { moment, risks, action: decide(moment, host, opts, risks) };
  if (risks.length === 0) return { host, verdict, incoming, code: 0 };

  const reply = adapter.reply(verdict, incoming);
  return { host, verdict, incoming, stdout: reply.stdout, stderr: reply.stderr, code: reply.code };
}

/**
 * The end of a turn: what the guard flagged while the agent worked, for the person. Pure —
 * `seen` is read by the caller — so the suite can pin the exact bytes. Prints nothing when
 * nothing was flagged: a summary on every quiet turn is noise the person learns to skip.
 */
export function endOfTurn(
  host: Host,
  seen: Seen[],
  level: GuardLevel,
): { stdout?: string; code: 0 } {
  const adapter = ADAPTERS[host.id];
  const text = summaryText(seen, level);
  if (!text || !adapter.summary || !host.summary) return { code: 0 };
  return { stdout: adapter.summary(text).stdout, code: 0 };
}

/**
 * The level in force: `--level` on the hook, else `guard.level` in the project's
 * `vibeward.json`, else `medium`. The flag wins because it is what the person wrote into
 * their own editor settings; the file is what the repository says, and a repository should
 * not be able to override a choice made outside it.
 */
export function resolveLevel(opts: GuardOptions, cwd: string | undefined): GuardLevel {
  if (opts.level) return opts.level;
  const fromFile = loadConfig(undefined, cwd).config.guard?.level;
  return isGuardLevel(fromFile) ? fromFile : DEFAULT_GUARD_LEVEL;
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
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
    const level = resolveLevel(opts, cwd);
    result = evaluate(payload, { ...opts, level });

    if (result.incoming.end) {
      const sessionId = result.incoming.sessionId ?? '';
      const end = endOfTurn(result.host, takeSeen(sessionId), level);
      if (end.stdout) process.stdout.write(end.stdout);
      process.exit(0);
    }
    // Only where the host will show the summary: elsewhere the file would never be read.
    if (result.host.summary && result.incoming.sessionId) {
      remember(result.incoming.sessionId, result.verdict);
    }
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
