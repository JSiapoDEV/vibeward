import { isWeb } from '../core/types.js';
import type { AutofixKind, Finding, Severity, SuppressedFinding } from '../core/types.js';
import type { RlsResult } from '../checks/supabase.js';
import type { StackFingerprint } from '../checks/web.js';
import { WEB_CHECKS } from '../checks/web.js';

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEV_LABEL: Record<Severity, string> = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
  low: '⚪ LOW',
};

// Web findings get their own wording so nobody mistakes "high impact on visibility"
// for "high security severity". They are different scales measuring different things.
const WEB_SEV_LABEL: Record<Severity, string> = {
  critical: '🔴 High impact',
  high: '🔴 High impact',
  medium: '🟡 Medium impact',
  low: '⚪ Low impact',
};

const FIXABLE_BY: Record<AutofixKind, string> = {
  auto: 'agent, unattended',
  'needs-input': 'agent + your input',
  manual: 'human decision',
};

export type SeverityCounts = Record<Severity, number>;

export interface ReportInput {
  target: string;
  dateISO: string;
  findings: Finding[];
  rls: RlsResult | null;
  scanned: string[];
  fingerprint?: StackFingerprint | null;
  /** Whether a real browser inspected the console (Playwright present). */
  consoleChecked?: boolean;
  /** Website findings silenced by vibeward.json. Listed, never dropped. */
  suppressed?: SuppressedFinding[];
  /** Checks that do not apply to this site, with the reason from the config. */
  notApplicable?: Map<string, string>;
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
  fingerprint: StackFingerprint | null | undefined,
  consoleChecked: boolean | undefined,
  suppressed: SuppressedFinding[],
  notApplicable: Map<string, string>,
  configPath: string | null | undefined,
): string {
  const found = new Map(web.map((f) => [f.id, f]));
  const silenced = new Map(suppressed.map((s) => [s.finding.id, s]));

  // Three different states, and the report must never blur them: "not evaluated" is not
  // "ok", and "you told us to ignore it" is not "it passed".
  const skipReason = (id: string): string | null => {
    if (consoleChecked === false && NEEDS_BROWSER.has(id)) return 'no browser available';
    return notApplicable.get(id) ?? null;
  };
  const passed = WEB_CHECKS.filter(
    (c) => !found.has(c.id) && !silenced.has(c.id) && skipReason(c.id) === null,
  );

  let md = `## Website quality & AI visibility\n\n`;
  md += `> These findings **do not** affect the security verdict or the exit code. They cover how `;
  md += `this site is read by search engines, social platforms and AI assistants.\n\n`;

  if (fingerprint) {
    md += `**Vibe-coded fingerprint: ${fingerprint.score}/${fingerprint.total}**`;
    if (fingerprint.signals.length) md += ` — ${fingerprint.signals.join(' · ')}`;
    md += `\n\n`;
    const stack = [fingerprint.framework, fingerprint.platformDomain].filter(Boolean).join(' on ');
    if (stack) md += `**Stack detected:** ${stack}\n\n`;
  }

  const checkable = WEB_CHECKS.filter((c) => skipReason(c.id) === null && !silenced.has(c.id));
  md += `**${passed.length} of ${checkable.length} checks passed.**`;
  if (suppressed.length > 0) {
    md += ` **${suppressed.length} suppressed by \`${configName(configPath)}\`** — listed below.`;
  }
  md += `\n\n`;
  md += `| Check | Status | Impact | Fixable by |\n|---|---|---|---|\n`;
  for (const c of WEB_CHECKS) {
    const reason = skipReason(c.id);
    if (reason) {
      md += `| ${c.label} | ⚪ not applicable | ${reason} | — |\n`;
      continue;
    }
    const hidden = silenced.get(c.id);
    if (hidden) {
      md += `| ${c.label} | ⊘ suppressed | ${WEB_SEV_LABEL[hidden.finding.severity]} | ${hidden.reason} |\n`;
      continue;
    }
    const f = found.get(c.id);
    if (!f) {
      md += `| ${c.label} | ✅ ok | — | — |\n`;
      continue;
    }
    const by = f.autofix ? FIXABLE_BY[f.autofix] : '—';
    md += `| ${c.label} | ❌ | ${WEB_SEV_LABEL[f.severity]} | ${by} |\n`;
  }
  md += `\n`;

  if (suppressed.length > 0) {
    md += `### Suppressed by configuration (${suppressed.length})\n\n`;
    md += `These checks **failed** and were silenced in \`${configName(configPath)}\`. `;
    md += `They are listed here so the report cannot be made to look cleaner than the site is.\n\n`;
    md += `| Check | Impact | Declared reason |\n|---|---|---|\n`;
    for (const s of suppressed) {
      md += `| ${s.finding.label} | ${WEB_SEV_LABEL[s.finding.severity]} | ${s.reason} |\n`;
    }
    md += `\n`;
  }

  if (web.length) {
    const sorted = [...web].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    md += `### Website findings in detail\n\n`;
    sorted.forEach((f, i) => {
      md += `#### ${i + 1}. ${WEB_SEV_LABEL[f.severity]} — ${f.label}\n\n`;
      if (f.evidence) md += `**Evidence:** ${f.evidence}\n\n`;
      if (f.impact) md += `**Impact:** ${f.impact}\n\n`;
      md += `**Why it matters:** ${f.why}\n\n`;
      if (f.fix) {
        md += `**Fix** (${f.autofix ? FIXABLE_BY[f.autofix] : 'manual'}):\n\n`;
        md += f.fix.includes('\n') ? `\`\`\`\n${f.fix}\n\`\`\`\n\n` : `\`${f.fix}\`\n\n`;
      }
      if (f.meta?.pages?.length) {
        const shown = f.meta.pages.slice(0, 8);
        md += `**Pages:** ${shown.map((p) => `\`${p}\``).join(', ')}`;
        md +=
          f.meta.pages.length > shown.length
            ? ` (+${f.meta.pages.length - shown.length})\n\n`
            : `\n\n`;
      }
      if (f.references?.length) {
        md += `**References:** ${f.references.map((r) => `<${r}>`).join(' · ')}\n\n`;
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
  fingerprint,
  consoleChecked,
  suppressed = [],
  notApplicable = new Map(),
  configPath,
}: ReportInput): ReportOutput {
  const security = findings.filter((f) => !isWeb(f));
  const web = findings.filter(isWeb);
  const sorted = [...security].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  const counts = tally(security);
  const webCounts = tally(web);

  const totalCrit = counts.critical + counts.high;
  const verdict =
    counts.critical > 0
      ? 'NOT PRODUCTION-READY — critical issues expose data or credentials.'
      : counts.high > 0
        ? 'NEEDS URGENT ATTENTION before staying in production.'
        : counts.medium > 0
          ? 'ACCEPTABLE with recommended improvements.'
          : 'No critical findings in the automated scope.';

  const hasWeb = web.length > 0 || suppressed.length > 0 || Boolean(fingerprint);

  let md = '';
  md += `# ${hasWeb ? 'Audit Report' : 'Security Audit Report'}\n\n`;
  md += `**Application:** ${target}\n\n`;
  md += `**Date:** ${dateISO}\n\n`;
  md += `**Scope:** Automated, read-only analysis of the public frontend and data API`;
  md += hasWeb ? `, plus website quality and AI visibility. ` : `. `;
  md += `Does not include manual penetration testing or server-side code review.\n\n`;
  md += `---\n\n`;

  md += `## Executive summary\n\n`;
  md += `> **${verdict}**\n\n`;
  md += `| Severity | Findings |\n|---|---|\n`;
  md += `| 🔴 Critical | ${counts.critical} |\n`;
  md += `| 🟠 High | ${counts.high} |\n`;
  md += `| 🟡 Medium | ${counts.medium} |\n`;
  md += `| ⚪ Low | ${counts.low} |\n\n`;

  if (counts.critical > 0) {
    md += `**${counts.critical} critical issue(s)** detected. A critical issue means that, right now, `;
    md += `an unauthorized person could read private user data or use credentials that cost you money. `;
    md += `Fix these before anything else.\n\n`;
  }

  if (hasWeb) {
    md += `Separately, **${web.length} website quality issue(s)** were found — see the section `;
    md += `below. They do not affect the security verdict.\n\n`;
  }

  // Right next to the verdict, never buried: a reader has to know the scope was narrowed
  // before they read what the scan concluded.
  if (suppressed.length > 0) {
    md += `> ⚠️ **This report was produced with ${suppressed.length} suppression(s) in effect**, `;
    md += `declared in \`${configName(configPath)}\`. Each one is listed with its reason `;
    md += `in the website section. Security findings can never be suppressed.\n\n`;
  }

  if (rls) {
    md += `## Database exposure\n\n`;
    const how =
      rls.enumerated > 0
        ? `${rls.enumerated} table(s) enumerated live from the data API (plus common names)`
        : `${rls.probed} common table names`;
    if (rls.exposedCount > 0) {
      md += `Access to **${how}** was probed using only the public key. `;
      md += `**${rls.exposedCount} table(s) returned data** — Row Level Security is missing or `;
      md += `misconfigured and any visitor can read their contents.\n\n`;
      md += `| Table | Total rows | Sensitive columns exposed | Writable |\n|---|---|---|---|\n`;
      for (const t of rls.exposed) {
        const pii = t.leakedColumns?.length ? `⚠️ ${t.leakedColumns.join(', ')}` : '—';
        const w = t.write === 'writable' ? '🔴 yes' : t.write === 'blocked' ? 'no' : '—';
        md += `| \`${t.table}\` | ${t.rowsTotal ?? '?'} | ${pii} | ${w} |\n`;
      }
      md += `\n`;
      if (rls.piiTables.length) {
        md += `> ⚠️ **${rls.piiTables.length} of those tables contain personal data** `;
        md += `(emails, phones, names or others). This is an active data leak.\n\n`;
      }
      if (rls.writable.length) {
        md += `> 🔴 **${rls.writable.length} table(s) also accept unauthenticated writes** — `;
        md += `anyone can tamper with the data, not just read it.\n\n`;
      }
      md += `**How to fix:** enable RLS on every table (\`ALTER TABLE x ENABLE ROW LEVEL SECURITY;\`) `;
      md += `and write policies that filter by \`auth.uid()\`, not \`true\`.\n\n`;
    } else if (rls.probed) {
      md += `${how} were probed with the public key. `;
      md += `None returned data: **RLS appears active** on the probed tables. `;
      md += `Note: this does not prove every table is protected, only the ones reached.\n\n`;
    }
    md += `---\n\n`;
  }

  md += `## Detailed findings\n\n`;
  if (sorted.length === 0) {
    md += `No exposed secrets or missing headers were detected in the automated analysis. `;
    md += `A manual server-side review is still recommended.\n\n`;
  } else {
    sorted.forEach((f, i) => {
      md += `### ${i + 1}. ${SEV_LABEL[f.severity]} — ${f.label}\n\n`;
      if (f.cwe) md += `**Classification:** ${f.cwe}\n\n`;
      if (f.source) md += `**Where:** ${f.source}\n\n`;
      if (f.evidence) md += `**Evidence:** ${f.evidence}\n\n`;
      if (f.exploit) md += `**How it's exploited:** ${f.exploit}\n\n`;
      if (f.impact) md += `**Impact:** ${f.impact}\n\n`;
      md += `**Why it matters:** ${f.why}\n\n`;
      if (f.references?.length) {
        md += `**References:** ${f.references.map((r) => `<${r}>`).join(' · ')}\n\n`;
      }
      if (f.check) md += `_Checklist item ${f.check}._\n\n\n`;
    });
  }

  if (hasWeb) {
    md += `---\n\n`;
    md += webSection(web, fingerprint, consoleChecked, suppressed, notApplicable, configPath);
  }

  md += `---\n\n`;
  md += `## Coverage\n\n`;
  md += `This automated analysis covers what is verifiable from the outside. Items that require `;
  md += `server access (authorization, input validation, rate limiting, backups) are covered by the `;
  md += `manual part of the audit.\n\n`;
  md += `### Verified automatically\n`;
  for (const s of scanned) md += `- ${s}\n`;
  if (hasWeb && consoleChecked === false) {
    md += `\n> Browser console errors were **not** inspected: Playwright is not installed. `;
    md += `Install it (\`npm i -D playwright && npx playwright install chromium\`) and re-run to `;
    md += `include runtime errors.\n`;
  }
  md += `\n---\n\n## Recommended next steps\n\n`;
  if (counts.critical > 0) {
    md += `1. **Today:** rotate every exposed credential listed above.\n`;
    md += `2. **Today:** enable RLS on the exposed tables.\n`;
    md += `3. **This week:** move any sensitive logic from the browser to the server.\n`;
    md += `4. Re-scan to confirm the criticals are closed.\n\n`;
  } else {
    md += `1. Address findings in order of severity.\n`;
    md += `2. Complement with a manual server-side review.\n\n`;
  }
  if (hasWeb && web.length > 0) {
    md += `For the website section, \`npx vibeward@latest init\` installs a skill that reads these `;
    md += `findings, applies the fixes it can, and re-scans to verify.\n\n`;
  }
  md += `---\n\n`;
  md += `_Generated with vibeward. Automated, read-only analysis performed with the owner's authorization._\n`;

  return { markdown: md, counts, webCounts, verdict, totalCrit };
}
