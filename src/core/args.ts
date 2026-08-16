import { isLang } from './i18n.js';
import type { Lang } from './i18n.js';

export interface Args {
  target?: string;
  supabaseUrl?: string;
  anonKey?: string;
  supabaseJson?: string;
  noRls?: boolean;
  /**
   * Passive mode: read only publicly-served assets (bundles, headers) — no active data
   * probing (RLS reads, GraphQL, Firebase, writes). Safe to run without the owner's
   * permission, the way a browser reads a page; it never accesses anyone's private data.
   */
  passive?: boolean;
  /** Opt-in: run a non-mutating write-authorization test on exposed tables. Off by default. */
  writeTest?: boolean;
  /** Skip the website quality/AI-visibility checks (they run by default). */
  noWeb?: boolean;
  /** Path to a `vibeward.json`. Defaults to the one beside the target, then the cwd. */
  config?: string;
  json?: boolean;
  /**
   * Machine mode: the JSON payload goes to stdout and every human-facing line to stderr,
   * so an agent or a CI step can parse the result. Implies `--yes` — there is nobody to
   * answer a prompt.
   */
  stdout?: boolean;
  sarif?: string;
  yes?: boolean;
  out?: string;
  date?: string;
  /**
   * Language of the report. Defaults to English. The CLI itself is not translated: whoever
   * typed the command reads English by definition, while the report goes to the site's owner.
   */
  lang?: Lang;
  /** `init` only: where to install. */
  scope?: 'project' | 'user';
  /** `init` only: which targets to write, bypassing the interactive picker. */
  targets?: string[];
  /** `init` only: which moments the guard should watch (`prompt`, `action`, `content`). */
  moments?: string[];
  /** `init` only: every target available for the chosen scope. */
  all?: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--no-rls') args.noRls = true;
    else if (a === '--passive') args.passive = true;
    else if (a === '--write-test') args.writeTest = true;
    else if (a === '--no-web') args.noWeb = true;
    else if (a === '--json') args.json = true;
    else if (a === '--stdout') args.stdout = true;
    else if (a === '--all') args.all = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--supabase-url') args.supabaseUrl = argv[++i];
    else if (a === '--anon-key') args.anonKey = argv[++i];
    else if (a === '--supabase') args.supabaseJson = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--sarif') args.sarif = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--lang') {
      const v = argv[++i]?.toLowerCase();
      // An unknown language falls through to the English default rather than failing the
      // scan: the report is the point, and its language is a preference.
      if (isLang(v)) args.lang = v;
    } else if (a === '--scope') {
      const v = argv[++i];
      if (v === 'project' || v === 'user') args.scope = v;
    } else if (a === '--targets' || a === '--moments') {
      const list = (argv[++i] ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (a === '--targets') args.targets = list;
      else args.moments = list;
    } else if (!a.startsWith('--') && !args.target) args.target = a;
  }
  // Nobody can answer a prompt when stdout is being piped into a parser.
  if (args.stdout) args.yes = true;
  return args;
}
