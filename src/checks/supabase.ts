import type { Finding } from '../core/types.js';
import { openPolicyFinding, type PolicyCommand } from './migrations.js';
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
  /**
   * Database functions the public key may call, read from the same OpenAPI document as the
   * tables. PostgREST lists only what the requesting role can execute, so this is the list of
   * functions anyone on the internet can run. Absent on an export or an older caller.
   */
  rpcs?: string[];
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

/**
 * The functions in the same document: `/rpc/<name>` paths. PostgREST builds the document for
 * the role that asked, so with the public key these are the functions any visitor can call.
 * Pure — no network.
 */
export function parseOpenApiRpcs(body: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return [];
  }
  const paths = asRecord(asRecord(doc)?.paths);
  if (!paths) return [];
  return Object.keys(paths)
    .map((p) => /^\/rpc\/([^/]+)$/.exec(p)?.[1])
    .filter((n): n is string => Boolean(n))
    .sort();
}

/** Enumerates the tables and functions the anon key can see via the PostgREST OpenAPI root. */
async function enumerateApi(
  projectUrl: string,
  key: string,
  timeout: number,
): Promise<{ tables: string[]; rpcs: string[] }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${projectUrl}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { tables: [], rpcs: [] };
    const body = await res.text();
    return { tables: parseOpenApiTables(body), rpcs: parseOpenApiRpcs(body) };
  } catch {
    return { tables: [], rpcs: [] };
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
  const api = tables ? { tables, rpcs: [] } : await enumerateApi(projectUrl, anonKey, timeout);
  const discovered = api.tables;
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
    rpcs: api.rpcs,
  };
}

/** A function whose name says it runs the SQL it is given. Splinter 0031, seen from outside. */
const RUNS_SQL =
  /^(?:exec(?:ute)?_?(?:sql|query|raw)|run_?(?:sql|query)|raw_?sql|sql(?:_query|_exec)?|query_?sql|eval_?sql|exec)$/i;

/**
 * Functions any visitor can call whose name says they run arbitrary SQL. Only the name is
 * known — calling one to find out would be the attack — so the label says "named like", and
 * the migration rule (`dynamic_sql_*`) is what reads the body when the code is at hand.
 */
export function rpcFindings(rpcs: string[], projectUrl: string): Finding[] {
  return rpcs
    .filter((name) => RUNS_SQL.test(name))
    .map((name) => ({
      id: `rpc_runs_sql_${name}`,
      label: `Anyone can call \`${name}()\`, a database function named like it runs SQL`,
      severity: 'high' as const,
      check: 10,
      cwe: 'CWE-89',
      source: `${projectUrl}/rest/v1/rpc/${name}`,
      evidence: `/rpc/${name} is listed for the public key in the API's OpenAPI document`,
      exploit:
        'If it does what its name says, the public key in your app runs any SQL: read every table, drop them, or grant itself more. It was not called to check — that would be the attack.',
      why:
        'Revoke EXECUTE from `anon` and `authenticated` (`revoke execute on function public.' +
        name +
        ' from anon, authenticated;`), or move it out of the `public` schema. A function that runs whatever text it receives should not be reachable from the browser at all.',
      references: [
        'https://supabase.com/docs/guides/database/database-advisors?lint=0031_dynamic_sql_in_function',
        'https://cwe.mitre.org/data/definitions/89.html',
      ],
      es: {
        label: `Cualquiera puede llamar a \`${name}()\`, una función de la base de datos con nombre de ejecutar SQL`,
        evidence: `/rpc/${name} aparece para la clave pública en el documento OpenAPI de la API`,
        exploit:
          'Si hace lo que dice su nombre, la clave pública de tu app ejecuta cualquier SQL: leer todas las tablas, borrarlas o darse más permisos. No se llamó para comprobarlo: eso sería el ataque.',
        why:
          'Quita EXECUTE a `anon` y `authenticated` (`revoke execute on function public.' +
          name +
          ' from anon, authenticated;`), o sácala del esquema `public`. Una función que ejecuta el texto que recibe no debería poder llamarse desde el navegador.',
      },
    }));
}

/** What `GET /auth/v1/settings` says about who can get a session. */
export interface AuthSettings {
  disableSignup: boolean;
  mailerAutoconfirm: boolean;
  phoneAutoconfirm: boolean;
  anonymousUsers: boolean;
  email: boolean;
  phone: boolean;
}

/**
 * Parses Supabase Auth's public settings document. The field names are the ones its source
 * declares (`internal/api/settings.go`); anything that does not carry them is not that
 * document, and is ignored rather than read as "everything off".
 */
export function parseAuthSettings(body: string): AuthSettings | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  const root = asRecord(doc);
  const external = asRecord(root?.external);
  if (!root || !external || typeof root.disable_signup !== 'boolean') return null;
  return {
    disableSignup: root.disable_signup,
    mailerAutoconfirm: root.mailer_autoconfirm === true,
    phoneAutoconfirm: root.phone_autoconfirm === true,
    anonymousUsers: external.anonymous_users === true,
    email: external.email === true,
    phone: external.phone === true,
  };
}

