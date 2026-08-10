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
  json?: boolean;
  sarif?: string;
  yes?: boolean;
  out?: string;
  date?: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--no-rls') args.noRls = true;
    else if (a === '--passive') args.passive = true;
    else if (a === '--write-test') args.writeTest = true;
    else if (a === '--json') args.json = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--supabase-url') args.supabaseUrl = argv[++i];
    else if (a === '--anon-key') args.anonKey = argv[++i];
    else if (a === '--supabase') args.supabaseJson = argv[++i];
    else if (a === '--sarif') args.sarif = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (!a.startsWith('--') && !args.target) args.target = a;
  }
  return args;
}
