// Self-test with SYNTHETIC data (no real secrets). Validates detection logic
// without touching any external system. Run with: npm test
import {
  scanText,
  scanSource,
  scanReturnedData,
  extractSupabaseConfig,
} from '../src/checks/secrets.js';
import { checkHeaders } from '../src/checks/headers.js';
import { buildReport } from '../src/reporters/markdown.js';
import { analyzeMigrations } from '../src/checks/migrations.js';
import {
  analyzeSupabaseExport,
  parseOpenApiTables,
  graphqlIntrospectionFinding,
} from '../src/checks/supabase.js';
import { toSarif } from '../src/reporters/sarif.js';
import { scanIntent } from '../src/checks/intent.js';
import { resolveSourceMapUrl, sourceMapFinding } from '../src/checks/sourcemaps.js';
import { extractFirebaseConfig, firebaseStorageFinding } from '../src/checks/firebase.js';
import {
  checkNextConfigHeaders,
  checkServerActionAuth,
  checkExportFormulaInjection,
} from '../src/checks/backend.js';

let pass = 0;
let fail = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

// Synthetic JWTs: header + payload with a controlled role + dummy signature.
function fakeJwt(role: string): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase', ref: 'x'.repeat(20) })}.${'s'.repeat(43)}`;
}

console.log('\n1. Secret detection');
{
  const serviceJwt = fakeJwt('service_role');
  const anonJwt = fakeJwt('anon');

  assert(
    scanText(`const key = "${serviceJwt}"`, 'bundle.js').some(
      (f) => f.id === 'supabase_service_role',
    ),
    'detects service_role JWT',
  );
  assert(
    !scanText(`const key = "${anonJwt}"`, 'bundle.js').some(
      (f) => f.id === 'supabase_service_role',
    ),
    'does NOT flag anon JWT',
  );
  assert(
    scanText(`stripe = "sk_live_${'a'.repeat(30)}"`, 'b.js').some((f) => f.id === 'stripe_secret'),
    'detects Stripe secret key',
  );
  assert(
    scanText(`const k = "sk-proj-${'a'.repeat(40)}"`, 'b.js').some((f) => f.id === 'openai_key'),
    'detects OpenAI key',
  );
  assert(
    scanText(`aws = "AKIA${'A'.repeat(16)}"`, 'b.js').some((f) => f.id === 'aws_access_key'),
    'detects AWS access key',
  );
  assert(
    scanText(`token = "ghp_${'a'.repeat(36)}"`, 'b.js').some((f) => f.id === 'github_token'),
    'detects GitHub token',
  );
  assert(
    !scanText(`api_key = "your_api_key_here"`, 'b.js').some(
      (f) => f.id === 'generic_secret_assign',
    ),
    'ignores placeholder "your_api_key_here"',
  );
  assert(
    scanText(`function add(a,b){return a+b} const url="https://example.com"`, 'b.js').length === 0,
    'clean bundle => 0 findings',
  );
}

console.log('\n2. Supabase config extraction');
{
  const anonJwt = fakeJwt('anon');
  const proj = 'abcdefghijklmnopqrst';
  const cfg = extractSupabaseConfig(
    `SUPABASE_URL="https://${proj}.supabase.co"; SUPABASE_ANON_KEY="${anonJwt}"`,
  );
  assert(cfg?.projectUrl === `https://${proj}.supabase.co`, 'extracts projectUrl');
  assert(cfg?.anonKey === anonJwt, 'extracts anon key (not service)');
}

console.log('\n3. Security headers');
{
  const empty = checkHeaders(new Headers());
  assert(
    empty.some((x) => x.id.includes('content-security-policy')),
    'detects missing CSP',
  );
  assert(
    empty.some((x) => x.id.includes('strict-transport-security')),
    'detects missing HSTS',
  );

  const good = checkHeaders(
    new Headers({
      'content-security-policy': "default-src 'self'",
      'strict-transport-security': 'max-age=63072000',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    }),
  );
  assert(good.length === 0, 'complete headers => 0 findings');

  const leaky = checkHeaders(new Headers({ 'x-powered-by': 'Express' }));
  assert(
    leaky.some((x) => x.id === 'leaky_header_x-powered-by'),
    'detects X-Powered-By: Express',
  );
}

