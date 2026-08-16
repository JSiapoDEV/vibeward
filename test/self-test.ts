// Self-test with SYNTHETIC data (no real secrets). Validates detection logic
// without touching any external system. Run with: npm test
import {
  scanText,
  scanCrawledPages,
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
import {
  parsePage,
  fingerprintStack,
  robotsBlocksAI,
  analyzeRobots,
  checkWeb,
  WEB_CHECKS,
} from '../src/checks/web.js';
import {
  normalizePageUrl,
  discoverInternalLinks,
  parseSitemapUrls,
  discoverAssets,
  looksLikeSamePage,
} from '../src/http/crawl.js';
import type { SiteFiles } from '../src/http/crawl.js';
import type { Finding } from '../src/core/types.js';
import { parseConfig, applySuppressions, notApplicableChecks } from '../src/core/config.js';
import {
  findOnPath,
  pinnedNpxGuard,
  resolveGuard,
  upgradeGuardCommand,
} from '../src/init/binary.js';
import { hookFile } from '../src/init/hooks.js';
import { HOSTS } from '../src/init/capabilities.js';
import type { Moment } from '../src/guard/verdict.js';

const ALL_MOMENTS: Moment[] = ['prompt', 'action', 'content'];
import { RELEASED, VERSION, ageInDays, stalenessNotice } from '../src/core/version.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

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
  // The whole application often lives on a secondary page (`app.html`) while `/` is marketing.
  // The URL scanner used to run the secret scanner on the home page and external bundles only,
  // so a key in a secondary page's inline script was fetched and never scanned. Found while
  // auditing a real BYOK app whose home page carried nothing and whose app.html carried the
  // backend wiring.
  const svc = fakeJwt('service_role');
  const home = { url: 'https://s.test/', html: '<html><body>marketing</body></html>' };
  const app = {
    url: 'https://s.test/app',
    html: `<html><body><script>createClient("https://x.supabase.co","${svc}")</script></body></html>`,
  };
  const crawled = scanCrawledPages([home, app], ['https://s.test/'], []);
  assert(
    crawled.some((f) => f.id === 'supabase_service_role' && f.source === 'https://s.test/app'),
    'a service_role key in a secondary page inline script is caught, with that page as source',
  );
  // Dedup: the same key on two pages, and a key already reported by the home-page pass, appear
  // once — not once per page.
  const dupA = { url: 'https://s.test/a', html: app.html };
  const dupB = { url: 'https://s.test/b', html: app.html };
  assert(
    scanCrawledPages([dupA, dupB], [], []).filter((f) => f.id === 'supabase_service_role')
      .length === 1,
    'the same key on several pages is reported once',
  );
  assert(
    scanCrawledPages([app], [], scanText(app.html, 'https://s.test/')).length === 0,
    'a key already found by an earlier pass is not reported again',
  );
  // The anon key is public by design and must never be reported, wherever it sits — this is the
  // real videoapuntes case, whose only Supabase key in app.html is the anon key.
  const anonApp = {
    url: 'https://s.test/app',
    html: `<html><body><script>createClient("https://y.supabase.co","${fakeJwt('anon')}")</script></body></html>`,
  };
  assert(
    !scanCrawledPages([anonApp], [], []).some((f) => f.id === 'supabase_service_role'),
    'an anon key in a secondary page is correctly left silent',
  );
  // A static bearer token in the bundle. Found in a real vibe-coded app, and missed by every
  // pattern here: no vendor prefix, and after minification the variable holding it is `B`, so
  // the name-keyed `generic_secret_assign` heuristic has nothing to match either. The signal
  // has to be the USE — a literal that ends up behind `Bearer`.
  const bearer = 'a852d372df4711967c81aa1c3b5629dfa12af8693eb67cd1';
  assert(
    scanText(
      `B="${bearer}";fetch("/api/week",{headers:{Authorization:"Bearer ".concat(B)}})`,
      'b.js',
    ).some((f) => f.id === 'hardcoded_bearer'),
    'detects a minified bearer token assigned one hop from its use',
  );
  assert(
    scanText(`h={Authorization:"Bearer ${bearer}"}`, 'b.js').some(
      (f) => f.id === 'hardcoded_bearer',
    ),
    'detects a bearer token written inline in the header',
  );
  // Precision: a token the client OBTAINS is an identifier with no literal assignment, and a
  // documentation example is a placeholder. Neither may fire, or the check is noise in every
  // README and every correct login flow.
  for (const [why, code] of [
    [
      'a token from a login',
      'const t = await login(); fetch(u,{headers:{Authorization:`Bearer ${t}`}})',
    ],
    [
      'a token from storage',
      'const tok = localStorage.getItem("tok"); h.Authorization = "Bearer " + tok;',
    ],
    [
      'a token from the environment',
      'headers: { Authorization: `Bearer ${process.env.API_TOKEN}` }',
    ],
    ['a docs example', 'curl -H "Authorization: Bearer YOUR_TOKEN_HERE" https://api.example.com'],
    [
      'a placeholder constant',
      'const TOKEN = "replace-with-your-token-value"; h = "Bearer " + TOKEN;',
    ],
  ] as const) {
    assert(
      !scanText(code, 'b.js').some((f) => f.id === 'hardcoded_bearer'),
      `does NOT flag ${why}`,
    );
  }
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

// ---------------------------------------------------------------------------
// Website quality / AI visibility (synthetic HTML, no network)
// ---------------------------------------------------------------------------

/** A page that does everything right — the baseline that must produce zero findings. */
function goodHtml(path: string, title: string): string {
  const body = 'Texto real y visible que un crawler lee sin ejecutar JavaScript. '.repeat(6);
  return `<!doctype html>
<html lang="es">
<head>
<title>${title}</title>
<meta name="description" content="Una descripcion real y especifica de esta pagina, escrita para alguien que decide si hacer clic.">
<link rel="canonical" href="https://x.test${path}">
<link rel="icon" href="/favicon.svg">
<meta property="og:title" content="${title}">
<meta property="og:image" content="https://x.test/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"X"}</script>
</head>
<body><h1>${title}</h1><p>${body}</p><img src="/foto.jpg" alt="El equipo en la oficina"></body>
</html>`;
}

/** The archetype: a Vite + React shell on a free subdomain with nothing in the HTML. */
const SPA_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Vite + React</title></head>
<body><div id="root"></div><script type="module" crossorigin src="/assets/index-a1b2c3d4.js"></script></body>
</html>`;

function goodFiles(over: Partial<SiteFiles> = {}): SiteFiles {
  return {
    robotsTxt: 'User-agent: *\nAllow: /\nSitemap: https://x.test/sitemap.xml',
    llmsTxt: '# X\n> Lo que hace el sitio.',
    sitemapXml: '<urlset><url><loc>https://x.test/</loc></url></urlset>',
    faviconOk: true,
    notFound: { status: 404, distinct: true },
    ...over,
  };
}

const emptyFiles: SiteFiles = {
  robotsTxt: null,
  llmsTxt: null,
  sitemapXml: null,
  faviconOk: false,
  notFound: { status: 200, distinct: false },
};

const ids = (fs: Finding[]): string[] => fs.map((f) => f.id);

console.log('\n19. Website — HTML parsing');
{
  const good = parsePage(goodHtml('/', 'Inicio'), 'https://x.test/');
  assert(good.title === 'Inicio', 'reads the <title>');
  assert(good.metaDescription !== null, 'reads the meta description');
  assert(good.canonical === 'https://x.test/', 'reads the canonical URL');
  assert(good.ogTitle !== null && good.ogImage !== null, 'reads the Open Graph tags');
  assert(good.lang === 'es', 'reads lang from <html>');
  assert(good.h1Count === 1, 'counts a single <h1>');
  assert(good.jsonLdBlocks === 1, 'counts the JSON-LD block');
  assert(good.imgTotal === 1 && good.imgWithoutAlt === 0, 'counts images with alt');
  assert(good.faviconLink, 'sees the icon <link>');
  assert(good.bodyTextLength > 200, 'measures the visible text');

  const spa = parsePage(SPA_HTML, 'https://demo.vercel.app/');
  assert(spa.metaDescription === null, 'SPA shell: no meta description');
  assert(spa.lang === null, 'SPA shell: no lang');
  assert(spa.h1Count === 0, 'SPA shell: no <h1>');
  assert(spa.bodyTextLength < 200, 'SPA shell: empty view-source');

  assert(
    parsePage('<img src="/a.png" alt=""><img src="/b.png">', 'https://x.test/').imgWithoutAlt === 1,
    'alt="" is decorative on purpose, only a MISSING alt counts',
  );
  assert(
    parsePage('<!-- <title>Comentado</title> --><title>Real</title>', 'https://x.test/').title ===
      'Real',
    'ignores markup left inside an HTML comment',
  );
}

console.log('\n20. Website — vibe-coded fingerprint');
{
  const fp = fingerprintStack(SPA_HTML, 'https://demo.vercel.app/', 2_000_000, emptyFiles);
  assert(fp.platformDomain === 'vercel.app', 'detects the free platform subdomain');
  assert(fp.framework === 'Vite + React', 'detects the Vite + React build');
  assert(fp.clientRendered, 'flags the empty view-source as client-rendered');
  assert(fp.score >= 8 && fp.total === 12, `scores the fingerprint high (${fp.score}/${fp.total})`);

  const real = fingerprintStack(
    goodHtml('/', 'Inicio'),
    'https://midominio.com/',
    90_000,
    goodFiles(),
  );
  assert(real.platformDomain === null, 'a real domain is not a platform subdomain');
  assert(!real.clientRendered, 'a page with content is not flagged as client-rendered');
  assert(real.score === 0, `a well-built site scores 0 (got ${real.score})`);

  assert(
    fingerprintStack('<script src="/_next/static/x.js"></script>', 'https://x.test/', 0)
      .framework === 'Next.js',
    'detects Next.js',
  );
}

console.log('\n21. Website — robots.txt blocking AI crawlers');
{
  assert(
    robotsBlocksAI(null) === null || robotsBlocksAI(null).length === 0,
    'no robots.txt => nothing blocked',
  );
  assert(
    robotsBlocksAI('User-agent: GPTBot\nDisallow: /').includes('GPTBot'),
    'flags an explicit Disallow: / for GPTBot',
  );
  assert(
    robotsBlocksAI('User-agent: *\nDisallow: /').length >= 10,
    'a wildcard Disallow: / blocks every watched AI crawler',
  );
  assert(
    robotsBlocksAI('User-agent: GPTBot\nDisallow:').length === 0,
    'an EMPTY Disallow allows everything — must not be a false positive',
  );
  assert(
    robotsBlocksAI('User-agent: *\nDisallow: /admin\nAllow: /').length === 0,
    'blocking only /admin does not block the AI crawlers',
  );
  {
    const both = robotsBlocksAI('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /');
    assert(
      both.includes('GPTBot') && both.includes('ClaudeBot'),
      'consecutive User-agent lines share the same rule block',
    );
  }
  {
    const mixed = robotsBlocksAI('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /');
    assert(
      !mixed.includes('GPTBot') && mixed.includes('ClaudeBot'),
      'a group naming the bot wins over the wildcard group',
    );
  }
  assert(
    robotsBlocksAI('<!doctype html><html><body>404</body></html>').length === 0,
    'an SPA serving index.html for /robots.txt is not a robots policy',
  );
}

console.log('\n22. Website — findings and aggregation');
{
  const clean = checkWeb({
    pages: [
      parsePage(goodHtml('/', 'Inicio'), 'https://x.test/'),
      parsePage(goodHtml('/precios', 'Precios'), 'https://x.test/precios'),
    ],
    files: goodFiles(),
    brokenAssets: [],
    jsBytes: 120_000,
    consoleErrors: [],
  });
  assert(
    clean.length === 0,
    `a well-built site produces zero findings (got ${ids(clean).join(', ')})`,
  );

  const spaPages = [
    parsePage(SPA_HTML, 'https://demo.vercel.app/'),
    parsePage(SPA_HTML, 'https://demo.vercel.app/precios'),
  ];
  const bad = checkWeb({
    pages: spaPages,
    files: emptyFiles,
    brokenAssets: [
      { url: 'https://demo.vercel.app/logo.png', status: 404, from: 'https://demo.vercel.app/' },
    ],
    jsBytes: 2_000_000,
    consoleErrors: [{ type: 'pageerror', text: 'TypeError: x is not a function' }],
  });
  const badIds = ids(bad);
  for (const id of [
    'web_empty_html',
    'web_broken_assets',
    'web_console_errors',
    'web_duplicate_titles',
    'web_missing_meta_description',
    'web_missing_og',
    'web_missing_canonical',
    'web_missing_structured_data',
    'web_h1_structure',
    'web_missing_sitemap',
    'web_missing_llms_txt',
    'web_missing_lang',
    'web_missing_404',
    'web_missing_favicon',
    'web_heavy_bundle',
  ]) {
    assert(badIds.includes(id), `vibe-coded SPA => ${id}`);
  }
  assert(
    bad.every((f) => f.kind === 'web'),
    'every website finding is tagged kind: "web"',
  );
  assert(
    bad.every((f) => f.check === undefined && f.cwe === undefined),
    'website findings carry no security checklist item or CWE',
  );
  // The inverse of what this suite used to assert, and deliberately so. vibeward reports and
  // never fixes, so no finding may carry a field shaped like a work order for an agent. The
  // remediation belongs in `why`, addressed to a person.
  assert(
    bad.every(
      (f) => !('fix' in f) && !('autofix' in f) && typeof f.why === 'string' && f.why.length > 0,
    ),
    'no website finding carries fix/autofix, and every one explains itself in why — the contract',
  );
  assert(new Set(badIds).size === badIds.length, 'one finding per problem, never one per page');
  assert(
    WEB_CHECKS.every((c) => typeof c.label === 'string' && c.label.length > 0),
    'WEB_CHECKS labels the full checklist so the report can show what passed',
  );
  assert(
    badIds.every((id) => WEB_CHECKS.some((c) => c.id === id)),
    'every emitted id is in WEB_CHECKS (otherwise the report silently drops it)',
  );

  // Playwright absent must never be reported as "the console is clean".
  const noBrowser = checkWeb({
    pages: spaPages,
    files: emptyFiles,
    brokenAssets: [],
    jsBytes: 1000,
    consoleErrors: null,
  });
  assert(
    !ids(noBrowser).includes('web_console_errors'),
    'consoleErrors === null (no Playwright) => no console finding, ever',
  );

  // A megabyte of inline <script> is downloaded and parsed exactly like a bundle, and used to
  // sail past a check literally named "JavaScript payload is heavy" because it had no `src`.
  // Found on a real vibe-coded site whose home document was 3.7 MB, 3.3 MB of it inline.
  {
    const bigInline = `<html><head></head><body><script>${'a=1;'.repeat(400000)}</script></body></html>`;
    const heavyPage = parsePage(bigInline, 'https://x.test/');
    assert(heavyPage.inlineScriptBytes > 1_000_000, 'parsePage measures inline script bytes');
    const w = checkWeb({
      pages: [heavyPage],
      files: goodFiles({}),
      brokenAssets: [],
      jsBytes: 0,
      consoleErrors: null,
    });
    assert(
      w.some((f) => f.id === 'web_heavy_bundle'),
      'a multi-MB inline <script> trips the heavy-payload check even with zero external JS',
    );
    // Precision: a JSON-LD block is data, not code, and a small analytics snippet is normal.
    const jsonLd = `<html><head><script type="application/ld+json">${JSON.stringify({ x: 'y'.repeat(60000) })}</script></head></html>`;
    assert(
      !checkWeb({
        pages: [parsePage(jsonLd, 'https://x.test/')],
        files: goodFiles({}),
        brokenAssets: [],
        jsBytes: 0,
        consoleErrors: null,
      }).some((f) => f.id === 'web_heavy_bundle'),
      'a large JSON-LD block is data, not a heavy JS payload',
    );
  }

  // A single page cannot prove titles are duplicated.
  const onePage = checkWeb({
    pages: [parsePage(goodHtml('/', 'Inicio'), 'https://x.test/')],
    files: goodFiles(),
    brokenAssets: [],
    jsBytes: 1000,
    consoleErrors: [],
  });
  assert(
    !ids(onePage).includes('web_duplicate_titles'),
    'one crawled page => never claims duplicate titles',
  );

  const realNotFound = checkWeb({
    pages: [parsePage(goodHtml('/', 'Inicio'), 'https://x.test/')],
    files: goodFiles({ notFound: { status: 404, distinct: true } }),
    brokenAssets: [],
    jsBytes: 1000,
    consoleErrors: [],
  });
  assert(!ids(realNotFound).includes('web_missing_404'), 'a real 404 is not reported');
}

console.log('\n23. Website — crawl parsing (pure, no network)');
{
  const base = 'https://x.test/';
  assert(normalizePageUrl('/about/', base) === 'https://x.test/about', 'drops the trailing slash');
  assert(
    normalizePageUrl('/a?utm_source=x&id=2', base) === 'https://x.test/a?id=2',
    'drops utm_* but keeps real query params',
  );
  assert(normalizePageUrl('/a#top', base) === 'https://x.test/a', 'drops the hash');
  assert(normalizePageUrl('mailto:a@b.c', base) === null, 'rejects mailto:');
  assert(normalizePageUrl('#top', base) === null, 'rejects a bare anchor');
  assert(normalizePageUrl('/manual.pdf', base) === null, 'rejects a file to download');

  const html = `<a href="/precios">P</a><a href="https://otro.test/x">O</a><a href="/precios#faq">P2</a><a href="mailto:a@b.c">M</a>`;
  const links = discoverInternalLinks(html, base, 8);
  assert(
    links.length === 1 && links[0] === 'https://x.test/precios',
    'same-host links only, deduped',
  );

  const sitemap = `<urlset><url><loc>https://x.test/a</loc></url><url><loc>https://otro.test/b</loc></url></urlset>`;
  assert(
    parseSitemapUrls(sitemap, 'x.test', 8).join() === 'https://x.test/a',
    'sitemap: same-host URLs only',
  );

  const assets = discoverAssets(
    `<script src="/a.js"></script><link rel="canonical" href="/x"><link rel="stylesheet" href="/s.css"><img src="/i.png">`,
    base,
  );
  assert(assets.includes('https://x.test/a.js'), 'finds script assets');
  assert(assets.includes('https://x.test/s.css'), 'finds stylesheet assets');
  assert(assets.includes('https://x.test/i.png'), 'finds image assets');
  assert(!assets.includes('https://x.test/x'), 'a canonical link is not an asset to download');

  assert(looksLikeSamePage('<html>hola</html>', '<html>hola</html>'), 'identical pages match');
  assert(
    !looksLikeSamePage('<html>hola</html>', `<html>${'contenido distinto '.repeat(50)}</html>`),
    'clearly different pages do not match',
  );
}

