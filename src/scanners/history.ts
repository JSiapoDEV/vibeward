// `vibeward scan <folder> --history` — keys that were deleted but are still in git.
//
// Deleting the line does not un-leak the key: the commit that added it is still in the
// repository, on every clone and every fork, and on a public repository it is one
// `git log -p` away. The folder scan reads the tree as it is now, so it could never see that.
// This reads what every branch and tag ever ADDED — only added lines, so a removal is not
// mistaken for a leak — through the same rules, and reports the keys the current tree no
// longer holds, with the commit that introduced them.
//
// Read-only: one `git log` and nothing else. The generic `api_key = "…"` rule is left out on
// purpose — over years of history it matches every config shuffle — and so are findings that
// are low by design, like a Firebase web key: in history it says nothing a current scan would
// not.

import { spawnSync } from 'node:child_process';
import { scanSource } from '../checks/secrets.js';
import type { Finding } from '../core/types.js';

/** Commits read before stopping. The coverage line says when there were more. */
export const HISTORY_MAX_COMMITS = 1000;

/** Files whose diffs are noise and size, never a place a key is typed. */
const SKIP_PATHS = [
  ':(exclude)*.lock',
  ':(exclude)package-lock.json',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)yarn.lock',
  ':(exclude)*.min.js',
  ':(exclude)*.map',
];

export interface HistoryScan {
  findings: Finding[];
  /** Commits read. */
  commits: number;
  /** More commits existed than were read. */
  capped: boolean;
  /** A shallow clone: most of the history is not on this machine. */
  shallow: boolean;
}

interface Hunk {
  sha: string;
  date: string;
  path: string;
  added: string[];
}

/** Parses `git log -p -U0` output into the lines each commit added, per file. */
export function parseLog(log: string): { hunks: Hunk[]; commits: number } {
  const hunks: Hunk[] = [];
  let commits = 0;
  let sha = '';
  let date = '';
  let current: Hunk | null = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('\u0001')) {
      [sha = '', date = ''] = line.slice(1).split(' ');
      commits++;
      current = null;
    } else if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '');
      current = path === '/dev/null' ? null : { sha, date, path, added: [] };
      if (current) hunks.push(current);
    } else if (current && line.startsWith('+')) {
      current.added.push(line.slice(1));
    }
  }
  return { hunks, commits };
}

/** Findings for keys added in the history, earliest commit first, one per key. */
export function historyFindings(hunks: Hunk[]): Finding[] {
  // `git log` lists the newest commit first, so walking it backwards meets each key at the
  // commit that introduced it.
  const first = new Map<string, { finding: Finding; sha: string }>();
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i]!;
    if (hunk.added.length === 0) continue;
    for (const f of scanSource(hunk.added.join('\n'), hunk.path)) {
      if (f.id === 'generic_secret_assign' || f.severity === 'low') continue;
      const key = `${f.id}\u0000${f.evidence ?? ''}`;
      if (first.has(key)) continue;
      first.set(key, {
        sha: hunk.sha,
        finding: {
          ...f,
          id: `git_history_${f.id}`,
          label: `${f.label} — in the git history`,
          source: `${hunk.path} @ ${hunk.sha.slice(0, 7)} (${hunk.date})`,
          exploit:
            'The line was deleted, but the commit that added it is still in the repository: anyone with a clone, a fork or an old copy can read the key with `git log -p`.',
          why: 'Rotate the key at the provider — that is the fix. Rewriting the history (git filter-repo) only helps after the key is rotated, and it does not reach the clones and forks that already exist.',
          es: {
            ...f.es,
            label: `${f.es?.label ?? f.label} — en el historial de git`,
            exploit:
              'La línea se borró, pero el commit que la agregó sigue en el repositorio: quien tenga un clon, un fork o una copia vieja puede leer la clave con `git log -p`.',
            why: 'Rota la clave en el proveedor: ese es el arreglo. Reescribir el historial (git filter-repo) solo sirve después de rotarla, y no alcanza a los clones y forks que ya existen.',
          },
        },
      });
    }
  }
  return [...first.values()].map((v) => v.finding);
}

/** Runs the history scan, or returns null when `root` is not a git repository. */
export function scanHistory(root: string, maxCommits = HISTORY_MAX_COMMITS): HistoryScan | null {
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 512 * 1024 * 1024,
    });
  const inside = git('rev-parse', '--is-inside-work-tree');
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  const shallow = git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true';

  const log = git(
    'log',
    '--all',
    '-p',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--diff-filter=AM',
    '--date=short',
    '--format=%x01%H %ad',
    `--max-count=${maxCommits}`,
    '--',
    '.',
    ...SKIP_PATHS,
  );
  if (log.status !== 0) return null;
  const { hunks, commits } = parseLog(log.stdout);
  // Capped only when the limit was reached. Comparing with `rev-list --count` overstated it:
  // commits that touch nothing but a lockfile are skipped on purpose and never counted here.
  return { findings: historyFindings(hunks), commits, capped: commits >= maxCommits, shallow };
}

/**
 * The history findings worth adding to a scan of the current tree: keys the tree no longer
 * holds. A key still in the tree is already reported there, at its current place.
 */
export function onlyDeleted(history: Finding[], current: Finding[]): Finding[] {
  const now = new Set(current.map((f) => `${f.id}\u0000${(f.evidence ?? '').split(' — ')[0]}`));
  return history.filter(
    (f) =>
      !now.has(`${f.id.replace(/^git_history_/, '')}\u0000${(f.evidence ?? '').split(' — ')[0]}`),
  );
}
