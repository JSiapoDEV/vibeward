import type { Finding, Severity } from '../core/types.js';
import {
  bareName,
  blankComments,
  blankLiterals,
  closingParen,
  cutAtKeyword,
  dropCalls,
  isTextType,
  lineAt,
  literalText,
  parseFunctions,
  splitTopLevel,
  statementEnd,
  type SqlFunction,
} from './sql-text.js';

export interface SqlFile {
  path: string;
  content: string;
}

const LINTER = 'https://supabase.com/docs/guides/database/database-linter?lint=';

// ─── Dynamic SQL a caller writes ────────────────────────────────────────────────────────────
//
// PostgREST serves every function in the exposed schema at `/rest/v1/rpc/<name>`, so a
// PL/pgSQL function that pastes one of its text arguments into an `EXECUTE` hands whoever holds
// the anon key a SQL console. The three safe ways to get a value into dynamic SQL are passing
// it with `USING`, quoting it with `quote_ident`/`quote_literal`/`quote_nullable`, and
// `format()` with `%I` or `%L`. Everything else that mentions the argument is the injection.

const EXECUTE = /\bexecute\b(?!\s+(?:function|procedure)\b)/gi;
const ASSIGNMENT = /(?<![\w.$])([a-z_]\w*)\s*:=/gi;
const SAFE_QUOTING = ['quote_ident', 'quote_literal', 'quote_nullable'];
const FORMAT_CALL = /\bformat\s*\(/gi;
const FORMAT_SPEC = /%(?:(\d+)\$)?-?\d*([sIL%])/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first of `names` that `sql` uses outside a literal and outside a quoting call. */
function mentions(sql: string, names: string[]): string | null {
  const plain = blankLiterals(dropCalls(sql, SAFE_QUOTING)).toLowerCase();
  for (const n of names) {
    const re = n.startsWith('$')
      ? new RegExp(`${escapeRe(n)}(?!\\d)`)
      : new RegExp(`(?<![\\w.$"])${escapeRe(n)}(?![\\w$])`);
    if (re.test(plain)) return n;
  }
  return null;
}

/**
 * The first of `names` that reaches `expr` unquoted. `format()` is read spec by spec: an
 * argument bound to `%I` or `%L` is quoted by Postgres, one bound to `%s` is pasted in as-is.
 */
function unsafeReference(expr: string, names: string[]): string | null {
  let rest = expr;
  for (;;) {
    FORMAT_CALL.lastIndex = 0;
    const m = FORMAT_CALL.exec(rest);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = closingParen(rest, open);
    const args = splitTopLevel(rest.slice(open + 1, close));
    const fmt = literalText(args[0] ?? '');
    if (fmt === null) {
      // The template itself is not a literal, so its specs cannot be read: any argument that
      // mentions the input counts, and so does the template.
      for (const a of args) {
        const hit = mentions(a, names);
        if (hit) return hit;
      }
    } else {
      let next = 1;
      FORMAT_SPEC.lastIndex = 0;
      let s: RegExpExecArray | null;
      while ((s = FORMAT_SPEC.exec(fmt)) !== null) {
        if (s[2] === '%') continue;
        const pos = s[1] ? Number(s[1]) : next;
        next = pos + 1;
        if (s[2] !== 's') continue;
        const hit = mentions(args[pos] ?? '', names);
        if (hit) return hit;
      }
    }
    rest = `${rest.slice(0, m.index)}''${rest.slice(close + 1)}`;
  }
  return mentions(rest, names);
}

/** Roles each function has had EXECUTE revoked from, keyed by bare function name. */
function revokedRoles(files: SqlFile[]): {
  byFunction: Map<string, Set<string>>;
  bySchema: Map<string, Set<string>>;
} {
  const byFunction = new Map<string, Set<string>>();
  const bySchema = new Map<string, Set<string>>();
  const roles = (list: string) =>
    list
      .replace(/\b(?:cascade|restrict)\b/gi, '')
      .split(',')
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean);
  const add = (map: Map<string, Set<string>>, key: string, list: string) => {
    const set = map.get(key) ?? new Set<string>();
    for (const r of roles(list)) set.add(r);
    map.set(key, set);
  };
  for (const { content } of files) {
    const text = blankComments(content);
    const one =
      /revoke\s+(?:execute|all(?:\s+privileges)?)\s+on\s+function\s+((?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)[^;]*?\s+from\s+([^;]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = one.exec(text)) !== null) add(byFunction, bareName(m[2]) ?? '', m[3]!);
    const all =
      /revoke\s+(?:execute|all(?:\s+privileges)?)\s+on\s+all\s+functions\s+in\s+schema\s+("[^"]+"|\w+)\s+from\s+([^;]+)/gi;
    while ((m = all.exec(text)) !== null) add(bySchema, bareName(m[1]) ?? '', m[2]!);
  }
  return { byFunction, bySchema };
}

