export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  id: string;
  label: string;
  severity: Severity;
  check: number;
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
  /** CVE / CWE / vendor-docs URLs for the client's AI and reviewers. */
  references?: string[];
  /** Structured context (e.g. the affected table). */
  meta?: { table?: string };
}

/** A public BaaS config recovered from the client bundle so its data API can be probed. */
export interface SupabaseConfig {
  projectUrl: string;
  /** The public key used to probe: an anon JWT or an `sb_publishable_`/`sb_secret_` key. */
  anonKey: string | null;
  /** How the probe key was classified, for reporting. */
  keyKind?: 'anon-jwt' | 'publishable' | 'secret';
}