console.log('\n24. Isolation — website findings never gate security');
{
  const secCritical: Finding = {
    id: 'x_critical',
    label: 'Exposed service key',
    severity: 'critical',
    check: 2,
    why: 'test',
  };
  const webMedium: Finding = {
    id: 'web_missing_canonical',
    label: 'Pages declare no canonical URL',
    severity: 'medium',
    kind: 'web',
    why: 'test',
  };
  const webHigh: Finding = {
    id: 'web_robots_blocks_ai',
    label: 'robots.txt blocks AI crawlers',
    severity: 'high',
    kind: 'web',
    why: 'test',
  };

  const mixed = buildReport({
    target: 'https://x.test',
    dateISO: '2026-08-14',
    findings: [secCritical, webMedium, webHigh],
    rls: null,
    scanned: ['test'],
  });
  assert(mixed.counts.critical === 1, 'security counts include the security finding');
  assert(
    mixed.counts.medium === 0 && mixed.counts.high === 0,
    'security counts EXCLUDE website findings',
  );
  assert(
    mixed.webCounts.medium === 1 && mixed.webCounts.high === 1,
    'website findings are counted separately',
  );
  assert(
    mixed.markdown.includes('Website quality & AI visibility'),
    'the report gets its own website section',
  );

  const webOnly = buildReport({
    target: 'https://x.test',
    dateISO: '2026-08-14',
    findings: [webMedium, webHigh],
    rls: null,
    scanned: ['test'],
  });
  assert(
    webOnly.counts.critical === 0 && webOnly.counts.high === 0,
    'a site with ONLY website findings has zero security severity (exit code stays 0)',
  );
  assert(
    webOnly.verdict.startsWith('No critical findings'),
    'website findings never change the security verdict',
  );

  const sarif = toSarif([secCritical, webMedium, webHigh], '0.3.0');
  assert(sarif.includes('x_critical'), 'SARIF keeps the security finding');
  assert(
    !sarif.includes('web_missing_canonical') && !sarif.includes('web_robots_blocks_ai'),
    'SARIF EXCLUDES website findings — the Security tab is for vulnerabilities',
  );
}

