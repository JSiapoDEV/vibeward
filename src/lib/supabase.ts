import type { Finding } from './types.js';

// Supabase Row Level Security probe.
//
// The anon key is public by design. The only barrier between it and the data is RLS.
// If a table returns rows with just the anon key, RLS is missing or misconfigured and
// any visitor can read it. We confirm exposure by reading at most ONE row, storing only
// the count and the names of sensitive columns — never any row content. No writes.

export type TableStatus = 'exposed' | 'protected' | 'absent' | 'error';

export interface TableResult {
  table: string;
  status: TableStatus;
  readable?: boolean;
  rowsTotal?: number | null;
  columns?: number;
  leakedColumns?: string[];
  httpStatus?: number;
  error?: string;
}

export interface RlsResult {
  projectUrl: string;
  probed: number;
  exposed: TableResult[];
  exposedCount: number;
  piiTables: TableResult[];
  allResults: TableResult[];
}

const COMMON_TABLES = [
  'users',
  'user',
  'profiles',
  'profile',
  'accounts',
  'account',
  'customers',
  'customer',
  'orders',
  'order',
  'payments',
  'payment',
  'subscriptions',
  'subscription',
  'invoices',
  'invoice',
  'messages',
  'message',
  'chats',
  'chat',
  'conversations',
  'posts',
  'post',
  'comments',
  'comment',
  'todos',
  'todo',
  'tasks',
  'task',
  'products',
  'product',
  'leads',
  'lead',
  'contacts',
  'contact',
  'transactions',
  'settings',
  'api_keys',
  'apikeys',
  'tokens',
  'notifications',
  'files',
  'documents',
  'events',
  'logs',
  'waitlist',
  'subscribers',
  'emails',
  'feedback',
  'reviews',
  'organizations',
  'teams',
  'members',
  'roles',
  'permissions',
];

const SENSITIVE_COLUMNS = [
  'email',
  'phone',
  'password',
  'password_hash',
  'hashed_password',
  'stripe_customer_id',
  'stripe_id',
  'api_key',
  'apikey',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'ssn',
  'dni',
  'credit_card',
  'card_number',
  'address',
  'full_name',
  'first_name',
  'last_name',
  'date_of_birth',
  'birthdate',
  'ip_address',
];

