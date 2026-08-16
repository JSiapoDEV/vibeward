import type { Finding } from '../core/types.js';
import { scanReturnedData } from './secrets.js';

// Supabase Row Level Security probe.
//
// The anon/publishable key is public by design. The only barrier between it and the
// data is RLS. If a table returns rows with just that key, RLS is missing or
// misconfigured and any visitor can read it. We confirm exposure by reading at most
// ONE row; we scan that row for third-party secrets but never store its contents.
// Reads only, unless the caller explicitly opts into a non-mutating write test.

export type TableStatus = 'exposed' | 'protected' | 'absent' | 'error';
export type WriteStatus = 'writable' | 'blocked' | 'inconclusive' | 'unchecked';

export interface TableResult {
  table: string;
  status: TableStatus;
  readable?: boolean;
  rowsTotal?: number | null;
  columns?: number;
  leakedColumns?: string[];
  write?: WriteStatus;
  /** Third-party secrets found inside the returned row (masked), if any. */
  secretsInData?: Finding[];
  httpStatus?: number;
  error?: string;
}

export interface RlsResult {
  projectUrl: string;
  probed: number;
  /** How many probed tables came from live OpenAPI enumeration (vs the fallback list). */
  enumerated: number;
  exposed: TableResult[];
  exposedCount: number;
  piiTables: TableResult[];
  writable: TableResult[];
  dataSecrets: Finding[];
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

/** How many tables we are willing to probe in one run (enumeration can return many). */
const MAX_TABLES = 80;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Parses the PostgREST root document (`GET /rest/v1/`) into the list of exposed table
 * names. PostgREST returns Swagger/OpenAPI whose `definitions` keys are the tables/views;
 * `paths` are used as a fallback. RPC functions (`/rpc/...`) are skipped. Pure — no network.
 */
export function parseOpenApiTables(body: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return [];
  }
  const root = asRecord(doc);
  if (!root) return [];
  const names = new Set<string>();

  const defs = asRecord(root.definitions);
  if (defs) for (const k of Object.keys(defs)) names.add(k);

  const paths = asRecord(root.paths);
  if (paths) {
    for (const p of Object.keys(paths)) {
      const name = p.replace(/^\//, '');
      if (name && !name.startsWith('rpc/') && !name.includes('/')) names.add(name);
    }
  }
  return [...names];
}

/** Enumerates the tables the anon key can see via the PostgREST OpenAPI root. */
async function enumerateTables(
  projectUrl: string,
  key: string,
  timeout: number,
): Promise<string[]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${projectUrl}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    return parseOpenApiTables(await res.text());
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** Non-mutating write-authorization test: an empty bulk insert writes zero rows. */
async function probeWrite(
  projectUrl: string,
  key: string,
  table: string,
  timeout: number,
): Promise<WriteStatus> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${projectUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: '[]', // empty bulk insert — accepted means the grant exists; nothing is written
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return 'blocked';
    if (res.status >= 200 && res.status < 300) return 'writable';
    return 'inconclusive';
  } catch {
    return 'inconclusive';
  } finally {
    clearTimeout(t);
  }
}