console.log('\n25. Regressions caught by the adversarial review');
{
  // (a) The 200 KB window is for <head>. Body signals must see the whole document, or a
  // Next.js RSC payload / inline critical CSS pushes the real <h1> out of view and the
  // report tells a paying client their page has no heading.
  const filler = `<script type="application/ld+json">${'"x",'.repeat(60000)}</script>`;
  const huge = `<!doctype html><html lang="es"><head><title>T</title>${filler}</head>
<body><h1>Catálogo</h1><img src="/a.png" alt="ok"><img src="/b.png"><p>${'texto '.repeat(60)}</p></body></html>`;
  assert(huge.length > 200 * 1024, 'fixture is genuinely over the 200 KB head window');
  const big = parsePage(huge, 'https://x.test/');
  assert(big.h1Count === 1, 'counts an <h1> that sits past 200 KB (was reported as missing)');
  assert(big.imgTotal === 2 && big.imgWithoutAlt === 1, 'counts images past 200 KB');
  assert(big.bodyTextLength > 200, 'measures visible text past 200 KB');
  assert(big.title === 'T', 'still reads the <head> signals');

  // (b) Markup inside a <script> body is not markup.
  const inlined = `<html><head><title>T</title></head><body>
<script>const tpl = "<h1>fake</h1><img src=x>"; const other = '<h1>also fake</h1>';</script>
<h1>Real</h1></body></html>`;
  const parsed = parsePage(inlined, 'https://x.test/');
  assert(parsed.h1Count === 1, 'does not count <h1> written inside a JS string');
  assert(parsed.imgTotal === 0, 'does not count <img> written inside a JS string');

  // (c) The robots source is measured, never inferred from how many bots are blocked.
  const perBot = `${[
    'GPTBot',
    'OAI-SearchBot',
    'ChatGPT-User',
    'ClaudeBot',
    'anthropic-ai',
    'Claude-Web',
    'PerplexityBot',
    'CCBot',
    'Google-Extended',
    'Applebot-Extended',
    'Bytespider',
    'meta-externalagent',
  ]
    .map((b) => `User-agent: ${b}\nDisallow: /`)
    .join('\n\n')}\n\nUser-agent: *\nAllow: /\nDisallow: /admin\n`;
  const perBotVerdict = analyzeRobots(perBot);
  assert(perBotVerdict.bots.length === 12, 'twelve per-bot blocks still block twelve bots');
  assert(
    !perBotVerdict.viaWildcard,
    'twelve bots blocked one by one is NOT reported as a wildcard block',
  );
  assert(
    !perBotVerdict.blockingAgents.includes('*'),
    'a permissive User-agent: * is never named as the culprit',
  );
  const wildcardVerdict = analyzeRobots('User-agent: *\nDisallow: /');
  assert(
    wildcardVerdict.viaWildcard && wildcardVerdict.blockingAgents.join() === '*',
    'a real wildcard block IS reported as one',
  );
  {
    const f = checkWeb({
      pages: [parsePage(goodHtml('/', 'Inicio'), 'https://x.test/')],
      files: goodFiles({ robotsTxt: perBot }),
      brokenAssets: [],
      jsBytes: 1000,
      consoleErrors: [],
    }).find((x) => x.id === 'web_robots_blocks_ai');
    assert(
      f !== undefined && !f.evidence!.includes('User-agent: *'),
      'the evidence never claims a `User-agent: *` line the file does not have',
    );
    // The finding no longer carries a `fix`, but the hazard it guarded against is unchanged:
    // whoever acts on this must not replace robots.txt wholesale, because that silently
    // deletes the Disallow rules the owner does want. The scoping now lives in `why`.
    assert(
      f !== undefined && f.why.includes('Disallow: /') && /every other line|must stay/i.test(f.why),
      'the report scopes the change to one line, never to a whole replacement robots.txt',
    );
  }
}