function dynamicSqlFinding(
  fn: SqlFunction,
  path: string,
  content: string,
  at: number,
  statement: string,
  revoked: Set<string>,
): Finding {
  const exposedSchema = (fn.schema ?? 'public') === 'public';
  const anon = exposedSchema && !revoked.has('anon');
  const signedIn = exposedSchema && !revoked.has('authenticated');
  const severity: Severity = fn.securityDefiner
    ? anon
      ? 'critical'
      : signedIn
        ? 'high'
        : 'medium'
    : anon || signedIn
      ? 'high'
      : 'medium';
  const who = anon
    ? 'anyone holding the anon key, which ships in the browser bundle,'
    : signedIn
      ? 'any signed-in user'
      : 'whoever can call it';
  const quien = anon
    ? 'cualquiera con la clave anon, que viaja en el bundle del navegador,'
    : signedIn
      ? 'cualquier usuario con sesión'
      : 'quien pueda llamarla';
  const rights = fn.securityDefiner
    ? 'As SECURITY DEFINER it runs with its owner’s rights, so RLS does not apply to what it executes.'
    : 'It runs with the caller’s rights, so RLS still applies — but the caller chooses the statement.';
  const derechos = fn.securityDefiner
    ? 'Como SECURITY DEFINER se ejecuta con los derechos de su propietario, así que RLS no se aplica a lo que ejecuta.'
    : 'Se ejecuta con los derechos de quien la llama, así que RLS sigue aplicando — pero quien llama elige la sentencia.';
  return {
    id: `dynamic_sql_${fn.name}`,
    es: {
      label: `La función \`${fn.name}\` ejecuta SQL armado con lo que envía quien la llama`,
      exploit: `PostgREST publica las funciones del esquema expuesto en \`/rest/v1/rpc/${fn.name}\`, y ${quien} puede llamarla con un texto que termina dentro del SQL que ejecuta. ${derechos}`,
      impact:
        'Una función así es una consola SQL remota para quien la encuentre: leer, cambiar o borrar datos queda a una petición de distancia.',
      why: 'Los valores tienen que llegar al SQL dinámico como parámetros (`EXECUTE … USING`) o entrecomillados: `format()` con `%I` para nombres y `%L` para valores, o `quote_ident()` / `quote_literal()`. Una función que ejecuta el texto que recibe no debería estar en un esquema expuesto; si existe para migraciones, quítale EXECUTE a `anon` y `authenticated`.',
    },
    label: `Function \`${fn.name}\` runs SQL built from what its caller sends`,
    severity,
    check: 10,
    cwe: 'CWE-89',
    source: `${path}:${lineAt(content, at)}`,
    evidence: `EXECUTE ${statement.replace(/\s+/g, ' ').trim()}`.slice(0, 160),
    exploit: `PostgREST serves functions in the exposed schema at \`/rest/v1/rpc/${fn.name}\`, and ${who} can call this one with text that ends up inside the SQL it executes. ${rights}`,
    impact:
      'A function like this is a remote SQL console for whoever finds it: reading, changing or deleting data is one request away.',
    why: 'Values have to reach dynamic SQL as parameters (`EXECUTE … USING`) or quoted — `format()` with `%I` for names and `%L` for values, or `quote_ident()` / `quote_literal()`. A function that executes the text it is given should not live in an exposed schema; if it exists for migrations, revoke EXECUTE from `anon` and `authenticated`.',
    references: [
      `${LINTER}0031_anon_dynamic_sql_function_executable`,
      'https://www.postgresql.org/docs/current/plpgsql-statements.html#PLPGSQL-STATEMENTS-EXECUTING-DYN',
    ],
  };
}

