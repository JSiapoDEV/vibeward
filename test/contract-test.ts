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
import { localize, coverage } from '../src/core/i18n.js';
import { buildReport, webCheckCoverage } from '../src/reporters/markdown.js';
import { folderCoverage } from '../src/scanners/folder.js';
import { AREA, isComplete } from '../src/core/coverage.js';
import type { CoverageEntry } from '../src/core/coverage.js';
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

console.log('\nContract — every finding can be read in Spanish\n');
{
  // The failure mode this exists to prevent is silent: `localize` falls back to English
  // field by field, so a finding added without a translation produces a report that is
  // Spanish everywhere except the paragraph the reader most needs. Nobody notices until a
  // client does. Asserting it here makes an untranslated finding a red build instead.
  const findings = everyFinding();

  const untranslated = findings.filter((f) => !f.es);
  assert(
    untranslated.length === 0,
    `every finding carries an es overlay${untranslated.length ? ` — ${[...new Set(untranslated.map((f) => f.id))].join(', ')}` : ''}`,
  );

  const noLabel = findings.filter((f) => f.es && !f.es.label);
  assert(noLabel.length === 0, 'every overlay translates the label a reader sees first');

  // `why` carries the remediation. A translation that omits it is the one that matters.
  const shallow = findings.filter((f) => f.es && (f.es.why ?? '').length < 40);
  assert(
    shallow.length === 0,
    `every overlay explains itself in Spanish${shallow.length ? ` — ${[...new Set(shallow.map((f) => f.id))].join(', ')}` : ''}`,
  );

  const copied = findings.filter((f) => f.es?.why && f.es.why === f.why);
  assert(copied.length === 0, 'no overlay is the English text pasted into the Spanish slot');

  // Applying it must produce a finding, not a finding plus a second copy of itself.
  const applied = findings.map((f) => localize(f, 'es'));
  assert(
    applied.every((f) => !('es' in f)),
    'localize removes the overlay it applied, so no output ships both languages',
  );
  assert(
    applied.every((f, i) => f.id === findings[i]!.id && f.severity === findings[i]!.severity),
    'and it translates prose only — ids and severities are identifiers, not copy',
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

console.log('\nContract — a clean report says what it did not look at\n');
{
  // The defect this asserts against: `findings: []` reads as "checked and clean", and until
  // the payload carried coverage there was nothing in it that could say "never looked". An
  // agent summarising a passive scan of a Supabase app reported the first.
  const gap: CoverageEntry = {
    id: AREA.supabaseRls,
    status: 'not_evaluated',
    detail: coverage('--passive: the data API was never read', '--passive: nunca se leyó la API'),
  };
  const ran: CoverageEntry = {
    id: AREA.httpHeaders,
    status: 'checked',
    detail: coverage('HTTP security headers', 'Cabeceras de seguridad HTTP'),
  };
  const moot: CoverageEntry = {
    id: AREA.firebaseRules,
    status: 'not_applicable',
    detail: coverage('no Firebase config found', 'no se encontró configuración de Firebase'),
  };

  assert(!isComplete([ran, gap]), 'a skipped area makes the scan incomplete');
  assert(isComplete([ran, moot]), 'an area that cannot exist here does not');
  assert(isComplete([]), 'a ledger with no gaps is complete');

  const { markdown } = buildReport({
    target: 'https://demo.test',
    dateISO: '2026-08-24',
    findings: [],
    rls: null,
    scanned: [ran, gap, moot],
    lang: 'en',
  });

  // The gap used to be pushed into the same list as the verifications and printed under the
  // "Verified automatically" heading — a skipped probe rendered as something the scan had
  // done. Assert the two lists are separated, by checking the order they appear in.
  const verifiedAt = markdown.indexOf('Verified automatically');
  const notVerifiedAt = markdown.indexOf('Not verified in this run');
  const gapAt = markdown.indexOf('the data API was never read');
  assert(notVerifiedAt > verifiedAt, 'the report has a section for what was not verified');
  assert(gapAt > notVerifiedAt, 'a skipped area is listed there, not under what was verified');
  assert(
    markdown.indexOf('HTTP security headers') < notVerifiedAt,
    'and a real verification stays under the verified heading',
  );
}

console.log('\nContract — a config file cannot turn a failure into "not evaluated"\n');
{
  // Security findings already cannot be suppressed. This is the same promise one level up:
  // `vibeward.json` may hide a website finding from the table, and the `suppressed` list
  // discloses that — but it must never be able to move the check into the coverage record's
  // blind spots, which is where a reader stops expecting an answer at all.
  const rows = webCheckCoverage(true, new Map(), new Map());
  const blind = rows.filter((r) => r.status !== 'checked');
  assert(
    blind.length === 0,
    `with every input present, every website check is checked${blind.length ? ` — ${blind.map((r) => r.id).join(', ')}` : ''}`,
  );

  // The two genuine blind spots, each measured by vibeward rather than declared by anyone.
  const noBrowser = webCheckCoverage(false, new Map(), new Map());
  assert(
    noBrowser.find((r) => r.id === 'web_console_errors')?.status === 'not_evaluated',
    'a check needing a browser is not evaluated when there is none',
  );
  const onePage = webCheckCoverage(
    true,
    new Map(),
    new Map([['web_duplicate_titles', coverage('only 1 page crawled', 'solo 1 página')]]),
  );
  assert(
    onePage.find((r) => r.id === 'web_duplicate_titles')?.status === 'not_evaluated',
    'a check with nothing to measure is not evaluated either',
  );
}

console.log('\nContract — a folder scan admits what a folder cannot show\n');
{
  const supabaseNoSql = folderCoverage({
    dir: '.',
    filesScanned: 40,
    migrations: 0,
    supabaseContext: true,
    supabaseExport: false,
  });
  const sql = supabaseNoSql.find((e) => e.id === AREA.sqlMigrations);
  // A Supabase project managing its schema in the dashboard has no .sql here, so every RLS
  // rule finds nothing. Reporting that as a pass is the exact shape of CVE-2025-48757.
  assert(
    sql?.status === 'not_evaluated',
    'a Supabase project with no .sql files reports RLS as not evaluated, not as clean',
  );
  assert(
    (sql?.detail.en ?? '').includes('supabase-sql') &&
      (sql?.detail.es ?? '').includes('supabase-sql'),
    'and says, in both languages, how to cover it',
  );

  const plain = folderCoverage({
    dir: '.',
    filesScanned: 40,
    migrations: 0,
    supabaseContext: false,
    supabaseExport: false,
  });
  assert(
    plain.find((e) => e.id === AREA.sqlMigrations)?.status === 'not_applicable',
    'a project that is not Supabase at all is not accused of a gap',
  );

  // Whatever it found, a folder scan never contacted the live database.
  for (const scan of [supabaseNoSql, plain]) {
    assert(
      scan.find((e) => e.id === AREA.supabaseRls)?.status === 'not_evaluated',
      'a folder scan never claims to have covered the deployed backend',
    );
  }
  assert(!isComplete(plain), 'so no folder scan reports itself as complete coverage');

  const untranslated = [...supabaseNoSql, ...plain].filter((e) => e.detail.en === e.detail.es);
  assert(
    untranslated.length === 0,
    `every coverage line is genuinely translated${untranslated.length ? ` — ${untranslated.map((e) => e.id).join(', ')}` : ''}`,
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

  // The payload gained a coverage block; the instructions have to make an agent read it,
  // or the honesty is present in the JSON and absent from the sentence the user actually
  // sees. This is the assertion that connects the two.
  assert(
    /coverage\.notEvaluated/.test(INSTRUCTION) && /coverage\.complete/.test(INSTRUCTION),
    'the skill tells the agent to read the coverage block, by key name',
  );
  assert(
    /you write the word "clean"/i.test(INSTRUCTION),
    'and to check it before calling anything clean',
  );
  assert(
    /Never fill a gap yourself/.test(INSTRUCTION),
    'and not to substitute its own reading for a check that did not run',
  );

  // The gate moved: nothing is asked to read public assets, and the one question left is
  // asked before reading rows out of a backend. `--yes` answers that question in advance, so
  // it is the flag the installed instructions have to warn an agent about — the old text
  // warned about `--passive`, which no longer guards anything an agent can get wrong.
  assert(
    /Do not pass `--yes` on your own/.test(INSTRUCTION),
    'the skill tells the agent not to pre-authorize a data probe by itself',
  );
  assert(
    /not authorization/i.test(INSTRUCTION),
    'and that a URL appearing in the conversation is not permission',
  );
  assert(
    !/skips the interactive authorization prompt/.test(INSTRUCTION),
    'and it no longer describes a prompt that fires before anything is probed',
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