console.log('\n4. Report generation');
{
  const { markdown, counts } = buildReport({
    target: 'https://demo.lovable.app',
    dateISO: '2026-08-09',
    findings: [
      {
        id: 'a',
        label: 'service_role exposed',
        severity: 'critical',
        check: 6,
        cwe: 'CWE-863',
        evidence: 'JWT role=service_role',
        exploit: 'anyone extracts it from the bundle',
        impact: 'total database access',
        why: 'bypasses all RLS',
        references: ['https://cwe.mitre.org/data/definitions/863.html'],
      },
      {
        id: 'b',
        label: 'Missing CSP',
        severity: 'medium',
        check: 22,
        evidence: 'Absent',
        why: 'defense against XSS',
      },
    ],
    rls: {
      projectUrl: 'https://x.supabase.co',
      probed: 60,
      enumerated: 0,
      exposedCount: 1,
      exposed: [
        {
          table: 'users',
          status: 'exposed',
          readable: true,
          rowsTotal: 1200,
          columns: 8,
          leakedColumns: ['email', 'phone'],
        },
      ],
      piiTables: [{ table: 'users', status: 'exposed', leakedColumns: ['email', 'phone'] }],
      writable: [],
      dataSecrets: [],
      allResults: [],
    },
    scanned: ['Headers', 'Secrets', 'RLS'],
  });
  assert(counts.critical === 1, 'counts 1 critical');
  assert(markdown.includes('Executive summary'), 'report has executive summary');
  assert(markdown.includes('users'), 'report lists exposed table');
  assert(markdown.includes('email, phone'), 'report flags PII columns');
  assert(markdown.includes('NOT PRODUCTION-READY'), 'verdict reflects critical');
  assert(markdown.includes('Classification:'), 'report renders CWE classification');
  assert(markdown.includes("How it's exploited:"), 'report renders exploit path');
  assert(markdown.includes('References:'), 'report renders references');
}

console.log('\n5. Context fields on detected findings');
{
  const serviceJwt = fakeJwt('service_role');
  const [f] = scanText(`const key = "${serviceJwt}"`, 'bundle.js').filter(
    (x) => x.id === 'supabase_service_role',
  );
  assert(f?.cwe === 'CWE-798', 'finding carries a CWE');
  assert((f?.exploit?.length ?? 0) > 0, 'finding carries an exploit path');
  assert((f?.references?.length ?? 0) > 0, 'finding carries references');
}

console.log('\n6. Source scan with line numbers (white-box)');
{
  const src = `const a = 1;\nconst stripe = "sk_live_${'a'.repeat(30)}";\n`;
  const [f] = scanSource(src, 'src/pay.ts').filter((x) => x.id === 'stripe_secret');
  assert(f?.source === 'src/pay.ts:2', 'reports file:line for a source secret');
}

console.log('\n7. Migration analysis (RLS, permissive policy, SECURITY DEFINER)');
{
  const sql = [
    'create table public.profiles (id uuid primary key, user_id uuid);',
    'create table public.safe (id uuid);',
    'alter table public.safe enable row level security;',
    'create policy "open" on public.profiles for select using (true);',
    'create function f() returns void language sql security definer as $$ select 1 $$;',
  ].join('\n');
  const fs = analyzeMigrations([{ path: 'supabase/migrations/001.sql', content: sql }]);
  assert(
    fs.some((f) => f.id === 'rls_disabled_profiles'),
    'flags table created without RLS',
  );
  assert(!fs.some((f) => f.id === 'rls_disabled_safe'), 'does NOT flag a table that enabled RLS');
  assert(
    fs.some((f) => f.id === 'permissive_policy'),
    'flags USING (true) policy',
  );
  assert(
    fs.some((f) => f.id === 'security_definer'),
    'flags SECURITY DEFINER function',
  );
}

console.log('\n8. Supabase export analysis (paste-this JSON)');
{
  const json = {
    vibeward_audit: {
      tables_without_rls: [{ table: 'users' }],
      permissive_policies: [{ table: 'orders', policy: 'open' }],
      security_definer_functions: [{ function: 'admin_fn' }],
    },
  };
  const fs = analyzeSupabaseExport(json);
  assert(
    fs.some((f) => f.id === 'rls_disabled_users'),
    'finds RLS-disabled table from export',
  );
  assert(
    fs.some((f) => f.id === 'permissive_policy'),
    'finds permissive policy from export',
  );
  assert(
    fs.some((f) => f.id === 'security_definer'),
    'finds SECURITY DEFINER from export',
  );
}

console.log('\n9. SARIF output');
{
  const sarif = JSON.parse(
    toSarif(
      [
        {
          id: 'stripe_secret',
          label: 'Stripe key',
          severity: 'critical',
          check: 2,
          source: 'src/a.ts:5',
          why: 'bad',
        },
        {
          id: 'missing_header_csp',
          label: 'No CSP',
          severity: 'medium',
          check: 22,
          source: 'https://x.com',
          why: 'meh',
        },
      ],
      '0.1.0',
    ),
  ) as { version: string; runs: { results: unknown[] }[] };
  assert(sarif.version === '2.1.0', 'SARIF version 2.1.0');
  assert(sarif.runs[0]!.results.length === 2, 'SARIF has one result per finding');
}