console.log('\n26. vibeward.json — declared intent and suppressions');
{
  // (a) Only website checks can be silenced. Security is not negotiable by config file.
  const bad = parseConfig(
    JSON.stringify({
      suppress: [
        { id: 'supabase_service_role', reason: 'lo miramos luego' },
        { id: 'web_missing_og', reason: 'landing privada' },
        { id: 'web_missing_canonical' },
        { id: 'web_typo_id', reason: 'x' },
      ],
    }),
  );
  assert(
    bad.config.suppress?.length === 1 && bad.config.suppress[0]!.id === 'web_missing_og',
    'only the valid website suppression survives',
  );
  assert(
    bad.warnings.some((w) => w.includes('supabase_service_role') && w.includes('never security')),
    'a security id is rejected loudly, never silently',
  );
  assert(
    bad.warnings.some((w) => w.includes('web_missing_canonical') && w.includes('reason')),
    'a suppression with no reason is rejected',
  );
  assert(
    bad.warnings.some((w) => w.includes('web_typo_id')),
    'a typo in an id is reported instead of looking like it worked',
  );
  assert(parseConfig('{ nope').warnings.length === 1, 'broken JSON warns instead of throwing');
  assert(
    parseConfig(JSON.stringify({ intent: { siteType: 'blog' } })).warnings.some((w) =>
      w.includes('siteType'),
    ),
    'an unknown siteType is rejected',
  );

  // (b) A suppressed finding is moved aside, never dropped, and security is untouchable
  // even if an id somehow got through validation.
  const secret: Finding = { id: 'x', label: 'Secret', severity: 'critical', why: 'w' };
  const og: Finding = {
    id: 'web_missing_og',
    label: 'OG',
    severity: 'medium',
    kind: 'web',
    why: 'w',
  };
  const split = applySuppressions([secret, og], {
    suppress: [
      { id: 'web_missing_og', reason: 'landing privada' },
      { id: 'x', reason: 'intento de silenciar seguridad' },
    ],
  });
  assert(split.kept.length === 1 && split.kept[0] === secret, 'the security finding stays');
  assert(
    split.suppressed.length === 1 && split.suppressed[0]!.reason === 'landing privada',
    'the website finding moves to `suppressed` with its reason attached',
  );

  // (c) The report must show a suppression, not hide it.
  const report = buildReport({
    target: 'https://x.test',
    dateISO: '2026-08-14',
    findings: [],
    rls: null,
    scanned: ['test'],
    suppressed: split.suppressed,
    configPath: '/repo/vibeward.json',
  });
  assert(
    report.markdown.includes('1 suppression(s) in effect'),
    'the executive summary warns that the scope was narrowed',
  );
  assert(
    report.markdown.includes('Suppressed by configuration (1)') &&
      report.markdown.includes('landing privada'),
    'the suppressed check is listed with its declared reason',
  );

  // (d) Declaring intent does not mute the robots check — it inverts it.
  const partial = `User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n`;
  const declared = { intent: { aiCrawlers: 'blocked' as const } };
  const na = notApplicableChecks(declared);
  const blocked = checkWeb({
    pages: [parsePage(goodHtml('/', 'Inicio'), 'https://x.test/')],
    files: goodFiles({ robotsTxt: partial }),
    brokenAssets: [],
    jsBytes: 1000,
    consoleErrors: [],
    intent: declared.intent,
    notApplicable: na,
  });
  const blockedIds = ids(blocked);
  assert(
    !blockedIds.includes('web_robots_blocks_ai'),
    'declaring the block on purpose stops it being reported as a mistake',
  );
  assert(
    blockedIds.includes('web_ai_block_incomplete'),
    'and an INCOMPLETE block becomes the finding instead',
  );
  {
    const f = blocked.find((x) => x.id === 'web_ai_block_incomplete')!;
    assert(f.evidence!.includes('10 of 12'), 'it names how many crawlers still walk in');
  }
  assert(
    !ids(
      checkWeb({
        pages: [parsePage(goodHtml('/', 'Inicio'), 'https://x.test/')],
        files: goodFiles({ robotsTxt: 'User-agent: *\nDisallow: /' }),
        brokenAssets: [],
        jsBytes: 1000,
        consoleErrors: [],
        intent: declared.intent,
        notApplicable: na,
      }),
    ).includes('web_ai_block_incomplete'),
    'a complete block satisfies the declared intent',
  );
  assert(
    notApplicableChecks({}).has('web_ai_block_incomplete'),
    'without a declared intent the inverted check is "not applicable", never a silent pass',
  );

  // (e) siteType switches off a whole family with one line, and the report says why.
  const internal = notApplicableChecks({ intent: { siteType: 'internal' } });
  assert(
    internal.has('web_missing_sitemap') && internal.has('web_missing_og'),
    'an internal tool is not judged on discoverability',
  );
  assert(
    !internal.has('web_missing_alt') && !internal.has('web_broken_assets'),
    'but accessibility and broken assets still apply to an internal tool',
  );
  {
    const md = buildReport({
      target: 'https://x.test',
      dateISO: '2026-08-14',
      findings: [
        { id: 'web_missing_lang', label: 'No lang', severity: 'medium', kind: 'web', why: 'w' },
      ],
      rls: null,
      scanned: ['test'],
      notApplicable: internal,
    }).markdown;
    assert(
      md.includes('not applicable') && md.includes('internal tool'),
      'the report shows "not applicable" with the reason, never a bare ✅',
    );
  }
}

