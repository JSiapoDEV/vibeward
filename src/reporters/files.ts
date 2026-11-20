// Where report files go, and how they stay out of git.
//
// A report names where an app is exposed: the file and line of a key, the tables anyone can
// read, the columns that hold personal data. Written to the working directory — which is the
// repository, nearly always — it showed up as an untracked file, one `git add .` away from
// being committed, and on a public repository that is a map for whoever reads it next.
//
// So the default is `.vibeward/reports/`, and `.vibeward/` carries its own `.gitignore` that
// ignores everything in it — the same trick pytest and ruff use for their caches. Nothing in
// the user's own `.gitignore` is touched, and it works the same whether or not the folder is a
// repository yet. An explicit `--out` is respected, and checked: if git would pick the file
// up, the person is told before they find out from a commit.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Relative to the working directory. */
export const REPORT_DIR = join('.vibeward', 'reports');

const IGNORE_EVERYTHING = [
  '# Written by vibeward. Reports name where your app is exposed: never commit them.',
  '*',
  '',
].join('\n');

/** The default path for a report file named `name`, relative to the working directory. */
export function defaultReportPath(name: string): string {
  return join(REPORT_DIR, name);
}

/** If `path` sits inside a `.vibeward` folder, make sure that folder ignores itself. */
function ignoreOwnFolder(path: string): void {
  const parts = resolve(path).split(sep);
  const at = parts.lastIndexOf('.vibeward');
  if (at < 0) return;
  const folder = parts.slice(0, at + 1).join(sep) || sep;
  const file = join(folder, '.gitignore');
  if (!existsSync(file)) writeFileSync(file, IGNORE_EVERYTHING, 'utf8');
}

/** Writes a report file, creating its folder and, under `.vibeward/`, the ignore file. */
export function writeReportFile(path: string, content: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  ignoreOwnFolder(path);
  writeFileSync(path, content, 'utf8');
}

/**
 * The written files git would offer to commit: inside a work tree and not ignored. Empty when
 * git is missing, when the folder is not a repository, and in CI — where the checkout is thrown
 * away and the files exist to be uploaded, not kept.
 */
export function unignoredInRepo(paths: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.CI || env.GITHUB_ACTIONS) return [];
  const out: string[] = [];
  for (const path of paths) {
    const abs = resolve(path);
    // `check-ignore` exits 0 when ignored, 1 when not, 128 outside a repository.
    const res = spawnSync('git', ['check-ignore', '-q', abs], {
      cwd: dirname(abs),
      stdio: 'ignore',
      timeout: 3000,
    });
    if (res.status === 1) out.push(relative(process.cwd(), abs) || abs);
  }
  return out;
}

/** The one-paragraph warning for those files, or null when there are none. */
export function unignoredWarning(paths: string[]): string | null {
  if (paths.length === 0) return null;
  return [
    `⚠ ${paths.join(', ')} ${paths.length === 1 ? 'is' : 'are'} inside a git repository and not ignored.`,
    '  A report names where your app is exposed. Delete it after reading, or add it to .gitignore.',
    `  Without --out, vibeward writes to ${REPORT_DIR}/, which git ignores on its own.`,
  ].join('\n');
}
