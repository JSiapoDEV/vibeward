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

export interface SupabaseConfig {
  projectUrl: string;
  anonKey: string | null;
}