function analyzeDynamicSql(files: SqlFile[], revoked: ReturnType<typeof revokedRoles>): Finding[] {
  const findings: Finding[] = [];
  for (const { path, content } of files) {
    for (const fn of parseFunctions(content)) {
      if (fn.language !== null && fn.language !== 'plpgsql') continue;
      const names = fn.params
        .filter((p) => isTextType(p.type))
        .flatMap((p) => (p.name ? [p.name, `$${p.pos}`] : [`$${p.pos}`]));
      if (names.length === 0) continue;
      const body = fn.body.toLowerCase();

      // One level of indirection is how most of these are written: build the string in a
      // variable, then execute the variable. Two passes catch a variable built from another.
      for (let pass = 0; pass < 2; pass++) {
        ASSIGNMENT.lastIndex = 0;
        let a: RegExpExecArray | null;
        while ((a = ASSIGNMENT.exec(body)) !== null) {
          const start = a.index + a[0].length;
          const expr = body.slice(start, statementEnd(body, start));
          if (!names.includes(a[1]!) && unsafeReference(expr, names)) names.push(a[1]!);
        }
      }

      EXECUTE.lastIndex = 0;
      let e: RegExpExecArray | null;
      while ((e = EXECUTE.exec(body)) !== null) {
        const start = e.index + e[0].length;
        const statement = fn.body.slice(start, statementEnd(body, start));
        if (!unsafeReference(cutAtKeyword(statement.toLowerCase(), ['using', 'into']), names)) {
          continue;
        }
        const roles = new Set([
          ...(revoked.byFunction.get(fn.name) ?? []),
          ...(revoked.bySchema.get(fn.schema ?? 'public') ?? []),
        ]);
        findings.push(
          dynamicSqlFinding(fn, path, content, fn.bodyStart + e.index, statement, roles),
        );
        break;
      }
    }
  }
  return findings;
}

// ─── Policies that trust what the user wrote about themselves ──────────────────────────────
//
// `user_metadata` (`raw_user_meta_data` in `auth.users`) is whatever the user last sent to
// `supabase.auth.updateUser({ data })`. A policy keyed on a role or a tenant stored there grants
// it to anyone who types it. `app_metadata` is the server-only twin and is fine.

const POLICY_HEAD =
  /\b(?:create|alter)\s+policy\s+("[^"]+"|\w+)\s+on\s+((?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)/gi;
const USER_METADATA = /user_metadata|raw_user_meta_data/i;

