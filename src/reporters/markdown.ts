import { isWeb } from '../core/types.js';
import type { Finding, Severity, SuppressedFinding } from '../core/types.js';
import { coverageText } from '../core/i18n.js';
import type { CoverageLine, Lang } from '../core/i18n.js';
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
  scanned: CoverageLine[];
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
}

function tally(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** Checks that need a real browser, so they cannot be claimed as passing without one. */
const NEEDS_BROWSER = new Set(['web_console_errors']);

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

  // Four states, and the report must never blur them: "we had nothing to measure" is not
  // "ok", "it does not apply here" is not "we checked", and "you told us to ignore it" is
  // not "it passed". Only the fourth is a pass.
  const skip = (id: string): { status: string; reason: string } | null => {
    if (consoleChecked === false && NEEDS_BROWSER.has(id)) {
      return { status: t.statusNotEvaluated, reason: t.noBrowser };
    }
    const blind = notEvaluated.get(id);
    if (blind) return { status: t.statusNotEvaluated, reason: coverageText(blind, lang) };
    const declared = notApplicable.get(id);
    if (declared) return { status: t.statusNotApplicable, reason: coverageText(declared, lang) };
    return null;
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
  for (const line of scanned) md += `- ${coverageText(line, lang)}\n`;
  if (hasWeb && consoleChecked === false) md += `\n${t.playwrightNote}\n`;

  md += `\n---\n\n## ${t.nextStepsTitle}\n\n`;
  md += `${counts.critical > 0 ? t.nextStepsCritical : t.nextStepsNormal}\n\n`;
  if (hasWeb && web.length > 0) md += `${t.initHint}\n\n`;

  md += `---\n\n`;
  // No claim about who authorized this. vibeward is not in a position to certify the
  // operator's relationship to the site, and a report that asserts it on their behalf is a
  // liability the moment it is forwarded to anyone.
  md += `${t.footer(VERSION)}\n`;

  return { markdown: md, counts, webCounts, verdict, totalCrit };
}
