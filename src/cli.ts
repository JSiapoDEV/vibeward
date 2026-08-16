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
import { runGuard } from './guard/run.js';
import { findHost } from './init/capabilities.js';
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
    `  vibeward init [--scope project|user] [--targets a,b] [--moments a,b]   install the skill + guard`,
  );
  log(
    `${C.dim}      --targets: ${'claude-code, codex, cursor, copilot, gemini, windsurf, opencode,'}${C.reset}`,
  );
  log(`${C.dim}                 claude-md, agents-md, gh-action${C.reset}`);
  log(`${C.dim}      --moments: prompt, action, content${C.reset}`);
  log(
    `  vibeward supabase-sql                                                  print the read-only audit query`,
  );
  log(
    `  vibeward guard [--host h] [--block]                                    hook: gate risk (reads stdin)`,
  );
  log(
    `${C.dim}      the host and the moment come from the payload; --host only for hosts that send neither${C.reset}`,
  );
  log(
    `${C.dim}      default: warns the agent in-context (exit 0); --block stops a risky prompt instead${C.reset}\n`,
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
    // Host and moment both come from the payload on stdin, so a settings file needs no
    // arguments and cannot be wrong about its own event. `--host` exists for the one host
    // that sends nothing identifying, and `--block` escalates prompt matches for anyone who
    // wants a hard stop — off by default, because a blocked prompt is a lost paragraph.
    const flag = argv.indexOf('--host');
    const named = flag >= 0 ? (argv[flag + 1] ?? '') : '';
    await runGuard({
      host: findHost(named)?.id,
      block: argv.includes('--block'),
    });
  }
  if (cmd === 'init') {
    // Loaded on demand: the installer carries every template as a string, and a plain
    // scan has no reason to parse any of it.
    const { runInit } = await import('./init/run.js');
    const args = parseArgs(argv.slice(1));
    await runInit({
      scope: args.scope,
      targets: args.targets,
      moments: args.moments,
      all: args.all,
      yes: args.yes,
    });
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
