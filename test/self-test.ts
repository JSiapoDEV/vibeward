// Self-test with SYNTHETIC data (no real secrets). Validates detection logic
// without touching any external system. Run with: npm test
import { scanText, scanSource, extractSupabaseConfig } from '../src/lib/secrets.js';
import { checkHeaders } from '../src/lib/headers.js';
import { buildReport } from '../src/lib/report.js';
import { analyzeMigrations } from '../src/lib/migrations.js';
import { analyzeSupabaseExport } from '../src/lib/supabase.js';
import { toSarif } from '../src/lib/sarif.js';
import { scanIntent } from '../src/lib/intent.js';

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

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
