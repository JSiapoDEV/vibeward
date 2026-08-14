export type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Which family a finding belongs to. Absent means `security`, so every existing
 * finding keeps working untouched.
 *
 * `web` findings are quality/visibility problems, not vulnerabilities: they live in
 * their own report section, never enter the severity counts or the SARIF output, and
 * never influence the exit code. Mixing them would dilute the security verdict.
 */
export type FindingKind = 'security' | 'web';

/** Who can apply `fix`: an agent alone, an agent given business context, or a human. */
export type AutofixKind = 'auto' | 'needs-input' | 'manual';

export interface Finding {
  id: string;
  label: string;
  severity: Severity;
  /** Family this belongs to. Absent = `security`. */
  kind?: FindingKind;
  /** Item in the 25-point security checklist. Web findings have none. */
  check?: number;
  /** Weakness classification, e.g. "CWE-863". */
  cwe?: string;
  /** Where it lives: a URL, bundle path, or `table.column`. */
  source?: string;
  /** What proves it (counts, snippets, column names). */
  evidence?: string;
  /** How it is abused, concretely, for this instance. */
  exploit?: string;
  /** Quantified consequence (rows, data, money at risk). */
  impact?: string;
  /** Why it matters, in business language. */
  why: string;
  /** The concrete remediation — a snippet, a file to add, a command to run. */
  fix?: string;
  /** Whether an agent can apply `fix` unattended. Read by the `vibeward init` skill. */
  autofix?: AutofixKind;
  /** CVE / CWE / vendor-docs URLs for the client's AI and reviewers. */
  references?: string[];
  /** Structured context (the affected table, the pages involved, a count). */
  meta?: { table?: string; pages?: string[]; count?: number };
}

/** True for quality/visibility findings, which are reported apart from security ones. */
export function isWeb(f: Finding): boolean {
  return f.kind === 'web';
}

/**
 * What the owner says the site is meant to be. vibeward then checks reality against that
 * intention instead of against one fixed idea of a correct site — which is why declaring
 * `aiCrawlers: 'blocked'` does not silence a check, it flips it: an incomplete block
 * becomes the finding, because you believed you were blocking and you are not.
 */
export interface VibewardIntent {
  /** `blocked` = AI crawlers are shut out on purpose. Default `open`. */
  aiCrawlers?: 'open' | 'blocked';
  /** What kind of thing this is. Default `website`. */
  siteType?: 'website' | 'app' | 'internal';
}

/** A silenced check. `reason` is mandatory: an undocumented silence is not a decision. */
export interface Suppression {
  id: string;
  reason: string;
}

/** `vibeward.json` — read from local disk only, never from the site being scanned. */
export interface VibewardConfig {
  schemaVersion?: number;
  intent?: VibewardIntent;
  suppress?: Suppression[];
}

/** A finding that was produced, failed, and was silenced by config — never deleted. */
export interface SuppressedFinding {
  finding: Finding;
  reason: string;
}

/** A public BaaS config recovered from the client bundle so its data API can be probed. */
export interface SupabaseConfig {
  projectUrl: string;
  /** The public key used to probe: an anon JWT or an `sb_publishable_`/`sb_secret_` key. */
  anonKey: string | null;
  /** How the probe key was classified, for reporting. */
  keyKind?: 'anon-jwt' | 'publishable' | 'secret';
}