console.log('\n10. Intent gate (guards what the user asks the AI)');
{
  const danger = (p: string): boolean => scanIntent(p).length > 0;
  assert(danger('disable RLS so the query works'), 'catches "disable RLS"');
  assert(danger('just use the service_role key in the frontend'), 'catches service_role in client');
  assert(danger('make the users table public to debug'), 'catches "make it public"');
  assert(danger('remove the login for now'), 'catches removing auth');
  assert(danger('set cors to allow all origins'), 'catches CORS *');
  assert(danger('desactiva el RLS un momento'), 'catches Spanish "desactiva el RLS"');
  assert(!danger('add a dark mode toggle to the settings page'), 'ignores a benign request');
  const f = scanIntent('disable RLS')[0];
  assert(!!f && !!f.instead && !!f.why, 'finding carries why + safe alternative');
}

console.log('\n11. Source map exposure (black-box, from the URL)');
{
  const base = 'https://app.example.com/assets/index-abc123.js';
  assert(
    resolveSourceMapUrl('console.log(1)\n//# sourceMappingURL=index-abc123.js.map', base) ===
      'https://app.example.com/assets/index-abc123.js.map',
    'resolves a relative sourceMappingURL to an absolute .map url',
  );
  assert(resolveSourceMapUrl('console.log(1)', base) === null, 'no comment => no source map url');
  assert(
    resolveSourceMapUrl('//# sourceMappingURL=data:application/json;base64,eyJ9', base) === null,
    'ignores inline data: maps (not a served file)',
  );

  const mapBody =
    '{"version":3,"sources":["src/App.tsx"],"sourcesContent":["const x=1"],"mappings":"AAAA"}';
  const finding = sourceMapFinding('https://app.example.com/assets/index.js.map', mapBody);
  assert(finding?.id?.startsWith('sourcemap_exposed_') ?? false, 'builds a source-map finding');
  assert(finding?.cwe === 'CWE-540', 'source-map finding carries CWE-540');
  assert(finding?.evidence?.includes('original source') ?? false, 'flags embedded original source');
  assert(
    sourceMapFinding('https://app.example.com/x.js.map', 'not a source map at all') === null,
    'does NOT flag a body that is not a source map',
  );
}

console.log('\n12. New-format Supabase keys (sb_secret_ / sb_publishable_)');
{
  const secret = `sb_secret_${'A'.repeat(30)}`;
  assert(
    scanText(`const k = "${secret}"`, 'b.js').some((f) => f.id === 'supabase_secret_key'),
    'flags sb_secret_ as a critical secret',
  );
  const proj = 'abcdefghijklmnopqrst';
  const pub = `sb_publishable_${'B'.repeat(30)}`;
  const cfg = extractSupabaseConfig(`url="https://${proj}.supabase.co"; key="${pub}"`);
  assert(
    cfg?.anonKey === pub && cfg?.keyKind === 'publishable',
    'extracts sb_publishable_ as the probe key (would have caught Moltbook)',
  );
}

console.log('\n13. PostgREST table enumeration (OpenAPI)');
{
  const doc = JSON.stringify({
    paths: { '/': {}, '/agents': {}, '/submolts': {}, '/rpc/do_thing': {} },
    definitions: { agents: {}, owners: {} },
  });
  const tables = parseOpenApiTables(doc);
  assert(
    ['agents', 'owners', 'submolts'].every((t) => tables.includes(t)),
    'enumerates tables from paths + definitions (custom names, not a fixed list)',
  );
  assert(
    !tables.includes('rpc/do_thing') && !tables.includes(''),
    'skips rpc endpoints and the root path',
  );
  assert(parseOpenApiTables('not json').length === 0, 'a non-JSON body yields no tables');
}

console.log('\n14. Secrets inside returned data (Moltbook DM pattern)');
{
  const rowJson = JSON.stringify([{ id: 1, message: `my key is sk-proj-${'a'.repeat(40)}` }]);
  const fs = scanReturnedData(rowJson, 'https://x.supabase.co/rest/v1/messages');
  assert(
    fs.some((f) => f.id === 'data_openai_key'),
    'flags an OpenAI key pasted into world-readable row content',
  );
  assert(
    fs.every((f) => f.id !== 'data_generic_secret_assign'),
    'skips the noisy generic rule against row JSON',
  );
}