function analyzeUserMetadataPolicies(files: SqlFile[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const { path, content } of files) {
    const text = blankComments(content);
    POLICY_HEAD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = POLICY_HEAD.exec(text)) !== null) {
      const statement = text.slice(m.index, statementEnd(text, m.index));
      const hit = USER_METADATA.exec(statement);
      if (!hit) continue;
      const table = bareName(m[3]) ?? '';
      const policy = bareName(m[1]) ?? '';
      if (seen.has(`${table}/${policy}`)) continue;
      seen.add(`${table}/${policy}`);
      // Quote from the clause that holds the reference, so the evidence reads as SQL rather
      // than starting in the middle of the policy's name.
      const flat = statement.replace(/\s+/g, ' ');
      const at = flat.search(USER_METADATA);
      const clause = flat
        .slice(0, at)
        .search(/\b(?:using|with\s+check)\s*\((?![\s\S]*\b(?:using|with\s+check)\s*\()/i);
      const from = clause >= 0 ? clause : Math.max(0, at - 60);
      const quoted = flat.slice(from, from + 140).trim();
      findings.push({
        id: `rls_user_metadata_${table}`,
        es: {
          label: `Una política de \`${table}\` confía en \`user_metadata\`, que cada usuario puede editar`,
          exploit:
            'Cualquier usuario con sesión puede cambiar su propio `user_metadata` desde el navegador con `supabase.auth.updateUser({ data: { … } })`. Una política que concede acceso según un valor guardado ahí — un rol, un tenant, un plan — se lo concede a quien escriba ese valor.',
          impact: `Un usuario que se ponga \`role: admin\` (o el id de otro tenant) en sus metadatos pasa la política \`${policy}\`.`,
          why: 'Lee la autorización de `app_metadata`, que solo el servidor puede escribir, o de una tabla que los usuarios no pueden actualizar.',
        },
        label: `A policy on \`${table}\` trusts \`user_metadata\`, which each user can edit`,
        severity: 'high',
        check: 7,
        cwe: 'CWE-639',
        source: `${path}:${lineAt(content, m.index)}`,
        evidence: `policy ${m[1]} on ${table}: ${quoted}${from + 140 < flat.length ? '…' : ''}`,
        exploit:
          'Any signed-in user can change their own `user_metadata` from the browser with `supabase.auth.updateUser({ data: { … } })`. A policy that grants access based on a value stored there — a role, a tenant, a plan — grants it to whoever writes that value.',
        impact: `A user who sets \`role: admin\` (or another tenant’s id) in their own metadata passes the \`${policy}\` policy.`,
        why: 'Read authorization from `app_metadata`, which only the server can write, or from a table users cannot update.',
        references: [`${LINTER}0015_rls_references_user_metadata`],
        meta: { table },
      });
    }
  }
  return findings;
}

// ─── Views that read with their owner's rights ─────────────────────────────────────────────
//
// A view runs with the rights of whoever created it unless it says `security_invoker = true`
// (Postgres 15+). PostgREST serves a view in the exposed schema like a table, so the anon key
// reads through it every row the underlying RLS would have hidden.

