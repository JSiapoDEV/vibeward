import { coverage } from './i18n.js';
import type { CoverageLine } from './i18n.js';

/**
 * What happened to one area of the scan.
 *
 * `checked` is the only one of the three that licenses a reader to conclude anything from
 * the absence of a finding. The other two exist because the alternative — leaving a skipped
 * area out of the report — makes "we did not look" and "we looked and it was fine"
 * indistinguishable, and only one of those is a clean bill of health.
 *
 * The line between the two negatives is who decided:
 *
 * - `not_applicable` — the area cannot exist on this target. A folder with no SQL files has
 *   no migrations to analyse; there is nothing here that could have been wrong.
 * - `not_evaluated` — the area exists, or may well exist, and this scan did not look at it.
 *   `--passive` over a site with a Supabase backend, a declined probe, `--no-rls`. Missing
 *   evidence is missing evidence; it is never evidence of absence.
 *
 * When in doubt between them, it is `not_evaluated`. Calling a gap `not_applicable` asserts
 * something about the target that the scan did not establish.
 */
export type CoverageStatus = 'checked' | 'not_applicable' | 'not_evaluated';

export interface CoverageEntry {
  /**
   * Stable identifier for the area, never translated and never renamed casually — an agent
   * parsing `--stdout` keys off it the same way it keys off a finding's `id`.
   */
  id: string;
  status: CoverageStatus;
  /** What was checked, or why it was not, in both languages. */
  detail: CoverageLine;
}

/**
 * The areas a scan can report on.
 *
 * Areas, not individual rules, because an area is the granularity at which vibeward can
 * actually skip something. The rules inside one run together or not at all: there is no
 * path on which `supabase_service_role` fires and `stripe_secret` is quietly passed over,
 * so a per-rule ledger would be twenty-five rows that always agree, and it would imply a
 * precision the tool does not have. Where individual checks genuinely can be skipped one at
 * a time — the website checks, which each need their own input — the ledger is per check,
 * keyed by the same ids as `WEB_CHECKS`.
 */
export const AREA = {
  /** Security headers on the main document (CSP, HSTS, X-Frame-Options, nosniff). */
  httpHeaders: 'http_headers',
  /** Whether the plain-http:// twin of the target answers instead of redirecting. */
  transport: 'transport_https',
  /** Secrets and credentials in the JavaScript bundles served to the browser. */
  bundleSecrets: 'bundle_secrets',
  /** Source maps left reachable next to those bundles. */
  sourceMaps: 'source_maps',
  /** Secrets in the inline scripts of crawled pages beyond the home page. */
  pageSecrets: 'page_secrets',
  /** Row-Level Security on the live Supabase project: table enumeration and row reads. */
  supabaseRls: 'supabase_rls',
  /** Whether the live Supabase project answers GraphQL introspection. */
  supabaseGraphql: 'supabase_graphql',
  /** Firebase Realtime Database and Storage bucket rules, probed live. */
  firebaseRules: 'firebase_rules',
  /** A Supabase audit export folded in from `--supabase`. */
  supabaseExport: 'supabase_export',
  /** Secrets and committed environment files in the source tree. */
  sourceSecrets: 'source_secrets',
  /** Server-side authorization and framework configuration in the source tree. */
  backendAuthz: 'backend_authz',
  /** File uploads checked by name or declared type instead of by their content (magic bytes). */
  uploadValidation: 'upload_validation',
  /** RLS, permissive policies, SECURITY DEFINER and anon grants in SQL migrations. */
  sqlMigrations: 'sql_migrations',
  /** The website quality and AI-visibility pass, as a whole. */
  websiteQuality: 'website_quality',
} as const;

export type Area = (typeof AREA)[keyof typeof AREA];

/**
 * Collects coverage as the scan runs.
 *
 * Written at the point the decision is made rather than reconstructed at the end, because
 * the scanner is the only place that knows how many bundles it read, how many tables it
 * probed, or which branch it took past a declined prompt. Reconstructing it afterwards from
 * flags would produce a ledger that describes the command line instead of the run.
 */
export interface CoverageLedger {
  checked(id: string, en: string, es: string): void;
  notEvaluated(id: string, en: string, es: string): void;
  notApplicable(id: string, en: string, es: string): void;
  entries(): CoverageEntry[];
}

export function ledger(): CoverageLedger {
  const entries: CoverageEntry[] = [];
  const push =
    (status: CoverageStatus) =>
    (id: string, en: string, es: string): void => {
      entries.push({ id, status, detail: coverage(en, es) });
    };
  return {
    checked: push('checked'),
    notEvaluated: push('not_evaluated'),
    notApplicable: push('not_applicable'),
    entries: () => entries,
  };
}

/**
 * True when nothing this scan set out to do was skipped.
 *
 * `not_applicable` does not count against it — an area that cannot exist on this target is
 * not a gap in the scan. `not_evaluated` always does, including when the operator asked for
 * it with `--passive` or by declining the prompt: a deliberate gap is still a gap, and the
 * reader of the report is usually not the person who typed the flag.
 */
export function isComplete(entries: CoverageEntry[]): boolean {
  return !entries.some((e) => e.status === 'not_evaluated');
}