console.log('\n27. Guard hook command — never @latest in a settings.json');
{
  const bin = join(tmpdir(), `vibeward-bin-${process.pid}`);
  const npxCache = join(tmpdir(), `_npx`, `deadbeef`, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(npxCache, { recursive: true });
  const exe = process.platform === 'win32' ? 'vibeward.CMD' : 'vibeward';
  writeFileSync(join(bin, exe), '#!/bin/sh\n');
  writeFileSync(join(npxCache, exe), '#!/bin/sh\n');

  assert(findOnPath('vibeward', { PATH: bin }) === join(bin, exe), 'finds a binary on PATH');
  assert(findOnPath('vibeward', { PATH: '' }) === null, 'no PATH means no binary');
  assert(
    findOnPath('vibeward', { PATH: tmpdir() }) === null,
    'a directory without the binary resolves to null',
  );

  // The one that would silently break every future prompt: `npx vibeward@latest init` puts
  // its own temporary extraction on PATH, and that copy is gone by the next prompt.
  assert(
    findOnPath('vibeward', { PATH: npxCache }) === null,
    'ignores the npx cache — that copy does not survive the run',
  );
  assert(
    findOnPath('vibeward', { PATH: `${npxCache}${delimiter}${bin}` }) === join(bin, exe),
    'skips the npx cache and keeps looking down PATH',
  );

  assert(
    resolveGuard({ PATH: bin }).command === 'vibeward guard',
    'an installed binary is what the hook runs',
  );

  const fallback = resolveGuard({ PATH: '' });
  assert(fallback.binary === null, 'no binary found means the npx fallback');
  assert(
    fallback.command.startsWith('npx vibeward@') && !fallback.command.includes('@latest'),
    'the fallback is pinned to a version, never @latest',
  );
  assert(
    fallback.timeout > resolveGuard({ PATH: bin }).timeout,
    'the npx fallback gets the longer timeout — a cold download needs it',
  );

  // Every host's manifest, not just Claude Code's: `@latest` reaching any settings file is
  // the failure, and there are seven files it could reach now.
  for (const ctx of [
    { guardCommand: 'vibeward guard', guardTimeout: 10, moments: ALL_MOMENTS },
    { guardCommand: pinnedNpxGuard('9.9.9'), guardTimeout: 60, moments: ALL_MOMENTS },
  ]) {
    for (const host of HOSTS) {
      if (!host.hooks) continue;
      const rendered = hookFile(host, ctx, ALL_MOMENTS);
      // The GUARD command is what must never float: it runs on every turn, and `@latest`
      // there means executing whatever was published last, unreviewed. The `regenerate with
      // npx vibeward@latest init` hint in the header comment is a different thing — a human
      // running init on purpose — and is deliberately allowed to float.
      assert(
        !/vibeward@latest\s+guard/.test(rendered),
        `${host.id}: the guard command is never @latest (${ctx.guardCommand})`,
      );
      assert(
        rendered.includes(ctx.guardCommand),
        `${host.id}: the rendered hook actually runs the resolved command`,
      );
    }
  }

  // Migrating the hooks an older vibeward already wrote.
  assert(
    upgradeGuardCommand('npx vibeward@latest guard', 'vibeward guard') === 'vibeward guard',
    'a legacy @latest hook is repointed at the binary',
  );
  assert(
    upgradeGuardCommand('npx vibeward@latest guard --block', 'vibeward guard') ===
      'vibeward guard --block',
    'flags the user added survive the upgrade',
  );
  assert(
    upgradeGuardCommand('vibeward guard', 'vibeward guard') === null,
    'an already-migrated hook is left alone',
  );
  assert(
    upgradeGuardCommand('/opt/mine/vibeward guard', 'vibeward guard') === null,
    'a hand-written command is never rewritten',
  );
  assert(
    upgradeGuardCommand('npx vibeward@0.3.0 guard', 'vibeward guard') === null,
    'a pin the user chose is theirs to raise, not ours',
  );
}

console.log('\n28. Staleness notice — a pinned copy that knows its own age');
{
  const day = 24 * 60 * 60 * 1000;
  const released = Date.parse(`${RELEASED}T00:00:00Z`);
  const at = (days: number): Date => new Date(released + days * day);

  assert(ageInDays(at(0)) === 0, 'a fresh build is 0 days old');
  assert(ageInDays(at(45)) === 45, 'age counts whole days');
  assert(ageInDays(new Date(), 'not-a-date') === null, 'an unparseable date is null, not NaN');

  assert(stalenessNotice(at(0)) === null, 'says nothing on release day');
  assert(stalenessNotice(at(59)) === null, 'says nothing at 59 days');
  assert(stalenessNotice(at(60)) !== null, 'speaks up at 60 days');

  const old = stalenessNotice(at(200)) ?? '';
  assert(old.includes('6 months'), 'reports the age in months once it is months');
  assert(old.includes(VERSION) && old.includes(RELEASED), 'names the version and its date');
  assert(old.includes('npm i -g vibeward@latest'), 'gives the one command that fixes it');
  // It has no network, so it must not pretend to know a newer version exists.
  assert(
    !/new(er)? version (is )?available/i.test(old),
    'claims only what it can know offline: its own age, not that an update exists',
  );

  // The constant is hand-maintained next to VERSION. These catch the two ways that rots.
  assert(ageInDays() !== null, 'RELEASED in the shipped build actually parses');
  assert((ageInDays() ?? -1) >= 0, 'RELEASED is not in the future');
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