/** Reads the settings with the public key, the way the app's own sign-up form does. */
export async function fetchAuthSettings(
  projectUrl: string,
  key: string,
  timeout = 10000,
): Promise<AuthSettings | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${projectUrl}/auth/v1/settings`, {
      headers: { apikey: key, Accept: 'application/json' },
      signal: controller.signal,
    });
    return res.ok ? parseAuthSettings(await res.text()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Who can become `authenticated`. Nothing here is wrong on its own — a public sign-up is how
 * most apps work — but every policy written `to authenticated using (true)` means exactly as
 * much as this says. With anonymous sign-ins on, that is everyone, without even an email.
 */
export function authSettingsFindings(s: AuthSettings, projectUrl: string): Finding[] {
  if (s.disableSignup) return [];
  const findings: Finding[] = [];
  const source = `${projectUrl}/auth/v1/settings`;

  if (s.anonymousUsers) {
    findings.push({
      id: 'supabase_anonymous_signins',
      label: 'Anonymous sign-ins are on: anyone gets the `authenticated` role without an email',
      severity: 'medium',
      check: 7,
      cwe: 'CWE-287',
      source,
      evidence: '"external": { "anonymous_users": true }, "disable_signup": false',
      exploit:
        "One call to sign in anonymously returns a session with the `authenticated` role. Every policy that only checks that role — `to authenticated using (true)`, `auth.role() = 'authenticated'` — is open to anyone who makes that call.",
      why: "If the app needs guests, make every policy that guests must not pass check `(auth.jwt() ->> 'is_anonymous')::boolean is false`, and turn on CAPTCHA for sign-ins. If it does not, turn anonymous sign-ins off in Authentication → Sign In / Providers.",
      references: ['https://supabase.com/docs/guides/auth/auth-anonymous'],
      es: {
        label:
          'Los inicios de sesión anónimos están activados: cualquiera obtiene el rol `authenticated` sin correo',
        exploit:
          "Una sola llamada para iniciar sesión de forma anónima devuelve una sesión con el rol `authenticated`. Toda política que solo mira ese rol (`to authenticated using (true)`, `auth.role() = 'authenticated'`) queda abierta para quien haga esa llamada.",
        why: "Si la app necesita invitados, haz que cada política que un invitado no deba pasar compruebe `(auth.jwt() ->> 'is_anonymous')::boolean is false`, y activa el CAPTCHA en el inicio de sesión. Si no los necesita, desactiva los inicios anónimos en Authentication → Sign In / Providers.",
      },
    });
  }

  const autoconfirm = (s.email && s.mailerAutoconfirm) || (s.phone && s.phoneAutoconfirm);
  if (autoconfirm) {
    const what = s.email && s.mailerAutoconfirm ? 'email' : 'phone';
    findings.push({
      id: 'supabase_signup_autoconfirm',
      label: `Anyone can sign up with an unverified ${what} and is signed in at once`,
      severity: 'low',
      check: 7,
      cwe: 'CWE-287',
      source,
      evidence:
        what === 'email'
          ? '"mailer_autoconfirm": true, "disable_signup": false'
          : '"phone_autoconfirm": true, "disable_signup": false',
      exploit:
        'Sign-ups are confirmed without proving the address belongs to the person. Anyone can open accounts in bulk, or in someone else’s name, and each one passes every policy that only checks `authenticated`.',
      why: 'Turn on "Confirm email" in Authentication → Providers → Email (set up your own SMTP if the default emails were the reason it was turned off), and write policies that check whose row it is, not only that someone is signed in.',
      references: ['https://supabase.com/docs/guides/auth/general-configuration'],
      es: {
        label:
          what === 'email'
            ? 'Cualquiera puede registrarse con un correo sin verificar y entra de inmediato'
            : 'Cualquiera puede registrarse con un teléfono sin verificar y entra de inmediato',
        exploit:
          'Los registros se confirman sin probar que la dirección sea de la persona. Cualquiera puede abrir cuentas en masa, o a nombre de otro, y cada una pasa toda política que solo mira `authenticated`.',
        why: 'Activa "Confirm email" en Authentication → Providers → Email (configura tu propio SMTP si lo apagaste porque no llegaban los correos), y escribe políticas que comprueben de quién es la fila, no solo que haya sesión.',
      },
    });
  }
  return findings;
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
    select coalesce(jsonb_agg(jsonb_build_object('table', tablename, 'policy', policyname, 'cmd', cmd, 'roles', roles)), '[]'::jsonb)
    from pg_policies where schemaname = 'public' and permissive = 'PERMISSIVE'
      and cmd <> 'INSERT' and coalesce(qual, 'true') = 'true'
  ),
  'security_definer_functions', (
    select coalesce(jsonb_agg(jsonb_build_object('function', p.proname) order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef = true
  )
)) as vibeward_audit;`;

interface SupabaseExport {
  tables_without_rls?: { table: string }[];
  /** `cmd` and `roles` arrived with 0.8.0; an export from an older query carries neither. */
  permissive_policies?: { table: string; policy: string; cmd?: string; roles?: string[] }[];
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
    // An export from the query before 0.8.0 has no command and could not tell an INSERT
    // policy (which never has USING) from an open one. Read it as the worst case it claimed.
    const cmd = (p.cmd ?? 'ALL').toLowerCase();
    const finding = openPolicyFinding({
      table: p.table,
      policy: p.policy,
      command: (['select', 'insert', 'update', 'delete'].includes(cmd)
        ? cmd
        : 'all') as PolicyCommand,
      roles: (p.roles?.length ? p.roles : ['public']).map((r) => r.toLowerCase()),
      source: `supabase:public.${p.table}`,
      evidence: `Policy "${p.policy}" (${p.cmd ?? 'command not exported'}) has USING (true)`,
    });
    if (finding) findings.push(finding);
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
