import { writeFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildReport } from './markdown.js';
import { toSarif } from './sarif.js';
import { analyzeSupabaseExport } from '../checks/supabase.js';
import type { RlsResult } from '../checks/supabase.js';
import type { Finding } from '../core/types.js';
import { C, todayISO } from '../core/terminal.js';
import { VERSION } from '../core/version.js';

/** The output-related flags a scanner passes through to `finish`. */
export interface FinishOptions {
  date?: string;
  out?: string;
  json?: boolean;
  sarif?: string;
}

/** Reads a --supabase JSON export and folds its findings in. */
export function loadSupabaseExport(file: string): Finding[] {
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
export function finish(
  target: string,
  findings: Finding[],
  rls: RlsResult | null,
  scanned: string[],
  opts: FinishOptions,
): never {
  const dateISO = opts.date ?? todayISO();
  const { markdown, counts, verdict } = buildReport({ target, dateISO, findings, rls, scanned });

  const outPath = opts.out ?? `informe-${basename(target).replace(/[^\w.-]/g, '_') || 'scan'}.md`;
  writeFileSync(outPath, markdown, 'utf8');
  if (opts.json) {
    writeFileSync(
      `${outPath.replace(/\.md$/, '')}.json`,
      JSON.stringify({ target, dateISO, counts, findings, rls }, null, 2),
      'utf8',
    );
  }
  if (opts.sarif) writeFileSync(opts.sarif, toSarif(findings, VERSION), 'utf8');

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
  if (opts.json) console.log(`${C.green}✓ JSON:${C.reset}   ${outPath.replace(/\.md$/, '')}.json`);
  if (opts.sarif) console.log(`${C.green}✓ SARIF:${C.reset}  ${opts.sarif}`);

  console.log(
    `\n${C.dim}vibeward.ai${C.reset}  ${C.yellow}★${C.reset} ${C.dim}found this useful? star it:${C.reset} ${C.cyan}https://github.com/JSiapoDEV/vibeward${C.reset}\n`,
  );

  process.exit(counts.critical > 0 ? 2 : 0);
}
