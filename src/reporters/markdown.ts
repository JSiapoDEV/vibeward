import { isWeb } from '../core/types.js';
import type { Finding, Severity, SuppressedFinding } from '../core/types.js';
import { coverage, coverageText } from '../core/i18n.js';
import type { CoverageLine, Lang } from '../core/i18n.js';
import type { CoverageEntry } from '../core/coverage.js';
import { VERSION } from '../core/version.js';
import { REPORT } from './strings.js';
import type { RlsResult } from '../checks/supabase.js';
import type { StackFingerprint } from '../checks/web.js';
import { WEB_CHECKS } from '../checks/web.js';

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export type SeverityCounts = Record<Severity, number>;

export interface ReportInput {
  target: string;
  dateISO: string;
  /** Findings already localized — `finish` translates once, for every output format. */
  findings: Finding[];
  rls: RlsResult | null;
  scanned: CoverageEntry[];
  /** Which language the report prose is written in. */
  lang: Lang;
  /** False in `--passive`, where nothing beyond public assets was requested. */
  active?: boolean;
  fingerprint?: StackFingerprint | null;
  /** Whether a real browser inspected the console (Playwright present). */
  consoleChecked?: boolean;
  /** Website findings silenced by vibeward.json. Listed, never dropped. */
  suppressed?: SuppressedFinding[];
  /** Checks that do not apply to this site, with the reason from the config. */
  notApplicable?: Map<string, CoverageLine>;
  /** Checks this scan had no input to evaluate, with the reason vibeward measured. */
  notEvaluated?: Map<string, CoverageLine>;
  /** Where the config came from, printed so a reader can go and check it. */
  configPath?: string | null;
}

export interface ReportOutput {
  markdown: string;
  /** Security only — the counts that drive the verdict and the exit code. */
  counts: SeverityCounts;
  /** Website quality only — reported apart, never gating. */
  webCounts: SeverityCounts;
  verdict: string;
  totalCrit: number;
  /**
   * Per-check state of the website pass, computed once and handed to whoever needs it.
   *
   * The report table and the JSON payload used to be free to disagree about whether a check
   * passed, because each worked it out for itself and only the table was ever read by a
   * person. Returning it from the one place that derives it makes them the same answer by
   * construction rather than by review.
   */
  webCoverage: CoverageEntry[];
}

