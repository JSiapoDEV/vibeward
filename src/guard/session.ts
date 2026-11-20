// What the guard saw during one turn, so the person can read it when the turn ends.
//
// Every other part of the guard is stateless: one payload in, one answer out. The summary
// cannot be, because the person who needs it is the one who was NOT watching — they started
// the agent and walked away, and every note the guard sent went to the model, not to them.
// So each match is appended to a small file named after the session, and the end-of-turn hook
// reads it, prints it and deletes it.
//
// The file lives in the OS temp directory, never in the project: vibeward does not write into
// the repository it is guarding. The session id is hashed into the name, the directory is
// private to the user, and anything older than two days is swept, so an editor that never
// sends the end-of-turn event leaves nothing behind for long.
//
// Every function here swallows its own errors. A summary that cannot be written is a summary
// missed; a guard that throws on a full disk is a guard that jams the editor.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Severity } from '../core/types.js';
import type { Action, GuardLevel, Moment, Verdict } from './verdict.js';

/** One match, as the person will read it at the end of the turn. */
export interface Seen {
  moment: Moment;
  action: Action;
  id: string;
  risk: string;
  source?: string;
  severity?: Severity;
}

const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
/** Lines shown before "and N more". A summary longer than a screen is not read. */
const MAX_LINES = 8;

function storeDir(base = tmpdir()): string {
  return join(base, 'vibeward-guard');
}

function fileFor(sessionId: string, base?: string): string {
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return join(storeDir(base), `${name}.jsonl`);
}

/** Appends what this verdict found. Silent on any failure. */
export function remember(sessionId: string, verdict: Verdict, base?: string): void {
  if (!sessionId || verdict.risks.length === 0) return;
  try {
    mkdirSync(storeDir(base), { recursive: true, mode: 0o700 });
    const lines = verdict.risks.map((r) =>
      JSON.stringify({
        moment: verdict.moment,
        action: verdict.action,
        id: r.id,
        risk: r.risk,
        source: r.source,
        severity: r.severity,
      } satisfies Seen),
    );
    appendFileSync(fileFor(sessionId, base), `${lines.join('\n')}\n`, { mode: 0o600 });
  } catch {
    // A missed summary line, not a jammed editor.
  }
}

/** Reads and deletes what this session saw since the last summary, and sweeps stale files. */
export function takeSeen(sessionId: string, base?: string): Seen[] {
  const seen: Seen[] = [];
  if (sessionId) {
    const path = fileFor(sessionId, base);
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as Seen;
          if (typeof item.id === 'string' && typeof item.risk === 'string') seen.push(item);
        } catch {
          // One torn line — two hooks appending at once — costs that line, not the summary.
        }
      }
      rmSync(path, { force: true });
    } catch {
      // Nothing recorded this turn.
    }
  }
  sweep(base);
  return seen;
}

function sweep(base?: string): void {
  try {
    const dir = storeDir(base);
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > MAX_AGE_MS) rmSync(path, { force: true });
    }
  } catch {
    // Nothing to sweep.
  }
}

const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const OUTCOME: Record<Action, string> = {
  note: 'the agent was told',
  ask: 'you were asked',
  deny: 'refused',
};

/**
 * The person-facing summary, or null when there is nothing to say. Pure: the same matches
 * always produce the same text, which is what lets the suite pin it.
 *
 * Repeats are folded — an agent that retries the same migration five times produced one
 * problem, not five — and the worst come first, because the first line is the one read.
 */
export function summaryText(seen: Seen[], level: GuardLevel): string | null {
  if (seen.length === 0) return null;

  const folded = new Map<string, Seen & { times: number }>();
  for (const s of seen) {
    const key = `${s.id}\u0000${s.source ?? ''}`;
    const prior = folded.get(key);
    if (!prior) {
      folded.set(key, { ...s, times: 1 });
      continue;
    }
    prior.times++;
    // Keep the strongest thing that happened: if it was asked once, say so.
    if (s.action === 'deny' || (s.action === 'ask' && prior.action === 'note')) {
      prior.action = s.action;
    }
  }

  const items = [...folded.values()].sort(
    (a, b) =>
      (RANK[a.severity ?? 'medium'] ?? 2) - (RANK[b.severity ?? 'medium'] ?? 2) ||
      a.risk.localeCompare(b.risk),
  );
  const critical = items.filter((i) => i.severity === 'critical').length;
  const count = items.length;

  const head = `vibeward flagged ${count} thing${count === 1 ? '' : 's'} while the agent worked${
    critical > 0 ? ` — ${critical} critical` : ''
  }:`;
  const lines = [head];
  for (const item of items.slice(0, MAX_LINES)) {
    const label =
      item.moment === 'content'
        ? 'injected'
        : (item.severity ?? (item.moment === 'prompt' ? 'prompt' : 'risk'));
    const where = item.source ? ` (${item.source})` : '';
    const times = item.times > 1 ? ` ×${item.times}` : '';
    lines.push(`  • ${label}: ${item.risk}${where}${times} — ${OUTCOME[item.action]}`);
  }
  if (items.length > MAX_LINES) lines.push(`  … and ${items.length - MAX_LINES} more`);
  lines.push(
    'Check that the agent acted on each one; `npx vibeward scan .` lists everything in the repo.',
  );
  lines.push(
    `Guard level: ${level} — set "guard": { "level": "warn" | "medium" | "high" } in vibeward.json.`,
  );
  return lines.join('\n');
}
