#!/usr/bin/env node
// vibeward — security scanner for AI-generated / vibe-coded apps and websites.
//
// AUTHORIZED USE ONLY. Run this only against applications whose owner hired or
// authorized you to audit them. Scanning is read-only by default (no writes, no deletes,
// no data exfiltration); the optional --write-test performs a non-mutating write
// probe and must only be used with explicit authorization. `init` is the one command
// that writes to disk, and only into your own project, after showing you what it will do.

import { parseArgs } from './core/args.js';
import { VERSION } from './core/version.js';
import { C, log } from './core/terminal.js';
import { runUrlScan } from './scanners/url.js';
import { runFolderScan } from './scanners/folder.js';
import { runGuard } from './scanners/guard.js';
import { SUPABASE_AUDIT_SQL } from './checks/supabase.js';

function usage(): void {
  log(
    `${C.bold}vibeward${C.reset} v${VERSION} — security & quality scanner for AI-generated sites\n`,
  );
  log(`Usage:`);
  log(
    `  vibeward <url> [--passive] [--write-test] [--sarif f] [--json] [--yes]  black-box URL scan`,
  );
  log(
    `${C.dim}      --passive: read only public assets (bundles/headers), no data probing${C.reset}`,
  );
  log(
    `${C.dim}      --stdout:  JSON payload on stdout, everything else on stderr (for agents/CI)${C.reset}`,
  );
  log(`${C.dim}      --no-web:  skip the website quality / AI-visibility checks${C.reset}`);
  log(
    `${C.dim}      --config:  a vibeward.json (default: beside the target, then the cwd)${C.reset}`,
  );
  log(
    `  vibeward scan <folder> [--supabase export.json] [--sarif f]            white-box code scan`,
  );
  log(
    `  vibeward init [--scope project|user] [--targets a,b] [--all] [--yes]   install the agent skill`,
  );
  log(
    `  vibeward supabase-sql                                                  print the read-only audit query`,
  );
  log(
    `  vibeward guard [--block]                                               hook: gate risky prompts (reads stdin)`,
  );
  log(
    `${C.dim}      default: warns the agent in-context (exit 0); --block erases the prompt (exit 2)${C.reset}\n`,
  );
  log(`${C.dim}Example:  vibeward https://client-app.lovable.app --yes${C.reset}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === '--version' || cmd === '-v') {
    log(VERSION);
    process.exit(0);
  }
  if (cmd === 'supabase-sql') {
    process.stdout.write(`${SUPABASE_AUDIT_SQL}\n`);
    process.exit(0);
  }
  if (cmd === 'guard') {
    // Default is context injection, not blocking: see the note on GuardMode. `--warn` is
    // kept as an alias so settings.json files written by older versions keep working.
    await runGuard(argv.includes('--block') ? 'block' : 'context');
  }
  if (cmd === 'init') {
    // Loaded on demand: the installer carries every template as a string, and a plain
    // scan has no reason to parse any of it.
    const { runInit } = await import('./init/run.js');
    const args = parseArgs(argv.slice(1));
    await runInit({ scope: args.scope, targets: args.targets, all: args.all, yes: args.yes });
  }
  if (cmd === 'scan') {
    const args = parseArgs(argv.slice(1));
    if (!args.target) {
      log(`${C.red}scan needs a folder path: vibeward scan ./my-app${C.reset}`);
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
