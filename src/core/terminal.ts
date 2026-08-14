// Terminal helpers shared by the CLI and the scanners: colors and small I/O utilities.
import { createInterface } from 'node:readline';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
const PLAIN: typeof ANSI = {
  reset: '',
  dim: '',
  bold: '',
  red: '',
  green: '',
  yellow: '',
  cyan: '',
  gray: '',
};

// `--stdout` reserves stdout for the JSON payload an agent parses, so every human-facing
// line moves to stderr. Read from argv once at load: there is a single CLI entry point,
// and the decision must be settled before the first line is ever printed.
const QUIET = process.argv.includes('--stdout');

export const C =
  QUIET || process.env.NO_COLOR !== undefined || !process.stdout.isTTY ? PLAIN : ANSI;

/** A human-facing line. Goes to stderr under `--stdout` so the JSON stays parseable. */
export function log(line = ''): void {
  (QUIET ? process.stderr : process.stdout).write(`${line}\n`);
}

/** Same, without a newline — for progress lines that get overwritten. */
export function write(chunk: string): void {
  (QUIET ? process.stderr : process.stdout).write(chunk);
}

export function normalizeUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

export function todayISO(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Yes/no prompt (accepts English "y" and Spanish "s"). */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^(y|s)/i.test(ans.trim()));
    });
  });
}

/** Reads all of stdin (used by the guard hook). Resolves empty on a TTY. */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}