async function probeTable(
  projectUrl: string,
  key: string,
  table: string,
  { timeout, writeTest }: { timeout: number; writeTest: boolean },
): Promise<TableResult> {
  const url = `${projectUrl}/rest/v1/${table}?select=*&limit=1`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
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
      const secretsInData = readable
        ? scanReturnedData(JSON.stringify(rows), `${projectUrl}/rest/v1/${table}`)
        : [];
      const write =
        writeTest && readable ? await probeWrite(projectUrl, key, table, timeout) : 'unchecked';
      return {
        table,
        status: 'exposed',
        readable,
        rowsTotal: total,
        columns: readable ? Object.keys(rows[0]!).length : 0,
        leakedColumns,
        secretsInData,
        write,
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
  {
    timeout = 10000,
    tables,
    writeTest = false,
  }: { timeout?: number; tables?: string[]; writeTest?: boolean } = {},
): Promise<RlsResult> {
  // Enumerate live, then union with the common-name fallback so we cover custom tables
  // (the Moltbook failure: `agents`, `submolts`… never appear in a fixed list).
  const discovered = tables ?? (await enumerateTables(projectUrl, anonKey, timeout));
  const enumerated = discovered.length;
  const merged = [...new Set([...discovered, ...COMMON_TABLES])].slice(0, MAX_TABLES);

  const results: TableResult[] = [];
  const queue = [...merged];
  const concurrency = 5;

  async function worker(): Promise<void> {
    let table: string | undefined;
    while ((table = queue.shift()) !== undefined) {
      results.push(await probeTable(projectUrl, anonKey, table, { timeout, writeTest }));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const exposed = results.filter((r) => r.status === 'exposed' && r.readable);
  const piiTables = exposed.filter((r) => (r.leakedColumns?.length ?? 0) > 0);
  const writable = exposed.filter((r) => r.write === 'writable');
  const dataSecrets = exposed.flatMap((r) => r.secretsInData ?? []);

  return {
    projectUrl,
    probed: merged.length,
    enumerated,
    exposed,
    exposedCount: exposed.length,
    piiTables,
    writable,
    dataSecrets,
    allResults: results,
  };
}

/** Builds every finding implied by an RLS probe: reads, writes, and secrets-in-data. */
export function rlsFindings(rls: RlsResult): Finding[] {
  const findings: Finding[] = [];

  for (const t of rls.exposed) {
    const hasPII = (t.leakedColumns?.length ?? 0) > 0;
    const rows = t.rowsTotal ?? undefined;
    const cols = hasPII ? t.leakedColumns!.join(', ') : '';
    findings.push({
      id: `rls_exposed_${t.table}`,
      es: {
        label: `La tabla '${t.table}' es legible sin autenticación${hasPII ? ' (contiene datos personales)' : ''}`,
        evidence: `${rows ?? '?'} filas legibles solo con la clave pública${hasPII ? `; columnas sensibles: ${cols}` : ''}`,
        exploit: `Cualquier visitante envía \`GET /rest/v1/${t.table}?select=*\` con la clave pública (visible en el bundle de JS) y le devuelven todas las filas — sin iniciar sesión.`,
        impact: hasPII
          ? `~${rows ?? 'todos'} registros, incluidos ${cols}, son legibles ahora mismo por cualquiera en internet. Fuga de datos personales activa (exposición ante el RGPD y la protección al consumidor).`
          : `~${rows ?? 'todas'} las filas son legibles por cualquiera que tenga la clave pública.`,
        why: hasPII
          ? 'Una tabla con datos personales es legible por todo el mundo. Esto es una brecha en curso, no un riesgo teórico: falta RLS o está mal configurada.'
          : 'La tabla es legible por cualquier visitante. Hay que activar RLS y restringirla al propietario de cada fila.',
      },
      label: `Table '${t.table}' readable without authentication${hasPII ? ' (contains personal data)' : ''}`,
      severity: hasPII ? 'critical' : 'high',
      check: 6,
      cwe: 'CWE-863',
      source: `${rls.projectUrl}/rest/v1/${t.table}`,
      evidence: `${rows ?? '?'} rows readable with only the public key${hasPII ? `; sensitive columns: ${cols}` : ''}`,
      exploit: `Any visitor sends \`GET /rest/v1/${t.table}?select=*\` with the public key (visible in the JS bundle) and every row comes back — no login required.`,
      impact: hasPII
        ? `~${rows ?? 'all'} records including ${cols} are readable by anyone on the internet right now. Active personal-data leak (GDPR / consumer-protection exposure).`
        : `~${rows ?? 'all'} rows are readable by anyone with the public key.`,
      why: hasPII
        ? 'A table with personal data is world-readable. This is a live breach, not a theoretical risk: RLS is missing or misconfigured.'
        : 'The table is readable by any visitor. RLS must be enabled and restricted to each row owner.',
      references: [
        'https://supabase.com/docs/guides/database/postgres/row-level-security',
        'https://cwe.mitre.org/data/definitions/863.html',
        'https://nvd.nist.gov/vuln/detail/CVE-2025-48757',
      ],
      meta: { table: t.table },
    });
  }

  for (const t of rls.writable) {
    findings.push({
      id: `rls_writable_${t.table}`,
      es: {
        label: `La tabla '${t.table}' es escribible sin autenticación`,
        evidence: 'La API REST aceptó una escritura sin autenticar (un insert vacío).',
        exploit: `Cualquier visitante puede hacer POST/PATCH sobre \`${t.table}\` con la clave pública — el modo de fallo de Moltbook: alterar filas, inyectar contenido o corromper la base de datos, sin iniciar sesión.`,
        impact:
          'Las escrituras sin autenticar permiten que cualquiera altere o destruya tus datos y, en tablas de contenido, inyecte cargas que después ejecutan otros usuarios o agentes.',
        why: 'Ni RLS ni las políticas están limitando las escrituras en esta tabla. Añade una política con `WITH CHECK` y quita los permisos de escritura al rol anon.',
      },
      label: `Table '${t.table}' is writable without authentication`,
      severity: 'critical',
      check: 6,
      cwe: 'CWE-862',
      source: `${rls.projectUrl}/rest/v1/${t.table}`,
      evidence: 'An unauthenticated write (empty insert) was accepted by the REST API.',
      exploit: `Any visitor can POST/PATCH to \`${t.table}\` with the public key — the Moltbook failure mode: tamper with rows, inject content, or corrupt the database, no login required.`,
      impact:
        'Unauthenticated writes let anyone alter or destroy your data and (for content tables) inject stored payloads that other users or agents then execute.',
      why: 'RLS/policies do not constrain writes for this table. Add a policy with `WITH CHECK` and remove write grants from the anon role.',
      references: [
        'https://supabase.com/docs/guides/database/postgres/row-level-security',
        'https://cwe.mitre.org/data/definitions/862.html',
      ],
      meta: { table: t.table },
    });
  }

  findings.push(...rls.dataSecrets);
  return findings;
}

/** Flags that pg_graphql introspection is reachable by the anon key. */
export function graphqlIntrospectionFinding(projectUrl: string): Finding {
  return {
    id: 'graphql_introspection',
    es: {
      label: 'La introspección de GraphQL está habilitada para llamantes anónimos',
      evidence:
        'Una consulta de introspección `__schema` devolvió el grafo de tipos completo con la clave pública.',
      exploit:
        'Un atacante sin autenticar mapea el esquema entero de la base de datos — todas las tablas, columnas y relaciones — lo que le señala exactamente dónde están los datos sensibles y las políticas débiles.',
      why: 'La introspección le entrega al atacante un mapa completo. Restringe el endpoint de pg_graphql, o acéptalo solo si todo el esquema es público a propósito.',
    },
    label: 'GraphQL introspection is enabled for anonymous callers',
    severity: 'medium',
    check: 23,
    cwe: 'CWE-200',
    source: `${projectUrl}/graphql/v1`,
    evidence: 'A `__schema` introspection query returned the full type graph with the public key.',
    exploit:
      'An unauthenticated attacker maps the entire database schema — every table, column and relationship — which pinpoints where the sensitive data and weak policies are.',
    why: 'Introspection hands attackers a complete map. Restrict the pg_graphql endpoint, or accept it only if the whole schema is intentionally public.',
    references: ['https://cwe.mitre.org/data/definitions/200.html'],
  };
}

/** POSTs a tiny introspection query; a schema in the response means it is open. */
export async function checkGraphqlIntrospection(
  projectUrl: string,
  key: string,
  timeout = 10000,
): Promise<Finding | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${projectUrl}/graphql/v1`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'query{__schema{queryType{name}}}' }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.text();
    if (/"__schema"|"queryType"/.test(body) && /"data"\s*:/.test(body)) {
      return graphqlIntrospectionFinding(projectUrl);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
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
      es: {
        label: `La tabla \`${t.table}\` tiene Row Level Security desactivada`,
        evidence: 'relrowsecurity = false en la base de datos en vivo',
        exploit:
          'Con RLS desactivada, la tabla es accesible por la API REST pública con la clave anon — cualquier visitante puede leer (y posiblemente escribir) sus filas.',
        why: 'Activa RLS y añade políticas acotadas al propietario. Sin RLS, ninguna política protege los datos.',
      },
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
      es: {
        label: `La política \`${p.policy}\` sobre \`${p.table}\` permite a todo el mundo`,
        evidence: `La política "${p.policy}" tiene USING (true)`,
        exploit:
          'La política casa con todas las filas para todos los usuarios, así que RLS está desactivada de hecho en esta tabla.',
        why: 'Filtra por el propietario, por ejemplo `auth.uid() = user_id`.',
      },
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
      es: {
        label: `La función \`${fn.function}\` se ejecuta como su propietario (SECURITY DEFINER)`,
        evidence: 'prosecdef = true',
        exploit:
          'Una función SECURITY DEFINER se ejecuta con privilegios elevados y se salta RLS. Si cualquiera puede llamarla y no está bien acotada, puede filtrar o modificar datos.',
        why: 'Revísala: fija el search_path, valida las entradas y restringe quién puede ejecutarla.',
      },
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
