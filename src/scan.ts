#!/usr/bin/env node
// vibeward — security scanner for AI-generated / vibe-coded apps.
//
// AUTHORIZED USE ONLY. Run this only against applications whose owner hired or
// authorized you to audit them. It is read-only (no writes, no deletes, no data
// exfiltration), but scanning systems you do not own without permission may be illegal.

import { writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { fetchText, discoverScripts, discoverChunksFromBundle } from './lib/fetchers.js';
import { scanText, extractSupabaseConfig } from './lib/secrets.js';
import { probeRLS, analyzeSupabaseExport, SUPABASE_AUDIT_SQL } from './lib/supabase.js';
import { checkHeaders } from './lib/headers.js';
import { scanFolder } from './lib/folder.js';
import { analyzeMigrations } from './lib/migrations.js';
import { buildReport } from './lib/report.js';
import { toSarif } from './lib/sarif.js';
import { scanIntent } from './lib/intent.js';
import type { Finding, SupabaseConfig } from './lib/types.js';
import type { RlsResult } from './lib/supabase.js';

const VERSION = '0.1.0';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

interface Args {
  target?: string;
  supabaseUrl?: string;
  anonKey?: string;
  supabaseJson?: string;
  noRls?: boolean;
  json?: boolean;
  sarif?: string;
  yes?: boolean;
  out?: string;
  date?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--no-rls') args.noRls = true;
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

function normalizeUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^(y|s)/i.test(ans.trim()));
    });
  });
}

