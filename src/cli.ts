#!/usr/bin/env node
// vibeward — security scanner for AI-generated / vibe-coded apps.
//
// AUTHORIZED USE ONLY. Run this only against applications whose owner hired or
// authorized you to audit them. It is read-only by default (no writes, no deletes,
// no data exfiltration); the optional --write-test performs a non-mutating write
// probe and must only be used with explicit authorization.

import { parseArgs } from './core/args.js';
import { VERSION } from './core/version.js';
import { C } from './core/terminal.js';
import { runUrlScan } from './scanners/url.js';
import { runFolderScan } from './scanners/folder.js';
import { runGuard } from './scanners/guard.js';
import { SUPABASE_AUDIT_SQL } from './checks/supabase.js';

function usage(): void {
  console.log(`${C.bold}vibeward${C.reset} v${VERSION} — security scanner for AI-generated apps\n`);
  console.log(`Usage:`);
  console.log(
    `  vibeward <url> [--passive] [--write-test] [--sarif f] [--json] [--yes]  black-box URL scan`,
  );
  console.log(
    `${C.dim}      --passive: read only public assets (bundles/headers), no data probing${C.reset}`,
  );
  console.log(
    `  vibeward scan <folder> [--supabase export.json] [--sarif f]            white-box code scan`,
  );
  console.log(
    `  vibeward supabase-sql                                                  print the read-only audit query`,
  );
  console.log(
    `  vibeward guard [--warn]                                                hook: gate risky prompts (reads stdin)\n`,
  );
  console.log(`${C.dim}Example:  vibeward https://client-app.lovable.app --yes${C.reset}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === 'supabase-sql') {
    console.log(SUPABASE_AUDIT_SQL);
    process.exit(0);
  }
  if (cmd === 'guard') {
    await runGuard(argv.includes('--warn'));
  }
  if (cmd === 'scan') {
    const args = parseArgs(argv.slice(1));
    if (!args.target) {
      console.log(`${C.red}scan needs a folder path: vibeward scan ./my-app${C.reset}`);
      process.exit(1);
    }
    runFolderScan(args.target, args);
  }

  const args = parseArgs(argv);
  if (!args.target) {
    usage();
    process.exit(1);
  }
  await runUrlScan(args.target, args);
}

main().catch((err: unknown) => {
  console.error(`\n${C.red}Error:${C.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