function tally(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** Checks that need a real browser, so they cannot be claimed as passing without one. */
const NEEDS_BROWSER = new Set(['web_console_errors']);

/**
 * Why a website check produced no verdict, or `null` when it genuinely ran.
 *
 * Three states the report must never blur: "we had nothing to measure" is not "ok", "it does
 * not apply here" is not "we checked", and a check that ran and failed still *ran*. A check
 * silenced by config is absent from this map on purpose — it was evaluated, it failed, and
 * hiding it is what the `suppressed` list exists to disclose. Folding it in here would let a
 * config file convert a failure into "not evaluated", which is the one edit that would make
 * the coverage record lie.
 */
function webCheckSkip(
  id: string,
  consoleChecked: boolean | undefined,
  notApplicable: Map<string, CoverageLine>,
  notEvaluated: Map<string, CoverageLine>,
): { status: CoverageEntry['status']; detail: CoverageLine } | null {
  if (consoleChecked === false && NEEDS_BROWSER.has(id)) {
    return { status: 'not_evaluated', detail: coverage(REPORT.en.noBrowser, REPORT.es.noBrowser) };
  }
  const blind = notEvaluated.get(id);
  if (blind) return { status: 'not_evaluated', detail: blind };
  const declared = notApplicable.get(id);
  if (declared) return { status: 'not_applicable', detail: declared };
  return null;
}

/**
 * One coverage row per website check, from the same derivation the report table renders.
 *
 * Exported so `finish` can put it in the JSON payload without re-deriving it. The website
 * checks are the one family where the ledger is per check rather than per area, because they
 * are the one family that skips per check: a crawl that reached a single page cannot judge
 * duplicate titles, and a page with no images cannot be missing alt text.
 */
export function webCheckCoverage(
  consoleChecked: boolean | undefined,
  notApplicable: Map<string, CoverageLine>,
  notEvaluated: Map<string, CoverageLine>,
): CoverageEntry[] {
  return WEB_CHECKS.map((c) => {
    const skipped = webCheckSkip(c.id, consoleChecked, notApplicable, notEvaluated);
    return skipped
      ? { id: c.id, status: skipped.status, detail: skipped.detail }
      : { id: c.id, status: 'checked' as const, detail: coverage(c.label, c.es) };
  });
}

/**
 * The config's file name, never its path. The report is handed to a client: the auditor's
 * directory layout is not part of the deliverable.
 */
function configName(path: string | null | undefined): string {
  return path ? (path.split(/[\\/]/).pop() ?? 'vibeward.json') : 'vibeward.json';
}

/** The website section: its own scale, its own table, and no effect on the verdict. */
function webSection(
  web: Finding[],
  lang: Lang,
  fingerprint: StackFingerprint | null | undefined,
  consoleChecked: boolean | undefined,
  suppressed: SuppressedFinding[],
  notApplicable: Map<string, CoverageLine>,
  notEvaluated: Map<string, CoverageLine>,
  configPath: string | null | undefined,
): string {
  const t = REPORT[lang];
  const found = new Map(web.map((f) => [f.id, f]));
  const silenced = new Map(suppressed.map((s) => [s.finding.id, s]));

  // "You told us to ignore it" is a fourth state, handled below against `silenced` — it is
  // not a coverage state, because a suppressed check ran and failed.
  const skip = (id: string): { status: string; reason: string } | null => {
    const s = webCheckSkip(id, consoleChecked, notApplicable, notEvaluated);
    if (!s) return null;
    const status = s.status === 'not_evaluated' ? t.statusNotEvaluated : t.statusNotApplicable;
    return { status, reason: coverageText(s.detail, lang) };
  };

  const passed = WEB_CHECKS.filter(
    (c) => !found.has(c.id) && !silenced.has(c.id) && skip(c.id) === null,
  );
  const labelOf = (c: (typeof WEB_CHECKS)[number]): string => (lang === 'es' ? c.es : c.label);

  let md = `## ${t.webTitle}\n\n`;
  md += `${t.webBlurb}\n\n`;

  if (fingerprint) {
    md += t.fingerprint(fingerprint.score, fingerprint.total);
    if (fingerprint.signals.length) md += ` — ${fingerprint.signals.join(' · ')}`;
    md += `\n\n`;
    const stack = [fingerprint.framework, fingerprint.platformDomain]
      .filter(Boolean)
      .join(t.stackOn);
    if (stack) md += `**${t.stackDetected}:** ${stack}\n\n`;
  }

  const checkable = WEB_CHECKS.filter((c) => skip(c.id) === null && !silenced.has(c.id));
  md += t.checksPassed(passed.length, checkable.length);
  if (suppressed.length > 0) md += t.suppressedInline(suppressed.length, configName(configPath));
  md += `\n\n`;
  // No "Fixable by" column: it existed to tell an agent how far it could go on its own, and
  // vibeward no longer has an opinion on that because it no longer fixes anything.
  md += `${t.webTableHead}\n`;
  for (const c of WEB_CHECKS) {
    const skipped = skip(c.id);
    if (skipped) {
      md += `| ${labelOf(c)} | ${skipped.status} | — | ${skipped.reason} |\n`;
      continue;
    }
    const hidden = silenced.get(c.id);
    if (hidden) {
      md += `| ${labelOf(c)} | ${t.statusSuppressed} | ${t.webSev[hidden.finding.severity]} | ${hidden.reason} |\n`;
      continue;
    }
    const f = found.get(c.id);
    if (!f) {
      md += `| ${labelOf(c)} | ${t.statusOk} | — | — |\n`;
      continue;
    }
    md += `| ${labelOf(c)} | ${t.statusFail} | ${t.webSev[f.severity]} | — |\n`;
  }
  md += `\n`;

  if (suppressed.length > 0) {
    md += `### ${t.suppressedTitle(suppressed.length)}\n\n`;
    md += `${t.suppressedBlurb(configName(configPath))}\n\n`;
    md += `${t.suppressedTableHead}\n`;
    for (const s of suppressed) {
      md += `| ${s.finding.label} | ${t.webSev[s.finding.severity]} | ${s.reason} |\n`;
    }
    md += `\n`;
  }

  if (web.length) {
    const sorted = [...web].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    md += `### ${t.webFindingsTitle}\n\n`;
    sorted.forEach((f, i) => {
      md += `#### ${i + 1}. ${t.webSev[f.severity]} — ${f.label}\n\n`;
      if (f.evidence) md += `**${t.fEvidence}:** ${f.evidence}\n\n`;
      if (f.impact) md += `**${t.fImpact}:** ${f.impact}\n\n`;
      md += `**${t.fWhy}:** ${f.why}\n\n`;
      if (f.meta?.pages?.length) {
        const shown = f.meta.pages.slice(0, 8);
        md += `**${t.fPages}:** ${shown.map((p) => `\`${p}\``).join(', ')}`;
        md +=
          f.meta.pages.length > shown.length
            ? ` (+${f.meta.pages.length - shown.length})\n\n`
            : `\n\n`;
      }
      if (f.references?.length) {
        md += `**${t.fReferences}:** ${f.references.map((r) => `<${r}>`).join(' · ')}\n\n`;
      }
    });
  }

  return md;
}

export function buildReport({
  target,
  dateISO,
  findings,
  rls,
  scanned,
  lang,
  active = true,
  fingerprint,
  consoleChecked,
  suppressed = [],
  notApplicable = new Map(),
  notEvaluated = new Map(),
  configPath,
}: ReportInput): ReportOutput {
  const t = REPORT[lang];
  const security = findings.filter((f) => !isWeb(f));
  const web = findings.filter(isWeb);
  const sorted = [...security].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  const counts = tally(security);
  const webCounts = tally(web);

  const totalCrit = counts.critical + counts.high;
  const verdict =
    counts.critical > 0
      ? t.verdict.critical
      : counts.high > 0
        ? t.verdict.high
        : counts.medium > 0
          ? t.verdict.medium
          : t.verdict.clean;

  const hasWeb = web.length > 0 || suppressed.length > 0 || Boolean(fingerprint);

  let md = '';
  md += `# ${t.title(hasWeb)}\n\n`;
  md += `**${t.application}:** ${target}\n\n`;
  md += `**${t.date}:** ${dateISO}\n\n`;
  md += `**${lang === 'es' ? 'Alcance' : 'Scope'}:** ${t.scope(hasWeb, active)}\n\n`;
  md += `---\n\n`;

  md += `## ${t.executiveSummary}\n\n`;
  md += `> **${verdict}**\n\n`;
  md += `${t.severityTableHead}\n`;
  md += `| ${t.sev.critical} | ${counts.critical} |\n`;
  md += `| ${t.sev.high} | ${counts.high} |\n`;
  md += `| ${t.sev.medium} | ${counts.medium} |\n`;
  md += `| ${t.sev.low} | ${counts.low} |\n\n`;

  if (counts.critical > 0) md += `${t.criticalCallout(counts.critical)}\n\n`;
  if (hasWeb) md += `${t.webAside(web.length)}\n\n`;

  // Right next to the verdict, never buried: a reader has to know the scope was narrowed
  // before they read what the scan concluded.
  if (suppressed.length > 0) {
    md += `${t.suppressionBanner(suppressed.length, configName(configPath))}\n\n`;
  }

  if (rls) {
    md += `## ${t.dbTitle}\n\n`;
    const how = rls.enumerated > 0 ? t.dbHowEnumerated(rls.enumerated) : t.dbHowCommon(rls.probed);
    if (rls.exposedCount > 0) {
      md += `${t.dbExposedIntro(how, rls.exposedCount)}\n\n`;
      md += `${t.dbTableHead}\n`;
      for (const table of rls.exposed) {
        const pii = table.leakedColumns?.length ? `⚠️ ${table.leakedColumns.join(', ')}` : '—';
        const w =
          table.write === 'writable' ? t.dbWriteYes : table.write === 'blocked' ? t.dbWriteNo : '—';
        md += `| \`${table.table}\` | ${table.rowsTotal ?? '?'} | ${pii} | ${w} |\n`;
      }
      md += `\n`;
      if (rls.piiTables.length) md += `${t.dbPiiNote(rls.piiTables.length)}\n\n`;
      if (rls.writable.length) md += `${t.dbWritableNote(rls.writable.length)}\n\n`;
      // Addressed to the owner, not to an agent. This is an exposure that has already
      // happened, so closing the hole is only half of it — whatever was reachable was
      // reachable to everyone, for as long as it has been live.
      md += `${t.dbHowToClose}\n\n`;
    } else if (rls.probed) {
      md += `${t.dbNoneExposed(how)}\n\n`;
    }
    md += `---\n\n`;
  }

  md += `## ${t.detailedFindings}\n\n`;
  if (sorted.length === 0) {
    md += `${t.noFindings}\n\n`;
  } else {
    sorted.forEach((f, i) => {
      md += `### ${i + 1}. ${t.sevHeading[f.severity]} — ${f.label}\n\n`;
      if (f.cwe) md += `**${t.fClassification}:** ${f.cwe}\n\n`;
      if (f.source) md += `**${t.fWhere}:** ${f.source}\n\n`;
      if (f.evidence) md += `**${t.fEvidence}:** ${f.evidence}\n\n`;
      if (f.exploit) md += `**${t.fExploit}:** ${f.exploit}\n\n`;
      if (f.impact) md += `**${t.fImpact}:** ${f.impact}\n\n`;
      md += `**${t.fWhy}:** ${f.why}\n\n`;
      if (f.references?.length) {
        md += `**${t.fReferences}:** ${f.references.map((r) => `<${r}>`).join(' · ')}\n\n`;
      }
      if (f.check) md += `${t.fChecklist(f.check)}\n\n\n`;
    });
  }

  if (hasWeb) {
    md += `---\n\n`;
    md += webSection(
      web,
      lang,
      fingerprint,
      consoleChecked,
      suppressed,
      notApplicable,
      notEvaluated,
      configPath,
    );
  }

  md += `---\n\n`;
  md += `## ${t.coverageTitle}\n\n`;
  md += `${t.coverageBlurb}\n\n`;
  md += `### ${t.verifiedAutomatically}\n`;
  const verified = scanned.filter((e) => e.status === 'checked');
  if (verified.length === 0) md += `${t.nothingVerified}\n`;
  for (const e of verified) md += `- ${coverageText(e.detail, lang)}\n`;

  // The gaps, under their own heading rather than mixed into the list above. They used to be
  // pushed into the same array and printed under "Verified automatically", so a declined
  // backend probe was rendered as something the scan had verified — the precise inversion
  // this section exists to prevent.
  const gaps = scanned.filter((e) => e.status !== 'checked');
  if (gaps.length > 0) {
    md += `\n### ${t.notVerifiedTitle}\n\n`;
    md += `${t.notVerifiedBlurb}\n\n`;
    // One prompt gates two areas, so declining it produces two rows carrying the same
    // sentence. They stay separate in the payload, where the ids are what an agent reads;
    // printing the sentence twice to a person just looks like a bug.
    const seen = new Set<string>();
    for (const e of gaps) {
      const text = coverageText(e.detail, lang);
      if (seen.has(text)) continue;
      seen.add(text);
      const mark = e.status === 'not_evaluated' ? t.statusNotEvaluated : t.statusNotApplicable;
      md += `- ${mark} — ${text}\n`;
    }
  }
  if (hasWeb && consoleChecked === false) md += `\n${t.playwrightNote}\n`;

  md += `\n---\n\n## ${t.nextStepsTitle}\n\n`;
  md += `${counts.critical > 0 ? t.nextStepsCritical : t.nextStepsNormal}\n\n`;
  if (hasWeb && web.length > 0) md += `${t.initHint}\n\n`;

  md += `---\n\n`;
  // No claim about who authorized this. vibeward is not in a position to certify the
  // operator's relationship to the site, and a report that asserts it on their behalf is a
  // liability the moment it is forwarded to anyone.
  md += `${t.footer(VERSION)}\n`;

  return {
    markdown: md,
    counts,
    webCounts,
    verdict,
    totalCrit,
    webCoverage: hasWeb ? webCheckCoverage(consoleChecked, notApplicable, notEvaluated) : [],
  };
}