async function probeTable(
  projectUrl: string,
  anonKey: string,
  table: string,
  timeout: number,
): Promise<TableResult> {
  const url = `${projectUrl}/rest/v1/${table}?select=*&limit=1`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: 'application/json',
        Prefer: 'count=exact',
      },
      signal: controller.signal,
    });

    if (res.status === 200) {
      let total: number | null = null;
      const range = res.headers.get('content-range'); // e.g. 0-0/1234
      if (range?.includes('/')) {
        const n = range.split('/')[1];
        if (n && n !== '*') total = Number.parseInt(n, 10);
      }
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      const readable = Array.isArray(rows) && rows.length > 0;
      const leakedColumns = readable
        ? Object.keys(rows[0]!).filter((c) =>
            SENSITIVE_COLUMNS.some((s) => c.toLowerCase().includes(s)),
          )
        : [];
      return {
        table,
        status: 'exposed',
        readable,
        rowsTotal: total,
        columns: readable ? Object.keys(rows[0]!).length : 0,
        leakedColumns,
      };
    }
    return {
      table,
      status: res.status === 404 ? 'absent' : 'protected',
      httpStatus: res.status,
    };
  } catch (err) {
    return { table, status: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

export async function probeRLS(
  projectUrl: string,
  anonKey: string,
  { timeout = 10000, tables = COMMON_TABLES }: { timeout?: number; tables?: string[] } = {},
): Promise<RlsResult> {
  const results: TableResult[] = [];
  const queue = [...tables];
  const concurrency = 5;

  async function worker(): Promise<void> {
    let table: string | undefined;
    while ((table = queue.shift()) !== undefined) {
      results.push(await probeTable(projectUrl, anonKey, table, timeout));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const exposed = results.filter((r) => r.status === 'exposed' && r.readable);
  const piiTables = exposed.filter((r) => (r.leakedColumns?.length ?? 0) > 0);

  return {
    projectUrl,
    probed: tables.length,
    exposed,
    exposedCount: exposed.length,
    piiTables,
    allResults: results,
  };
}

/** Read-only query for the "paste this" white-box flow (run in the Supabase SQL Editor). */
export const SUPABASE_AUDIT_SQL = `-- vibeward: read-only Supabase security audit.
-- Run in the SQL Editor, then download/copy the single JSON result and pass it with:
--   vibeward scan <folder> --supabase result.json
select jsonb_pretty(jsonb_build_object(
  'tables_without_rls', (
    select coalesce(jsonb_agg(jsonb_build_object('table', c.relname) order by c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
  ),
  'permissive_policies', (
    select coalesce(jsonb_agg(jsonb_build_object('table', tablename, 'policy', policyname)), '[]'::jsonb)
    from pg_policies where schemaname = 'public' and coalesce(qual, 'true') = 'true'
  ),
  'security_definer_functions', (
    select coalesce(jsonb_agg(jsonb_build_object('function', p.proname) order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef = true
  )
)) as vibeward_audit;`;

interface SupabaseExport {
  tables_without_rls?: { table: string }[];
  permissive_policies?: { table: string; policy: string }[];
  security_definer_functions?: { function: string }[];
}

/** Digs the audit object out of whatever shape the SQL Editor exported. */
function normalizeExport(json: unknown): SupabaseExport | null {
  const looksLikeAudit = (o: unknown): o is SupabaseExport =>
    typeof o === 'object' &&
    o !== null &&
    ('tables_without_rls' in o || 'permissive_policies' in o || 'security_definer_functions' in o);

  const visit = (v: unknown): SupabaseExport | null => {
    if (typeof v === 'string') {
      try {
        return visit(JSON.parse(v));
      } catch {
        return null;
      }
    }
    if (looksLikeAudit(v)) return v;
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = visit(item);
        if (r) return r;
      }
    } else if (typeof v === 'object' && v !== null) {
      for (const val of Object.values(v)) {
        const r = visit(val);
        if (r) return r;
      }
    }
    return null;
  };
  return visit(json);
}

/** Turns the "paste this SQL" JSON export into findings (white-box RLS depth). */
export function analyzeSupabaseExport(json: unknown): Finding[] {
  const data = normalizeExport(json);
  if (!data) return [];
  const findings: Finding[] = [];

  for (const t of data.tables_without_rls ?? []) {
    findings.push({
      id: `rls_disabled_${t.table}`,
      label: `Table \`${t.table}\` has Row Level Security disabled`,
      severity: 'high',
      check: 6,
      cwe: 'CWE-863',
      source: `supabase:public.${t.table}`,
      evidence: 'relrowsecurity = false in the live database',
      exploit:
        'With RLS off, the table is reachable through the public REST API with the anon key — any visitor can read (and possibly write) its rows.',
      why: 'Enable RLS and add owner-scoped policies. Without RLS, no policy protects the data.',
      references: [
        'https://supabase.com/docs/guides/database/postgres/row-level-security',
        'https://cwe.mitre.org/data/definitions/863.html',
      ],
      meta: { table: t.table },
    });
  }

  for (const p of data.permissive_policies ?? []) {
    findings.push({
      id: 'permissive_policy',
      label: `Policy \`${p.policy}\` on \`${p.table}\` allows everyone`,
      severity: 'critical',
      check: 7,
      cwe: 'CWE-863',
      source: `supabase:public.${p.table}`,
      evidence: `Policy "${p.policy}" has USING (true)`,
      exploit:
        'The policy matches every row for every user, so RLS is effectively off for this table.',
      why: 'Filter by the owner instead, e.g. `auth.uid() = user_id`.',
      references: ['https://supabase.com/docs/guides/database/postgres/row-level-security'],
    });
  }

  for (const fn of data.security_definer_functions ?? []) {
    findings.push({
      id: 'security_definer',
      label: `Function \`${fn.function}\` runs as its owner (SECURITY DEFINER)`,
      severity: 'medium',
      check: 10,
      cwe: 'CWE-269',
      source: `supabase:public.${fn.function}`,
      evidence: 'prosecdef = true',
      exploit:
        'A SECURITY DEFINER function runs with elevated privileges and bypasses RLS. If callable by anyone and not carefully scoped, it can leak or modify data.',
      why: 'Review it: pin search_path, validate inputs, and restrict who can execute it.',
      references: ['https://cwe.mitre.org/data/definitions/269.html'],
    });
  }

  return findings;
}
