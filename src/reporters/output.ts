import { writeFileSync, readFileSync, writeSync } from 'node:fs';
import { basename } from 'node:path';
import { buildReport } from './markdown.js';
import { toSarif } from './sarif.js';
import { analyzeSupabaseExport } from '../checks/supabase.js';
import type { RlsResult } from '../checks/supabase.js';
import type { StackFingerprint } from '../checks/web.js';
import type { Finding, SuppressedFinding } from '../core/types.js';
import { C, log, todayISO } from '../core/terminal.js';
import { VERSION, stalenessNotice } from '../core/version.js';

/** The output-related flags a scanner passes through to `finish`. */
export interface FinishOptions {
  date?: string;
  out?: string;
  json?: boolean;
  sarif?: string;
  /** Print the JSON payload on stdout instead of writing report files. */
  stdout?: boolean;
}

/** Website context that only the URL scanner produces. */
export interface FinishExtras {
  fingerprint?: StackFingerprint | null;
  consoleChecked?: boolean;
  suppressed?: SuppressedFinding[];
  notApplicable?: Map<string, string>;
  configPath?: string | null;
}

/** Bumped whenever the `--stdout` payload changes shape. Agents can rely on it. */
const SCHEMA_VERSION = 1;

/**
 * Writes every byte to stdout before returning, then the caller may exit.
 *
 * `process.stdout.write()` followed by `process.exit()` silently truncates at the pipe
 * buffer — 64 KB on macOS — because Node makes stdout non-blocking when it is a pipe and
 * exit does not drain it. A scan of a real site produces a far bigger payload than that,
 * and the agent on the other end would get invalid JSON together with a success exit code.
 * Looping on the raw fd is the only way to be sure the whole thing landed.
 */
function writeAllSync(text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buf.length) {
    try {
      written += writeSync(1, buf, written, buf.length - written);
    } catch (err) {
      // The reader has not caught up yet; retry the same chunk.
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      throw err;
    }
  }
}

/** Reads a --supabase JSON export and folds its findings in. */
export function loadSupabaseExport(file: string): Finding[] {
  try {
    return analyzeSupabaseExport(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    log(
      `${C.yellow}⚠ Could not read --supabase ${file}: ${err instanceof Error ? err.message : String(err)}${C.reset}`,
    );
    return [];
  }
}

/** Builds the report, writes outputs, prints the summary, and sets the exit code. */
export function finish(
  target: string,
  findings: Finding[],
  rls: RlsResult | null,
  scanned: string[],
  opts: FinishOptions,
  extras: FinishExtras = {},
): never {
  const dateISO = opts.date ?? todayISO();
  const { markdown, counts, webCounts, verdict } = buildReport({
    target,
    dateISO,
    findings,
    rls,
    scanned,
    fingerprint: extras.fingerprint,
    consoleChecked: extras.consoleChecked,
    suppressed: extras.suppressed,
    notApplicable: extras.notApplicable,
    configPath: extras.configPath,
  });

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'vibeward',
    version: VERSION,
    target,
    dateISO,
    verdict,
    counts,
    webCounts,
    fingerprint: extras.fingerprint ?? null,
    findings,
    // An agent reading this must see what was silenced, or it will "verify" a fix that was
    // never applied and report a site as clean because someone edited a config file.
    suppressed: (extras.suppressed ?? []).map((s) => ({
      id: s.finding.id,
      label: s.finding.label,
      severity: s.finding.severity,
      reason: s.reason,
    })),
    configPath: extras.configPath ?? null,
    rls,
  };

  // Machine mode: stdout carries the payload and nothing else. Report files are only
  // written when explicitly asked for, so an agent's working tree stays clean.
  if (opts.stdout) {
    writeAllSync(`${JSON.stringify(payload, null, 2)}\n`);
    if (opts.out) writeFileSync(opts.out, markdown, 'utf8');
    if (opts.sarif) writeFileSync(opts.sarif, toSarif(findings, VERSION), 'utf8');
    process.exit(counts.critical > 0 ? 2 : 0);
  }

  const outPath = opts.out ?? `informe-${basename(target).replace(/[^\w.-]/g, '_') || 'scan'}.md`;
  writeFileSync(outPath, markdown, 'utf8');
  if (opts.json) {
    writeFileSync(`${outPath.replace(/\.md$/, '')}.json`, JSON.stringify(payload, null, 2), 'utf8');
  }
  if (opts.sarif) writeFileSync(opts.sarif, toSarif(findings, VERSION), 'utf8');

  log(`\n${C.bold}── Summary ──${C.reset}`);
  const line = (c: string, label: string, n: number): void => {
    if (n > 0) log(`  ${c}${label}: ${n}${C.reset}`);
  };
  line(C.red, '🔴 Critical', counts.critical);
  line(C.yellow, '🟠 High', counts.high);
  line(C.yellow, '🟡 Medium', counts.medium);
  line(C.gray, '⚪ Low', counts.low);
  if (counts.critical + counts.high + counts.medium + counts.low === 0)
    log(`  ${C.green}No security findings in the automated scope.${C.reset}`);

  const webTotal = webCounts.critical + webCounts.high + webCounts.medium + webCounts.low;
  if (webTotal > 0) {
    log(`  ${C.cyan}🌐 Website quality: ${webTotal}${C.reset} ${C.dim}(does not gate)${C.reset}`);
  }
  if (extras.suppressed?.length) {
    log(`  ${C.yellow}⊘ Suppressed by config: ${extras.suppressed.length}${C.reset}`);
  }
  if (extras.fingerprint) {
    const { score, total } = extras.fingerprint;
    log(`  ${C.dim}Vibe-coded fingerprint: ${score}/${total}${C.reset}`);
  }

  const vColor = counts.critical > 0 ? C.red : counts.high > 0 ? C.yellow : C.green;
  log(`\n  ${vColor}${verdict}${C.reset}`);
  log(`\n${C.green}✓ Report:${C.reset} ${outPath}`);
  if (opts.json) log(`${C.green}✓ JSON:${C.reset}   ${outPath.replace(/\.md$/, '')}.json`);
  if (opts.sarif) log(`${C.green}✓ SARIF:${C.reset}  ${opts.sarif}`);

  const stale = stalenessNotice();
  if (stale) log(`\n${C.yellow}⚠${C.reset} ${C.dim}${stale}${C.reset}`);

  log(
    `\n${C.dim}vibeward.ai${C.reset}  ${C.yellow}★${C.reset} ${C.dim}found this useful? star it:${C.reset} ${C.cyan}https://github.com/JSiapoDEV/vibeward${C.reset}\n`,
  );

  process.exit(counts.critical > 0 ? 2 : 0);
}