function todayISO(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function usage(): void {
  console.log(`${C.bold}vibeward${C.reset} v${VERSION} — security scanner for AI-generated apps\n`);
  console.log(`Usage:`);
  console.log(
    `  vibeward <url> [--no-rls] [--sarif f.sarif] [--json] [--yes]   black-box URL scan`,
  );
  console.log(
    `  vibeward scan <folder> [--supabase export.json] [--sarif f]   white-box code scan`,
  );
  console.log(
    `  vibeward supabase-sql                                         print the read-only audit query`,
  );
  console.log(
    `  vibeward guard [--warn]                                       hook: gate risky prompts (reads stdin)\n`,
  );
  console.log(`${C.dim}Example:  vibeward https://client-app.lovable.app --yes${C.reset}`);
}

/** Reads --supabase JSON and folds its findings in. */
function loadSupabaseExport(file: string): Finding[] {
  try {
    return analyzeSupabaseExport(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    console.log(
      `${C.yellow}⚠ Could not read --supabase ${file}: ${err instanceof Error ? err.message : String(err)}${C.reset}`,
    );
    return [];
  }
}

/** Builds the report, writes outputs, prints the summary, and sets the exit code. */
function finish(
  target: string,
  findings: Finding[],
  rls: RlsResult | null,
  scanned: string[],
  args: Args,
): never {
  const dateISO = args.date ?? todayISO();
  const { markdown, counts, verdict } = buildReport({ target, dateISO, findings, rls, scanned });

  const outPath = args.out ?? `informe-${basename(target).replace(/[^\w.-]/g, '_') || 'scan'}.md`;
  writeFileSync(outPath, markdown, 'utf8');
  if (args.json) {
    writeFileSync(
      `${outPath.replace(/\.md$/, '')}.json`,
      JSON.stringify({ target, dateISO, counts, findings, rls }, null, 2),
      'utf8',
    );
  }
  if (args.sarif) writeFileSync(args.sarif, toSarif(findings, VERSION), 'utf8');

  console.log(`\n${C.bold}── Summary ──${C.reset}`);
  const line = (c: string, label: string, n: number): void => {
    if (n > 0) console.log(`  ${c}${label}: ${n}${C.reset}`);
  };
  line(C.red, '🔴 Critical', counts.critical);
  line(C.yellow, '🟠 High', counts.high);
  line(C.yellow, '🟡 Medium', counts.medium);
  line(C.gray, '⚪ Low', counts.low);
  if (findings.length === 0)
    console.log(`  ${C.green}No findings in the automated scope.${C.reset}`);

  const vColor = counts.critical > 0 ? C.red : counts.high > 0 ? C.yellow : C.green;
  console.log(`\n  ${vColor}${verdict}${C.reset}`);
  console.log(`\n${C.green}✓ Report:${C.reset} ${outPath}`);
  if (args.json) console.log(`${C.green}✓ JSON:${C.reset}   ${outPath.replace(/\.md$/, '')}.json`);
  if (args.sarif) console.log(`${C.green}✓ SARIF:${C.reset}  ${args.sarif}`);

  console.log(
    `\n${C.dim}vibeward.ai${C.reset}  ${C.yellow}★${C.reset} ${C.dim}found this useful? star it:${C.reset} ${C.cyan}https://github.com/JSiapoDEV/vibeward${C.reset}\n`,
  );

  process.exit(counts.critical > 0 ? 2 : 0);
}

/** White-box: scan a local folder (code + Supabase migrations) plus an optional export. */
function runFolderScan(dir: string, args: Args): never {
  console.log(`${C.gray}▸ Scanning folder ${dir}…${C.reset}`);
  const { findings, filesScanned, migrations } = scanFolder(dir);
  console.log(
    `${C.gray}▸ ${filesScanned} file(s) scanned, ${migrations.length} SQL file(s) found${C.reset}`,
  );
  const scanned = [`Source files in ${dir} (secrets, committed .env)`];

  if (migrations.length) {
    findings.push(...analyzeMigrations(migrations));
    scanned.push(`Supabase/SQL migrations (RLS, permissive policies, SECURITY DEFINER)`);
  }
  if (args.supabaseJson) {
    findings.push(...loadSupabaseExport(args.supabaseJson));
    scanned.push('Live Supabase audit export (--supabase)');
  }

  finish(dir, findings, null, scanned, args);
}

/** Black-box: scan a live URL from the outside. */
async function runUrlScan(rawTarget: string, args: Args): Promise<never> {
  const target = normalizeUrl(rawTarget);

  console.log(`\n${C.yellow}${C.bold}⚠  AUTHORIZED USE ONLY${C.reset}`);
  console.log(`${C.dim}About to scan:${C.reset} ${C.cyan}${target}${C.reset}`);
  console.log(`${C.dim}Only do this if the owner authorized you to audit this app.${C.reset}\n`);
  if (!args.yes) {
    if (!(await confirm(`Do you confirm you have authorization? (y/n) `))) {
      console.log(`${C.red}Cancelled.${C.reset}`);
      process.exit(1);
    }
    console.log('');
  }

  const findings: Finding[] = [];
  const scanned: string[] = [];

  process.stdout.write(`${C.gray}▸ Fetching main page…${C.reset}`);
  const mainPage = await fetchText(target);
  if (!mainPage.ok) {
    console.log(
      `\n${C.red}Could not reach ${target} (status ${mainPage.status}${mainPage.error ? `: ${mainPage.error}` : ''}).${C.reset}`,
    );
    process.exit(1);
  }
  console.log(` ${C.green}ok${C.reset} (${mainPage.status})`);
  scanned.push('HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)');
  findings.push(...checkHeaders(mainPage.headers));

  const scriptUrls = discoverScripts(mainPage.body, mainPage.finalUrl ?? target);
  console.log(`${C.gray}▸ ${scriptUrls.length} script(s) found in the HTML${C.reset}`);
  findings.push(...scanText(mainPage.body, target));

  const scannedBundles = new Set<string>();
  const chunkQueue = [...scriptUrls];
  let supabaseCfg: SupabaseConfig | null = args.supabaseUrl
    ? { projectUrl: normalizeUrl(args.supabaseUrl), anonKey: args.anonKey ?? null }
    : null;

  const MAX_BUNDLES = 40;
  let count = 0;
  while (chunkQueue.length && count < MAX_BUNDLES) {
    const url = chunkQueue.shift()!;
    if (scannedBundles.has(url)) continue;
    scannedBundles.add(url);
    count++;

    process.stdout.write(`${C.gray}▸ [${count}] scanning ${url.slice(0, 70)}…${C.reset}\r`);
    const bundle = await fetchText(url);
    if (!bundle.ok || !bundle.body) continue;

    findings.push(...scanText(bundle.body, url));
    if (!supabaseCfg) supabaseCfg = extractSupabaseConfig(bundle.body);

    if (count < 12) {
      for (const m of discoverChunksFromBundle(bundle.body, url)) {
        if (!scannedBundles.has(m)) chunkQueue.push(m);
      }
    }
  }
  process.stdout.write(`${' '.repeat(90)}\r`);
  console.log(`${C.gray}▸ ${scannedBundles.size} bundle(s) scanned${C.reset}`);
  scanned.push(`Exposed secrets/credentials in ${scannedBundles.size} JavaScript bundle(s)`);

  let rls: RlsResult | null = null;
  if (!args.noRls && supabaseCfg?.projectUrl && supabaseCfg.anonKey) {
    console.log(`${C.gray}▸ Supabase detected: ${supabaseCfg.projectUrl}${C.reset}`);
    process.stdout.write(`${C.gray}▸ Probing Row Level Security…${C.reset}`);
    rls = await probeRLS(supabaseCfg.projectUrl, supabaseCfg.anonKey);
    console.log(` ${C.green}done${C.reset}`);
    scanned.push(`Supabase Row Level Security (${rls.probed} common tables probed)`);

    for (const t of rls.exposed) {
      const hasPII = (t.leakedColumns?.length ?? 0) > 0;
      const rows = t.rowsTotal ?? undefined;
      const cols = hasPII ? t.leakedColumns!.join(', ') : '';
      findings.push({
        id: `rls_exposed_${t.table}`,
        label: `Table '${t.table}' readable without authentication${hasPII ? ' (contains personal data)' : ''}`,
        severity: hasPII ? 'critical' : 'high',
        check: 6,
        cwe: 'CWE-863',
        source: `${supabaseCfg.projectUrl}/rest/v1/${t.table}`,
        evidence: `${rows ?? '?'} rows readable with only the public anon key${hasPII ? `; sensitive columns: ${cols}` : ''}`,
        exploit: `Any visitor sends \`GET /rest/v1/${t.table}?select=*\` with the anon key (visible in the JS bundle) and every row comes back — no login required.`,
        impact: hasPII
          ? `~${rows ?? 'all'} records including ${cols} are readable by anyone on the internet right now. Active personal-data leak (GDPR / consumer-protection exposure).`
          : `~${rows ?? 'all'} rows are readable by anyone with the public key.`,
        why: hasPII
          ? 'A table with personal data is world-readable. This is a live breach, not a theoretical risk: RLS is missing or misconfigured.'
          : 'The table is readable by any visitor. RLS must be enabled and restricted to each row owner.',
        references: [
          'https://supabase.com/docs/guides/database/postgres/row-level-security',
          'https://cwe.mitre.org/data/definitions/863.html',
          'https://nvd.nist.gov/vuln/detail/CVE-2025-48757',
        ],
        meta: { table: t.table },
      });
    }
  } else if (!args.noRls) {
    console.log(`${C.gray}▸ No Supabase config (anon key) detected. Skipping RLS probe.${C.reset}`);
  }

  if (args.supabaseJson) {
    findings.push(...loadSupabaseExport(args.supabaseJson));
    scanned.push('Live Supabase audit export (--supabase)');
  }

  finish(target, findings, rls, scanned, args);
}

function readStdin(): Promise<string> {
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

/** Claude Code / Cursor hook: gate a risky user request before the agent acts on it. */
async function runGuard(warnOnly: boolean): Promise<never> {
  const raw = await readStdin();
  let prompt = raw;
  try {
    const parsed = JSON.parse(raw) as { prompt?: string };
    if (typeof parsed.prompt === 'string') prompt = parsed.prompt;
  } catch {
    // treat stdin as a raw prompt
  }

  const risks = scanIntent(prompt);
  if (risks.length === 0) process.exit(0);

  const lines = [`${C.yellow}${C.bold}⚠  vibeward blocked a risky request${C.reset}`, ''];
  for (const r of risks) {
    lines.push(`${C.red}✗ ${r.risk}${C.reset}`);
    lines.push(`  ${C.dim}why:${C.reset} ${r.why}`);
    lines.push(`  ${C.green}do this instead:${C.reset} ${r.instead}`);
    lines.push('');
  }
  const msg = lines.join('\n');

  if (warnOnly) {
    console.log(msg);
    process.exit(0);
  }
  // exit 2 blocks the prompt in a Claude Code UserPromptSubmit hook (stderr is shown)
  console.error(msg);
  process.exit(2);
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
