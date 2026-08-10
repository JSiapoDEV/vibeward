import type { Finding } from '../core/types.js';

export interface SqlFile {
  path: string;
  content: string;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["'`]?(\w+)["'`]?/gi;
const ENABLE_RLS =
  /alter\s+table\s+(?:public\.)?["'`]?(\w+)["'`]?\s+enable\s+row\s+level\s+security/gi;
const PERMISSIVE_POLICY = /create\s+policy[\s\S]{0,240}?using\s*\(\s*true\s*\)/gi;
const SECURITY_DEFINER = /security\s+definer/gi;
const GRANT_TO_ANON =
  /grant\s+([\w, ]+?)\s+on\s+(?:table\s+)?(?:public\.)?["'`]?(\w+)["'`]?\s+to\s+(anon|public)\b/gi;

/** True when the migration set uses the RLS model at all (so a table missing it is a real gap). */
function usesRlsModel(files: SqlFile[]): boolean {
  return files.some((f) =>
    /enable\s+row\s+level\s+security|create\s+policy|\bto\s+(anon|authenticated)\b/i.test(
      f.content,
    ),
  );
}

/**
 * Best-effort static analysis of Supabase/Postgres migrations. Flags permissive
 * `USING (true)` policies, SECURITY DEFINER functions, and anon/public grants always;
 * flags tables created without RLS **only** when the app actually uses the RLS model
 * (`supabaseContext`, or the migrations reference RLS). A plain Prisma/Drizzle app whose
 * DB sits behind the server does not expose tables directly, so "no RLS" is not a finding.
 */
export function analyzeMigrations(
  files: SqlFile[],
  { supabaseContext = false }: { supabaseContext?: boolean } = {},
): Finding[] {
  const findings: Finding[] = [];
  const created = new Map<string, { path: string; line: number }>();
  const rlsEnabled = new Set<string>();
  const flagMissingRls = supabaseContext || usesRlsModel(files);

  for (const { path, content } of files) {
    let m: RegExpExecArray | null;

    CREATE_TABLE.lastIndex = 0;
    while ((m = CREATE_TABLE.exec(content)) !== null) {
      const name = m[1]!.toLowerCase();
      if (!created.has(name)) created.set(name, { path, line: lineAt(content, m.index) });
    }

    ENABLE_RLS.lastIndex = 0;
    while ((m = ENABLE_RLS.exec(content)) !== null) rlsEnabled.add(m[1]!.toLowerCase());

    PERMISSIVE_POLICY.lastIndex = 0;
    while ((m = PERMISSIVE_POLICY.exec(content)) !== null) {
      findings.push({
        id: 'permissive_policy',
        label: 'Row Level Security policy allows everyone (`USING (true)`)',
        severity: 'critical',
        check: 7,
        cwe: 'CWE-863',
        source: `${path}:${lineAt(content, m.index)}`,
        evidence: m[0].replace(/\s+/g, ' ').slice(0, 120),
        exploit:
          'A policy with `USING (true)` matches every row for every user, so RLS is effectively off for this table.',
        why: 'The policy exists but grants access to everyone. Filter by the owner, e.g. `auth.uid() = user_id`.',
        references: ['https://supabase.com/docs/guides/database/postgres/row-level-security'],
      });
    }

    SECURITY_DEFINER.lastIndex = 0;
    while ((m = SECURITY_DEFINER.exec(content)) !== null) {
      findings.push({
        id: 'security_definer',
        label: 'Function runs as its owner (`SECURITY DEFINER`)',
        severity: 'medium',
        check: 10,
        cwe: 'CWE-269',
        source: `${path}:${lineAt(content, m.index)}`,
        evidence: 'SECURITY DEFINER',
        exploit:
          'A SECURITY DEFINER function runs with the definer’s privileges, bypassing RLS. If callable by anyone and not carefully scoped, it can leak or modify data.',
        why: 'Review each SECURITY DEFINER function: pin `search_path`, validate inputs, and restrict who can execute it.',
        references: ['https://cwe.mitre.org/data/definitions/269.html'],
      });
    }

    GRANT_TO_ANON.lastIndex = 0;
    while ((m = GRANT_TO_ANON.exec(content)) !== null) {
      const privileges = m[1]!.replace(/\s+/g, ' ').trim();
      const writes = /\b(insert|update|delete|all)\b/i.test(privileges);
      findings.push({
        id: `grant_anon_${m[2]!.toLowerCase()}`,
        label: `Table \`${m[2]}\` grants ${writes ? 'write ' : ''}access to the ${m[3]!.toLowerCase()} role`,
        severity: writes ? 'high' : 'medium',
        check: 6,
        cwe: 'CWE-863',
        source: `${path}:${lineAt(content, m.index)}`,
        evidence: m[0].replace(/\s+/g, ' ').slice(0, 120),
        exploit: writes
          ? 'Granting INSERT/UPDATE/DELETE to anon lets any unauthenticated visitor write to the table through the public REST API, even with RLS on if no WITH CHECK policy constrains it.'
          : 'Granting table privileges to the anon/public role widens what an unauthenticated caller can reach.',
        why: 'The anon and public roles are reachable by anyone with the public key. Grant table privileges deliberately and rely on RLS policies with `WITH CHECK` for writes.',
        references: ['https://supabase.com/docs/guides/database/postgres/row-level-security'],
      });
    }
  }

  for (const [name, loc] of created) {
    if (flagMissingRls && !rlsEnabled.has(name)) {
      findings.push({
        id: `rls_disabled_${name}`,
        label: `Table \`${name}\` created without Row Level Security`,
        severity: 'high',
        check: 6,
        cwe: 'CWE-863',
        source: `${loc.path}:${loc.line}`,
        evidence: `No \`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY\` found in the migrations`,
        exploit:
          'With RLS disabled, the table is reachable through the public API using the anon key — any visitor can read (and possibly write) its rows.',
        why: 'Every table with user data must enable RLS and add owner-scoped policies. Without RLS, policies do nothing.',
        references: [
          'https://supabase.com/docs/guides/database/postgres/row-level-security',
          'https://cwe.mitre.org/data/definitions/863.html',
        ],
        meta: { table: name },
      });
    }
  }

  return findings;
}
