// Generates a SAMPLE report from synthetic data, scanning nobody.
// Use it as sales collateral: it is identical to what a client receives.
import { writeFileSync } from 'node:fs';
import { buildReport } from './lib/report.js';
import type { Finding } from './lib/types.js';
import type { RlsResult } from './lib/supabase.js';

const SUPABASE_REFS = [
  'https://supabase.com/docs/guides/database/postgres/row-level-security',
  'https://cwe.mitre.org/data/definitions/863.html',
  'https://nvd.nist.gov/vuln/detail/CVE-2025-48757',
];

const findings: Finding[] = [
  {
    id: 'supabase_service_role',
    label: 'Supabase service_role key in the client',
    severity: 'critical',
    check: 6,
    cwe: 'CWE-798',
    source: 'https://demo-shop.lovable.app/assets/index-a1b2c3.js',
    evidence: 'JWT role=service_role',
    exploit:
      'The service_role key ships in the client bundle. Anyone can extract it and hit the Supabase API with full privileges, bypassing every RLS policy — read, modify or delete any table.',
    impact:
      'Total database access for anyone who views the page, regardless of your security rules.',
    why: 'This is the single most dangerous exposure possible. Rotate it today.',
    references: [
      'https://cwe.mitre.org/data/definitions/798.html',
      'https://supabase.com/docs/guides/api/api-keys',
    ],
  },
  {
    id: 'stripe_secret',
    label: 'Stripe secret key',
    severity: 'critical',
    check: 2,
    cwe: 'CWE-798',
    source: 'https://demo-shop.lovable.app/assets/checkout-9f8e7d.js',
    evidence: 'sk_live_…a4F2',
    exploit:
      'With this key an attacker can create charges, refund to their own cards and read your customer and payment records via the Stripe API.',
    impact: 'Money and payment data at risk.',
    why: 'A leaked Stripe secret key can drain money and expose payment data. Rotate it immediately.',
    references: ['https://cwe.mitre.org/data/definitions/798.html', 'https://stripe.com/docs/keys'],
  },
  {
    id: 'missing_header_content-security-policy',
    label: 'Missing Content-Security-Policy header',
    severity: 'medium',
    check: 22,
    cwe: 'CWE-693',
    evidence: 'Absent from the response',
    exploit:
      'Without a CSP, an injected or third-party script can load and run from any origin, exfiltrating tokens or user data.',
    why: 'The main defense-in-depth against cross-site scripting is missing.',
    references: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP'],
  },
];

const rls: RlsResult = {
  projectUrl: 'https://demoproject1234567890.supabase.co',
  probed: 60,
  exposedCount: 3,
  exposed: [
    {
      table: 'users',
      status: 'exposed',
      readable: true,
      rowsTotal: 1847,
      columns: 9,
      leakedColumns: ['email', 'phone', 'full_name'],
    },
    {
      table: 'orders',
      status: 'exposed',
      readable: true,
      rowsTotal: 5231,
      columns: 12,
      leakedColumns: ['email', 'address'],
    },
    {
      table: 'api_keys',
      status: 'exposed',
      readable: true,
      rowsTotal: 12,
      columns: 4,
      leakedColumns: ['api_key', 'token'],
    },
  ],
  piiTables: [
    { table: 'users', status: 'exposed', leakedColumns: ['email', 'phone', 'full_name'] },
    { table: 'orders', status: 'exposed', leakedColumns: ['email', 'address'] },
    { table: 'api_keys', status: 'exposed', leakedColumns: ['api_key', 'token'] },
  ],
  allResults: [],
};

for (const t of rls.exposed) {
  const cols = t.leakedColumns!.join(', ');
  findings.push({
    id: `rls_exposed_${t.table}`,
    label: `Table '${t.table}' readable without authentication (contains personal data)`,
    severity: 'critical',
    check: 6,
    cwe: 'CWE-863',
    source: `${rls.projectUrl}/rest/v1/${t.table}`,
    evidence: `${t.rowsTotal} rows readable with only the public anon key; sensitive columns: ${cols}`,
    exploit: `Any visitor sends \`GET /rest/v1/${t.table}?select=*\` with the anon key (visible in the JS bundle) and every row comes back — no login required.`,
    impact: `~${t.rowsTotal} records including ${cols} are readable by anyone on the internet right now. Active personal-data leak (GDPR / consumer-protection exposure).`,
    why: 'A table with personal data is world-readable. This is a live breach, not a theoretical risk: RLS is missing or misconfigured.',
    references: SUPABASE_REFS,
    meta: { table: t.table },
  });
}

const { markdown } = buildReport({
  target: 'https://demo-shop.lovable.app',
  dateISO: '2026-08-09',
  findings,
  rls,
  scanned: [
    'HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)',
    'Exposed secrets/credentials in 14 JavaScript bundle(s)',
    'Supabase Row Level Security (60 common tables probed)',
  ],
});

const out = process.argv[2] ?? 'informe-ejemplo.md';
writeFileSync(out, markdown, 'utf8');
console.log(`✓ Sample report generated: ${out}`);
