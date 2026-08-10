import type { Finding, Severity } from '../core/types.js';
import type { RlsResult } from '../checks/supabase.js';

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEV_LABEL: Record<Severity, string> = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
  low: '⚪ LOW',
};

export type SeverityCounts = Record<Severity, number>;

export interface ReportInput {
  target: string;
  dateISO: string;
  findings: Finding[];
  rls: RlsResult | null;
  scanned: string[];
}

export interface ReportOutput {
  markdown: string;
  counts: SeverityCounts;
  verdict: string;
  totalCrit: number;
}

export function buildReport({
  target,
  dateISO,
  findings,
  rls,
  scanned,
}: ReportInput): ReportOutput {
  const sorted = [...findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;

  const totalCrit = counts.critical + counts.high;
  const verdict =
    counts.critical > 0
      ? 'NOT PRODUCTION-READY — critical issues expose data or credentials.'
      : counts.high > 0
        ? 'NEEDS URGENT ATTENTION before staying in production.'
        : counts.medium > 0
          ? 'ACCEPTABLE with recommended improvements.'
          : 'No critical findings in the automated scope.';

  let md = '';
  md += `# Security Audit Report\n\n`;
  md += `**Application:** ${target}\n\n`;
  md += `**Date:** ${dateISO}\n\n`;
  md += `**Scope:** Automated, read-only security analysis of the public frontend and data API. `;
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

  md += `---\n\n`;
  md += `## Coverage\n\n`;
  md += `This automated analysis covers what is verifiable from the outside. Items that require `;
  md += `server access (authorization, input validation, rate limiting, backups) are covered by the `;
  md += `manual part of the audit.\n\n`;
  md += `### Verified automatically\n`;
  for (const s of scanned) md += `- ${s}\n`;
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
  md += `---\n\n`;
  md += `_Generated with vibeward. Automated, read-only analysis performed with the owner's authorization._\n`;

  return { markdown: md, counts, verdict, totalCrit };
}
