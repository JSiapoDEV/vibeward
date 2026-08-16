// The contract, asserted rather than documented.
//
// Every other suite here checks that a detector detects. This one checks the promises in the
// README — that vibeward reports and never repairs, that security cannot be silenced by a
// config file, and that the instructions it installs say so. Those are the properties that
// kept getting re-litigated, and a paragraph in a README does not survive a refactor. A test
// does.
import { checkWeb, parsePage } from '../src/checks/web.js';
import { scanText, scanSource } from '../src/checks/secrets.js';
import { analyzeMigrations } from '../src/checks/migrations.js';
import { checkHeaders } from '../src/checks/headers.js';
import { analyzeSupabaseExport } from '../src/checks/supabase.js';
import { parseConfig, applySuppressions } from '../src/core/config.js';
import { INSTRUCTION, skillFile, claudeMdBlock, agentsBlock } from '../src/init/templates.js';
import type { Finding } from '../src/core/types.js';
import type { SiteFiles } from '../src/http/crawl.js';

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

function fakeJwt(role: string): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase', ref: 'x'.repeat(20) })}.${'s'.repeat(43)}`;
}

/** Every detector, pointed at input that makes it fire, so the sweep sees real findings. */
function everyFinding(): Finding[] {
  const emptyFiles: SiteFiles = {
    robotsTxt: 'User-agent: GPTBot\nDisallow: /',
    sitemapXml: null,
    llmsTxt: null,
    faviconOk: false,
    notFound: { status: 200, distinct: false },
  } as SiteFiles;

  return [
    ...checkWeb({
      pages: [
        parsePage(
          '<html><head></head><body><div id="root"></div></body></html>',
          'https://x.test/',
        ),
      ],
      files: emptyFiles,
      brokenAssets: [{ url: 'https://x.test/a.png', status: 404, from: 'https://x.test/' }],
      jsBytes: 2_000_000,
      consoleErrors: [{ type: 'error', text: 'boom' }] as never,
    }),
    ...scanText(`const k = "${fakeJwt('service_role')}"`, 'bundle.js'),
    ...scanSource(`const s = "sk_live_${'a'.repeat(30)}"`, 'src/pay.ts'),
    ...analyzeMigrations([
      {
        path: '001.sql',
        content:
          'CREATE TABLE profiles (id uuid); ALTER TABLE profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE profiles DISABLE ROW LEVEL SECURITY; DROP POLICY own_rows ON profiles; CREATE POLICY p ON profiles FOR SELECT USING (true);',
      },
    ]),
    ...checkHeaders(new Headers()),
    ...analyzeSupabaseExport({ tables: [] } as never),
  ];
}

console.log('\nContract — vibeward reports, it does not repair\n');
{
  const findings = everyFinding();
  assert(findings.length > 10, `the sweep actually produced findings (${findings.length})`);

  const withFix = findings.filter((f) => 'fix' in f || 'autofix' in f);
  assert(
    withFix.length === 0,
    `no finding carries fix/autofix${withFix.length ? ` — ${withFix.map((f) => f.id).join(', ')}` : ''}`,
  );

  // A finding with nothing but a label is not a report, it is an accusation. `why` is the
  // field that now has to carry what `fix` used to.
  const mute = findings.filter((f) => typeof f.why !== 'string' || f.why.length < 40);
  assert(
    mute.length === 0,
    `every finding explains itself in why${mute.length ? ` — ${mute.map((f) => f.id).join(', ')}` : ''}`,
  );
}

console.log('\nContract — security cannot be silenced by a config file\n');
{
  const parsed = parseConfig(
    JSON.stringify({
      suppress: [
        { id: 'supabase_service_role', reason: 'later' },
        { id: 'rls_turned_off_profiles', reason: 'later' },
        { id: 'web_missing_og', reason: 'private landing' },
      ],
    }),
  );
  const ids = (parsed.config.suppress ?? []).map((s) => s.id);
  assert(!ids.includes('supabase_service_role'), 'a secret finding cannot be suppressed');
  assert(!ids.includes('rls_turned_off_profiles'), 'an RLS finding cannot be suppressed');
  assert(ids.includes('web_missing_og'), 'a website finding still can');

  // Belt and braces: even if a security id smuggled itself into the list, applying it must
  // not remove the finding.
  const security: Finding = {
    id: 'supabase_service_role',
    label: 'service_role key exposed',
    severity: 'critical',
    why: 'x'.repeat(60),
  };
  const applied = applySuppressions([security], {
    schemaVersion: 1,
    suppress: [{ id: 'supabase_service_role', reason: 'forced' }],
  } as never);
  assert(
    applied.kept.some((f) => f.id === 'supabase_service_role'),
    'a forged security suppression still leaves the finding in the report',
  );
}

console.log('\nContract — the installed instructions say so\n');
{
  const forbids = [
    /never fix a finding/i,
    /it is not to make it go away/i,
    /do not fix|never fix/i,
  ];
  assert(
    forbids.every((p) => p.test(INSTRUCTION)),
    'the skill body forbids fixing in as many words',
  );
  assert(
    !/\bautofix\b/.test(
      INSTRUCTION.replace(/There is no `fix` and no `autofix`[^\n]*/g, '').replace(
        /`fix` field and without an `autofix` field[^\n]*/g,
        '',
      ),
    ),
    'the skill never references autofix except to say it does not exist',
  );

  // Every generated artifact must be identifiable as ours, or a re-run cannot tell its own
  // output from a file a human wrote and `init` would either clobber it or refuse forever.
  for (const [name, text] of [
    ['skill file', skillFile()],
    ['CLAUDE.md block', claudeMdBlock()],
    ['AGENTS.md block', agentsBlock()],
  ] as const) {
    assert(/vibeward v\d+\.\d+\.\d+/.test(text), `${name} carries the version mark`);
  }
  // A plain YAML scalar ends at the first `: `, so a colon inside the description silently
  // truncates it — and the description is the only thing that decides whether the skill is
  // ever loaded. The key's own separator is fine; anything after it is not.
  const description = /^description: (.*)$/m.exec(skillFile())?.[1] ?? '';
  assert(description.length > 80, 'the skill declares a description');
  assert(
    !description.includes(': '),
    'the description has no colon-space, which would truncate it at load time',
  );
}

console.log(
  fail === 0 ? `\n✅  ${pass} passed, 0 failed\n` : `\n❌  ${pass} passed, ${fail} failed\n`,
);
if (fail > 0) process.exit(1);