const CREATE_VIEW =
  /\bcreate\s+(?:or\s+replace\s+)?(temp(?:orary)?\s+)?(?:recursive\s+)?view\s+((?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)/gi;
const ALTER_VIEW =
  /\balter\s+view\s+(?:if\s+exists\s+)?((?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)\s+set\s*\(([^)]*)\)/gi;

function invokerOn(options: string): boolean {
  const m = /security_invoker\s*(?:=\s*'?(\w+)'?)?/i.exec(options);
  return Boolean(m) && !/^(?:false|off|0|no)$/i.test(m?.[1] ?? 'true');
}

interface ViewDecl {
  name: string;
  path: string;
  line: number;
  readsAuthUsers: boolean;
  evidence: string;
}

function analyzeViews(files: SqlFile[], flagAll: boolean): Finding[] {
  const views = new Map<string, ViewDecl>();
  const invoker = new Set<string>();
  for (const { path, content } of files) {
    const text = blankComments(content);
    let m: RegExpExecArray | null;
    CREATE_VIEW.lastIndex = 0;
    while ((m = CREATE_VIEW.exec(text)) !== null) {
      if (m[1]) continue; // a temporary view lives for one session and is never served
      const schema = bareName(m[2]);
      if (schema && schema !== 'public') continue;
      const name = bareName(m[3]) ?? '';
      const statement = text.slice(m.index, statementEnd(text, m.index));
      const head = statement.slice(m[0].length);
      const options = /^\s*(?:\([^)]*\)\s*)?with\s*\(([^)]*)\)/i.exec(head)?.[1] ?? '';
      if (invokerOn(options)) {
        invoker.add(name);
        continue;
      }
      invoker.delete(name);
      views.set(name, {
        name,
        path,
        line: lineAt(content, m.index),
        readsAuthUsers: /\bauth\s*\.\s*"?users"?\b/i.test(statement),
        evidence: statement.replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    }
    ALTER_VIEW.lastIndex = 0;
    while ((m = ALTER_VIEW.exec(text)) !== null) {
      const schema = bareName(m[1]);
      if (schema && schema !== 'public') continue;
      if (invokerOn(m[3]!)) invoker.add(bareName(m[2]) ?? '');
    }
  }

  const findings: Finding[] = [];
  for (const v of views.values()) {
    if (invoker.has(v.name)) continue;
    if (v.readsAuthUsers) {
      // `auth.users` exists only in Supabase, so this one needs no other evidence of the stack.
      findings.push({
        id: `view_exposes_auth_users_${v.name}`,
        es: {
          label: `La vista \`${v.name}\` publica \`auth.users\` en la API`,
          exploit:
            'La vista se ejecuta con los derechos de quien la creó, que sí puede leer `auth.users`, y PostgREST la sirve como una tabla más del esquema expuesto. La clave anon del navegador lee a través de ella las cuentas de todos los usuarios.',
          impact:
            'Correos, teléfonos y metadatos de inicio de sesión de cada cuenta quedan legibles para cualquier visitante.',
          why: 'No expongas `auth.users`. Guarda lo que la app necesita mostrar en una tabla propia (por ejemplo `profiles`) con RLS, o crea la vista `with (security_invoker = true)` fuera del esquema `public`.',
        },
        label: `View \`${v.name}\` exposes \`auth.users\` through the API`,
        severity: 'critical',
        check: 6,
        cwe: 'CWE-200',
        source: `${v.path}:${v.line}`,
        evidence: v.evidence,
        exploit:
          'The view runs with the rights of whoever created it, who can read `auth.users`, and PostgREST serves it like any other table in the exposed schema. The anon key from the browser reads every user account through it.',
        impact:
          'Every account’s email, phone and sign-in metadata becomes readable by any visitor.',
        why: 'Do not expose `auth.users`. Keep what the app needs to show in a table of its own (such as `profiles`) with RLS, or create the view `with (security_invoker = true)` outside the `public` schema.',
        references: [`${LINTER}0002_auth_users_exposed`],
      });
      continue;
    }
    if (!flagAll) continue;
    findings.push({
      id: `view_bypasses_rls_${v.name}`,
      es: {
        label: `La vista \`${v.name}\` lee sus tablas con los derechos de su dueño y se salta RLS`,
        exploit:
          'Una vista del esquema expuesto se ejecuta con los derechos de quien la creó salvo que se cree `with (security_invoker = true)`. PostgREST la sirve como una tabla, así que la clave anon lee a través de ella las filas que RLS habría ocultado en las tablas de origen.',
        why: 'Crea la vista con `security_invoker = true` (Postgres 15+) para que aplique el RLS de quien consulta, o sácala del esquema expuesto.',
      },
      label: `View \`${v.name}\` reads its tables with its owner’s rights, skipping RLS`,
      severity: 'high',
      check: 6,
      cwe: 'CWE-863',
      source: `${v.path}:${v.line}`,
      evidence: v.evidence,
      exploit:
        'A view in the exposed schema runs with the rights of whoever created it unless it is created `with (security_invoker = true)`. PostgREST serves it like a table, so the anon key reads through it the rows that RLS would have hidden in the underlying tables.',
      why: 'Create the view with `security_invoker = true` (Postgres 15+) so it applies the RLS of whoever queries it, or move it out of the exposed schema.',
      references: [`${LINTER}0010_security_definer_view`],
    });
  }
  return findings;
}

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["'`]?(\w+)["'`]?/gi;
const ENABLE_RLS =
  /alter\s+table\s+(?:public\.)?["'`]?(\w+)["'`]?\s+enable\s+row\s+level\s+security/gi;
/**
 * Turning protection off on a table that already has it. Distinct from `CREATE TABLE` without
 * RLS: that is a gap someone left, this is a decision someone made, and it is the exact shape
 * of "just disable RLS so the query works". A table can only be disabled if it was protected,
 * so this is always a regression and never a starting state.
 */
/**
 * Every form the real tools emit. `ALTER TABLE ONLY "public"."profiles"` is what `pg_dump`
 * writes, `IF EXISTS` is what a defensive migration writes, and a quoted schema is what
 * Supabase Studio writes — a pattern that only handled the bare `public.` prefix missed all
 * three, which between them cover most migrations that are not typed by hand.
 */
const QUALIFIED = '(?:["\'`]?\\w+["\'`]?\\s*\\.\\s*)?["\'`]?(\\w+)["\'`]?';
const DISABLE_RLS = new RegExp(
  `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QUALIFIED}\\s+disable\\s+row\\s+level\\s+security`,
  'gi',
);

/**
 * Dropping a policy leaves RLS enabled and matching nothing, which denies everyone — or, if it
 * was the last policy on a table someone then "fixes" by disabling RLS, opens everything.
 *
 * The policy name accepts a quoted string with spaces, because that is Supabase's own default:
 * the dashboard names policies things like `"Enable read access for all users"`, and a
 * name pattern that stopped at the first space could not match a single one of them.
 */
const DROP_POLICY = new RegExp(
  `drop\\s+policy\\s+(?:if\\s+exists\\s+)?(?:"[^"]+"|'[^']+'|\`[^\`]+\`|[\\w-]+)\\s+on\\s+(?:only\\s+)?${QUALIFIED}`,
  'gi',
);

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
 * `USING (true)` policies, SECURITY DEFINER functions, anon/public grants, functions that
 * execute SQL built from their text arguments, policies that read `user_metadata`, and views
 * that expose `auth.users` always;
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

    DISABLE_RLS.lastIndex = 0;
    while ((m = DISABLE_RLS.exec(content)) !== null) {
      const name = m[1]!.toLowerCase();
      findings.push({
        id: `rls_turned_off_${name}`,
        es: {
          label: `Row Level Security se apaga en \`${name}\``,
          exploit:
            'En cuanto RLS se apaga, todas las políticas de la tabla dejan de aplicarse y la tabla entera queda legible — y a menudo escribible — por la API REST pública con la clave anon que viaja en el bundle del navegador.',
          impact: `Todas las filas de \`${name}\` quedan expuestas a cualquiera que abra el sitio y mire su tráfico de red. Si la tabla guarda datos de usuarios, es una fuga de datos en curso desde que se aplicó la migración.`,
          why: 'Desactivar RLS es el reflejo habitual cuando una consulta no devuelve filas, porque hace desaparecer el error. El error era la protección funcionando: el arreglo es una política que case con las filas previstas, por ejemplo `USING (auth.uid() = user_id)`.',
        },
        label: `Row Level Security is switched off on \`${name}\``,
        severity: 'critical',
        check: 6,
        cwe: 'CWE-863',
        source: `${path}:${lineAt(content, m.index)}`,
        evidence: m[0].replace(/\s+/g, ' '),
        exploit:
          'Once RLS is off, every policy on the table stops applying and the whole table is readable — and often writable — through the public REST API with the anon key that ships in the browser bundle.',
        impact: `Every row of \`${name}\` is exposed to anyone who opens the site and reads its network traffic. If the table holds user data, this is a live data leak for as long as the migration has been applied.`,
        why: 'Disabling RLS is the usual reflex when a query returns no rows, because it makes the error go away. The error was the protection working: the fix is a policy that matches the intended rows, such as `USING (auth.uid() = user_id)`.',
        references: ['https://supabase.com/docs/guides/database/postgres/row-level-security'],
        meta: { table: name },
      });
    }

    DROP_POLICY.lastIndex = 0;
    while ((m = DROP_POLICY.exec(content)) !== null) {
      const name = m[1]!.toLowerCase();
      findings.push({
        id: `policy_dropped_${name}`,
        es: {
          label: `Se elimina una política de \`${name}\``,
          exploit:
            'Una tabla con RLS activada y sin políticas no casa con nada y se lo deniega a todo el mundo, lo que se lee como una app rota — y el siguiente paso habitual es desactivar RLS en lugar de volver a escribir la política.',
          why: 'Eliminar una política solo es seguro si queda otra que conceda el acceso que la aplicación necesita. Comprueba qué queda en la tabla antes de aplicar esto.',
        },
        label: `A policy is dropped from \`${name}\``,
        severity: 'medium',
        check: 6,
        cwe: 'CWE-863',
        source: `${path}:${lineAt(content, m.index)}`,
        evidence: m[0].replace(/\s+/g, ' '),
        exploit:
          'A table with RLS enabled and no policies matches nothing and denies everyone, which reads as a broken app — and the usual next step is to disable RLS rather than to write the policy back.',
        why: 'Dropping a policy is only safe when another one still grants the access the app needs. Check what remains on the table before applying this.',
        references: ['https://supabase.com/docs/guides/database/postgres/row-level-security'],
        meta: { table: name },
      });
    }

    PERMISSIVE_POLICY.lastIndex = 0;
    while ((m = PERMISSIVE_POLICY.exec(content)) !== null) {
      findings.push({
        id: 'permissive_policy',
        es: {
          label: 'Una política de Row Level Security permite a todo el mundo (`USING (true)`)',
          exploit:
            'Una política con `USING (true)` casa con todas las filas para todos los usuarios, así que RLS está desactivada de hecho en esta tabla.',
          why: 'La política existe pero concede acceso a todo el mundo. Filtra por el propietario, por ejemplo `auth.uid() = user_id`.',
        },
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
        es: {
          label: 'Una función se ejecuta como su propietario (`SECURITY DEFINER`)',
          exploit:
            'Una función SECURITY DEFINER se ejecuta con los privilegios de quien la definió, saltándose RLS. Si cualquiera puede llamarla y no está bien acotada, puede filtrar o modificar datos.',
          why: 'Revisa cada función SECURITY DEFINER: fija el `search_path`, valida las entradas y restringe quién puede ejecutarla.',
        },
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
        es: {
          label: `La tabla \`${m[2]}\` concede acceso ${writes ? 'de escritura ' : ''}al rol ${m[3]!.toLowerCase()}`,
          exploit: writes
            ? 'Conceder INSERT/UPDATE/DELETE a anon permite que cualquier visitante sin autenticar escriba en la tabla por la API REST pública, incluso con RLS activada si ninguna política WITH CHECK lo limita.'
            : 'Conceder privilegios de tabla al rol anon/public amplía lo que puede alcanzar un llamante sin autenticar.',
        },
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

  findings.push(...analyzeDynamicSql(files, revokedRoles(files)));
  findings.push(...analyzeUserMetadataPolicies(files));
  findings.push(...analyzeViews(files, flagMissingRls));

  for (const [name, loc] of created) {
    if (flagMissingRls && !rlsEnabled.has(name)) {
      findings.push({
        id: `rls_disabled_${name}`,
        es: {
          label: `La tabla \`${name}\` se crea sin Row Level Security`,
          evidence: `No se encontró ningún \`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY\` en las migraciones`,
          exploit:
            'Con RLS desactivada, la tabla es accesible por la API pública usando la clave anon — cualquier visitante puede leer (y posiblemente escribir) sus filas.',
          why: 'Toda tabla con datos de usuarios debe activar RLS y añadir políticas acotadas al propietario. Sin RLS, las políticas no hacen nada.',
        },
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