console.log('\n15. Firebase config + open-bucket finding');
{
  const cfg = extractFirebaseConfig(
    `const c={apiKey:"AIza${'a'.repeat(35)}",projectId:"demo-app",storageBucket:"demo-app.appspot.com"}`,
  );
  assert(cfg?.projectId === 'demo-app', 'extracts Firebase projectId');
  assert(cfg?.storageBucket === 'demo-app.appspot.com', 'extracts Firebase storageBucket');
  assert(
    extractFirebaseConfig('const c={projectId:"demo-app"}') === null,
    'no Firebase API key => no config (avoids false positives)',
  );
  const sf = firebaseStorageFinding('demo-app.appspot.com');
  assert(
    sf.id === 'firebase_storage_open' && sf.cwe === 'CWE-863',
    'builds a storage-open finding',
  );
}

console.log('\n16. GraphQL introspection + anon write grants');
{
  const g = graphqlIntrospectionFinding('https://x.supabase.co');
  assert(
    g.id === 'graphql_introspection' && g.severity === 'medium',
    'builds a GraphQL-introspection finding',
  );
  const fs = analyzeMigrations([
    { path: '002.sql', content: 'grant select, insert on public.leads to anon;' },
  ]);
  assert(
    fs.some((f) => f.id === 'grant_anon_leads' && f.severity === 'high'),
    'flags a write grant to the anon role',
  );
}

console.log('\n17. Migration RLS gating (no false positive on plain Prisma/Neon)');
{
  const prismaSql =
    'create table public."User" (id serial primary key);\ncreate table public."Item" (id serial primary key);';
  const noCtx = analyzeMigrations([
    { path: 'prisma/migrations/1_init/migration.sql', content: prismaSql },
  ]);
  assert(
    !noCtx.some((f) => f.id.startsWith('rls_disabled_')),
    'plain Prisma migrations => NO rls_disabled false positive (the inventario bug)',
  );

  const withCtx = analyzeMigrations([{ path: 'x.sql', content: prismaSql }], {
    supabaseContext: true,
  });
  assert(
    withCtx.some((f) => f.id.startsWith('rls_disabled_')),
    'with supabaseContext => still flags missing RLS',
  );

  const rlsSql = `${prismaSql}\nalter table public."User" enable row level security;`;
  const usesRls = analyzeMigrations([{ path: 'supabase/migrations/1.sql', content: rlsSql }]);
  assert(
    usesRls.some((f) => f.id === 'rls_disabled_item'),
    'when the migrations use RLS => flags the table that lacks it',
  );
  assert(
    !usesRls.some((f) => f.id === 'rls_disabled_user'),
    'does NOT flag the table that enabled RLS',
  );
}

console.log('\n18. Server-side backend checks (framework + ORM archetype)');
{
  // (a) Next.js security headers
  assert(
    checkNextConfigHeaders('next.config.ts', 'export default {};')?.id ===
      'nextjs_no_security_headers',
    'flags a next.config with no security headers',
  );
  assert(
    checkNextConfigHeaders('next.config.ts', 'export default { async headers(){ return [] } };') ===
      null,
    'no flag when headers() is present',
  );
  assert(checkNextConfigHeaders('src/foo.ts', 'whatever') === null, 'only fires on next.config');

  // (b) server action / route mutation without an auth guard
  assert(
    (
      checkServerActionAuth(
        'app/items/actions.ts',
        '"use server";\nawait prisma.item.delete({ where: { id } });',
      )?.id ?? ''
    ).startsWith('unguarded_mutation_'),
    'flags a server mutation with no auth guard',
  );
  assert(
    checkServerActionAuth(
      'app/items/actions.ts',
      '"use server";\nawait requireRole("admin");\nawait prisma.item.delete({});',
    ) === null,
    'no flag when requireRole guards the mutation',
  );
  assert(
    checkServerActionAuth(
      'app/login/actions.ts',
      '"use server";\nconst u = await prisma.user.findUnique({ where: { dni } });',
    ) === null,
    'no flag on a read-only action (no mutation) — low false positives',
  );
  assert(
    checkServerActionAuth('lib/util.ts', 'await prisma.item.delete({})') === null,
    'no flag outside a server action / route handler',
  );

  // (c) spreadsheet/CSV formula injection
  assert(
    (
      checkExportFormulaInjection(
        'app/api/export/route.ts',
        'import ExcelJS from "exceljs";\nsheet.addRow({ a: it.descripcion });',
      )?.id ?? ''
    ).startsWith('formula_injection_'),
    'flags an exceljs export without formula sanitization',
  );
  assert(
    checkExportFormulaInjection(
      'app/api/export/route.ts',
      'import ExcelJS from "exceljs";\n// sanitize formula prefixes here\nsheet.addRow(safe);',
    ) === null,
    'no flag when sanitization is hinted',
  );
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
