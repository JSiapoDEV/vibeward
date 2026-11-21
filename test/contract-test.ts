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
import {
  INSTRUCTION,
  SKILLS,
  skillFile,
  claudeMdBlock,
  agentsBlock,
} from '../src/init/templates.js';
import { localize, coverage } from '../src/core/i18n.js';
import { buildReport, webCheckCoverage } from '../src/reporters/markdown.js';
import { folderCoverage } from '../src/scanners/folder.js';
import { checkUploadValidation } from '../src/checks/uploads.js';
import { AREA, isComplete } from '../src/core/coverage.js';
import type { CoverageEntry } from '../src/core/coverage.js';
import type { Finding } from '../src/core/types.js';
import type { SiteFiles } from '../src/http/crawl.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { REPORT_DIR, unignoredInRepo, writeReportFile } from '../src/reporters/files.js';

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
    ...[
      checkUploadValidation(
        'app/api/upload/route.ts',
        "const d = await req.formData();\nif (!file.type.startsWith('image/')) return;",
      ),
    ].filter((f): f is Finding => f !== null),
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
  // On its own initiative — not over the owner. An instruction that told a developer's agent to
  // refuse the developer's own request put vibeward above the person whose repository it is.
  assert(
    /on your own initiative/i.test(INSTRUCTION) &&
      /If the user then asks you to fix/.test(INSTRUCTION),
    'the skill lets the user ask for a fix, and only forbids fixing unasked',
  );
  assert(
    !/even if asked|not when the user asks you to|not on request/i.test(INSTRUCTION),
    'no installed instruction tells the agent to refuse the user',
  );
  assert(
    /what it does not undo|still has to be rotated/i.test(INSTRUCTION),
    'a requested fix comes with what it does not undo',
  );
  const noSupabase = claudeMdBlock({ supabase: false });
  const withSupabase = claudeMdBlock({ supabase: true });
  const unknown = claudeMdBlock();
  assert(
    !/supabase|service_role|sb_secret/i.test(noSupabase),
    'CLAUDE.md rules do not mention Supabase in a project without it',
  );
  assert(/\*\*Supabase:\*\*/.test(withSupabase), 'and name it plainly in a project that uses it');
  assert(
    /If the project uses Supabase/.test(unknown),
    'a user-level file, which serves every repository, says "if"',
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
  //
  // Asserted across every skill in the set, not just the first: the whole reason for shipping
  // three is that a host picks one by matching its description, so a skill that ships with a
  // broken or feeble description is a skill that silently never loads.
  const untriggerable: string[] = [];
  const truncated: string[] = [];
  const unmarked: string[] = [];
  const misnamed: string[] = [];
  for (const spec of SKILLS) {
    const file = skillFile(spec);
    const description = /^description: (.*)$/m.exec(file)?.[1] ?? '';
    if (description.length <= 80) untriggerable.push(spec.name);
    // A plain YAML scalar ends at the first `: `, so a colon inside the description silently
    // truncates it. The key's own separator is fine; anything after it is not.
    if (description.includes(': ')) truncated.push(spec.name);
    if (!/vibeward v\d+\.\d+\.\d+/.test(file)) unmarked.push(spec.name);
    // `name` has to equal the directory `build-plugin.mjs` writes it into, and most hosts
    // invoke from that directory rather than from this field.
    if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) misnamed.push(spec.name);
    if (!new RegExp(`^name: ${spec.name}$`, 'm').test(file)) misnamed.push(spec.name);
  }
  assert(SKILLS.length >= 3, `the set ships every entry point (${SKILLS.length} skills)`);
  assert(
    new Set(SKILLS.map((s) => s.name)).size === SKILLS.length,
    'no two skills share a name, which would collide in one skills/ directory',
  );
  assert(untriggerable.length === 0, `every skill declares a description — ${untriggerable}`);
  assert(truncated.length === 0, `no description has a colon-space — ${truncated}`);
  assert(unmarked.length === 0, `every skill carries the version mark — ${unmarked}`);
  assert(misnamed.length === 0, `every skill name is a directory-safe slug — ${misnamed}`);

  // The prohibition travels with every skill. The setup skills do not carry the full argument
  // — that would be the duplication the templates exist to avoid — but an agent must not be
  // able to reach one of them and find no statement of it at all.
  const silent = SKILLS.filter((spec) => !/does not fix|do not fix|never fix/i.test(spec.body()));
  assert(
    silent.length === 0,
    `every skill states that vibeward does not fix — ${silent.map((s) => s.name)}`,
  );
}

console.log("\nContract — the setup skills do not act on the user's behalf\n");
{
  const install = SKILLS.find((s) => s.name === 'install-vibeward-guardrails')?.body() ?? '';
  const ci = SKILLS.find((s) => s.name === 'ci-security-scanning-with-vibeward')?.body() ?? '';
  assert(install.length > 500 && ci.length > 500, 'both setup skills have a real body');

  // `init` writes into somebody's repository and their editor config. An agent that picks the
  // targets itself has edited a project nobody asked it to edit — the behaviour vibeward
  // exists to catch, committed by the tool's own instructions.
  assert(
    /What is wrong is choosing for them/.test(install) &&
      /Do not pick targets from what you find in the tree/.test(install),
    'the install skill makes the agent leave the choice to the user',
  );
  // `init` refuses to run without a TTY, and an agent calling it from a tool has none. A skill
  // that just prints the bare command sends the agent into a dead end it cannot read its way
  // out of, so the non-interactive form and its required `--scope` have to be spelled out.
  assert(
    /refuses to run without a terminal/.test(install) &&
      /--scope` is required in this non-interactive form/.test(install),
    'and says why the bare command dead-ends for an agent, with the form that does not',
  );

  // The two CI-specific ways to quietly hand away a guarantee.
  assert(
    /pin the action by commit SHA, not by tag/i.test(ci),
    'the CI skill says to pin the action by SHA',
  );
  assert(
    // Whitespace-tolerant: the body is authored as wrapped lines, so a fixed space would
    // make this assertion depend on where the sentence happens to break.
    /Never put `--yes` in a\s+workflow file/.test(ci),
    'and never to pre-authorize a live data probe where nobody can see the prompt',
  );
  // A pipeline that fails on "non-zero" reports a broken scanner as a finding; one that passes
  // on "not 2" reports a crashed scanner as a clean repo.
  assert(
    /`1`/.test(ci) && /`2`/.test(ci) && /Do not treat this as a pass/.test(ci),
    'and tells the pipeline to tell a failed scan apart from a failing one',
  );
  assert(
    /coverage\.notEvaluated/.test(ci),
    'and not to let a green build overstate its own coverage',
  );
}

console.log('\nA report never waits in git to be committed');
{
  // A report names where an app is exposed. Written into the repository it was one
  // `git add .` from being published; this is the promise that it cannot be.
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  const repo = mkdtempSync(join(tmpdir(), 'vw-git-'));
  const hasGit = git(repo, 'init', '-q').status === 0;
  if (!hasGit) {
    console.log('  (git not installed — skipped)');
  } else {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-qm', 'init');

    // The real CLI, run from inside the repository the way a person or an agent runs it.
    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const run = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cli, 'scan', '.', '--json'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
      },
    );
    assert(run.status === 0, `the scan ran (exit ${run.status})`);
    const report = join(repo, REPORT_DIR, `vibeward-report-${basename(repo)}.md`);
    assert(
      existsSync(report) && existsSync(join(repo, '.vibeward', '.gitignore')),
      'the default report lands in .vibeward/reports/, named after the folder, next to an ignore file',
    );
    assert(
      /^\*$/m.test(readFileSync(join(repo, '.vibeward', '.gitignore'), 'utf8')),
      'and the folder ignores everything in it',
    );
    assert(existsSync(report.replace(/\.md$/, '.json')), '--json lands beside it');
    const status = git(repo, 'status', '--porcelain', '--untracked-files=all').stdout.trim();
    assert(
      status === '',
      `git status stays clean after a scan${status ? ` — saw: ${status}` : ''}`,
    );
    assert(
      !/not ignored/.test(`${run.stdout}${run.stderr}`),
      'and nothing is flagged as trackable',
    );

    // An explicit --out into the tracked tree is allowed, and said out loud.
    const out = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), cli, 'scan', '.', '--out', 'report.md'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
      },
    );
    assert(
      /report\.md is inside a git repository and not ignored/.test(`${out.stdout}${out.stderr}`),
      '--out into the repository warns that git would pick it up',
    );

    writeReportFile(join(repo, '.vibeward', 'reports', 'b.md'), '# b');
    assert(
      unignoredInRepo([join(repo, '.vibeward', 'reports', 'b.md')], {}).length === 0,
      'files under .vibeward/ are ignored',
    );
    assert(
      unignoredInRepo([join(repo, 'report.md')], {}).length === 1,
      'a file at the root is not',
    );
    assert(
      unignoredInRepo([join(repo, 'report.md')], { CI: 'true' }).length === 0,
      'in CI there is nothing to warn about',
    );
    const outside = mkdtempSync(join(tmpdir(), 'vw-nogit-'));
    assert(
      unignoredInRepo([join(outside, 'r.md')], {}).length === 0,
      'outside a repository there is nothing to warn about',
    );
    rmSync(outside, { recursive: true, force: true });
  }
  rmSync(repo, { recursive: true, force: true });
}

console.log('\ninit in a real repository — personal hooks, backups out of the tree');
{
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    });
  const repo = mkdtempSync(join(tmpdir(), 'vw-init-'));
  const home = mkdtempSync(join(tmpdir(), 'vw-home-'));
  if (git(repo, 'init', '-q').status === 0) {
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, 'CLAUDE.md'), '# Proyecto\n\nReglas del equipo.\n');
    // A shared settings file as 0.8.0 left it: our guard beside the team's own hook.
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify(
        {
          permissions: { allow: ['Bash(npm test)'] },
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: 'npx vibeward@0.8.0 guard',
                    vibeward: 'vibeward v0.8.0',
                  },
                  { type: 'command', command: './scripts/team-hook.sh' },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'npx vibeward@0.8.0 guard',
                    vibeward: 'vibeward v0.8.0',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');

    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        cli,
        'init',
        '--scope',
        'project',
        '--targets',
        'claude-code,claude-md',
        '--moments',
        'prompt,action',
        '--yes',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', CI: '' },
      },
    );
    assert(
      run.status === 0,
      `init ran (exit ${run.status})${run.status ? ` — ${run.stderr.slice(0, 200)}` : ''}`,
    );

    const local = readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8');
    // The local copy is `bin/vibeward.mjs`, which only exists once `npm run build:plugin` ran.
    // The publish workflow tests before it builds, so without it init falls back to the pin.
    const built = existsSync(join(import.meta.dirname, '..', 'bin', 'vibeward.mjs'));
    assert(
      /"Stop"/.test(local) &&
        (built
          ? /vibeward\.mjs\\?" guard/.test(local) && !/npx/.test(local)
          : /vibeward@\d+\.\d+\.\d+ guard/.test(local)),
      built
        ? 'the Claude Code hooks go to settings.local.json and run the local copy, not npx'
        : 'the Claude Code hooks go to settings.local.json (pinned npx until bin/ is built)',
    );
    const shared = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
    const sharedText = JSON.stringify(shared);
    assert(
      !/vibeward/.test(sharedText) &&
        /team-hook\.sh/.test(sharedText) &&
        shared.permissions?.allow?.length === 1,
      "the old guard leaves the shared settings.json; the team's hook and permissions stay",
    );
    assert(
      !existsSync(join(repo, '.vibeward', 'backups')) &&
        !existsSync(join(repo, 'CLAUDE.md.vibeward.bak')),
      'files git already has committed are not copied: the commit is the backup',
    );
    writeFileSync(join(repo, 'AGENTS.md'), '# Untracked notes\n');
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        cli,
        'init',
        '--scope',
        'project',
        '--targets',
        'agents-md',
        '--yes',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', CI: '' },
      },
    );
    assert(
      existsSync(join(repo, '.vibeward', 'backups', 'AGENTS.md.bak')),
      'a file git cannot restore — untracked — is copied to .vibeward/backups/ first',
    );
    assert(
      !/[Ss]upabase/.test(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')),
      'CLAUDE.md does not mention Supabase in a project without it',
    );

    const status = git(repo, 'status', '--porcelain', '--untracked-files=all').stdout;
    assert(
      !/settings\.local\.json|\.vibeward|\.bak/.test(status),
      `git sees none of the personal files${/settings\.local|\.vibeward|\.bak/.test(status) ? ` — saw: ${status}` : ''}`,
    );
    assert(
      /CLAUDE\.md/.test(status) && /settings\.json/.test(status),
      'only the two edited, tracked files show as modified',
    );
  }
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log('\nThe pending-items issue — what the Action does with it');
{
  // action/issue.mjs is run exactly as action.yml runs it: a file in, a word out.
  const script = join(import.meta.dirname, '..', 'action', 'issue.mjs');
  const work = mkdtempSync(join(tmpdir(), 'vw-issue-'));
  const decide = (old: string, state: 'OPEN' | 'CLOSED' | 'NONE', summary: string) => {
    writeFileSync(join(work, 'old.md'), old);
    writeFileSync(join(work, 'summary.md'), summary);
    const out = join(work, 'new.md');
    rmSync(out, { force: true });
    const run = spawnSync(
      process.execPath,
      [script, join(work, 'old.md'), join(work, 'summary.md'), state, out],
      { encoding: 'utf8' },
    );
    return {
      action: run.stdout,
      body: existsSync(out) ? readFileSync(out, 'utf8') : '',
      error: run.stderr,
    };
  };
  const ticked = (body: string) =>
    [...body.matchAll(/^- \[([ x])\] \*\*\w+\*\* — (\w+)/gm)].map((m) => `${m[1]}${m[2]}`);
  // The summary's own shape: an item, then its files indented on the line below.
  const summary = (items: [string, string[]][]) =>
    `<!-- vibeward:summary findings=0 critical=0 pending=${items.length} -->\n## vibeward\n\n### Pending\n\n` +
    items
      .map(
        ([name, files]) =>
          `- [ ] **Review** — ${name} needs a look.\n` +
          (files.length ? `  Files: ${files.map((f) => `\`${f}\``).join(', ')}\n` : ''),
      )
      .join('') +
    '\n<sub>footer</sub>\n';
  const tick = (body: string, ...names: string[]) =>
    body.replace(/^- \[ \] (\*\*\w+\*\* — (\w+).*)$/gm, (line, rest, name) =>
      names.includes(name) ? `- [x] ${rest}` : line,
    );

  const first = summary([
    ['html', ['src/comment.js']],
    ['idor', ['server/index.js']],
  ]);
  let r = decide('', 'NONE', first);
  assert(
    r.action === 'create' && ticked(r.body).join() === ' html, idor',
    `no issue yet: one is created, nothing ticked${r.error ? ` — ${r.error.slice(0, 200)}` : ''}`,
  );
  assert(
    decide('', 'NONE', '## vibeward\n\nNothing.\n').action === 'none',
    'nothing pending, no issue',
  );

  r = decide(tick(first, 'html'), 'OPEN', first);
  assert(
    r.action === 'edit' && ticked(r.body).join() === 'xhtml, idor',
    'the same issue is edited, and a tick on an unchanged item holds',
  );

  const grown = summary([
    ['html', ['src/comment.js', 'src/profile.js']],
    ['idor', ['server/index.js']],
  ]);
  r = decide(tick(first, 'html'), 'OPEN', grown);
  assert(
    ticked(r.body).join() === ' html, idor',
    'a tick does not survive a new file joining the item — a new sink is not "reviewed"',
  );
  r = decide(tick(grown, 'html'), 'OPEN', first);
  assert(ticked(r.body)[0] === 'xhtml', 'it survives a file leaving the item (that one was fixed)');

  r = decide(tick(first, 'html', 'idor'), 'OPEN', first);
  assert(
    r.action === 'close' && ticked(r.body).join() === 'xhtml,xidor',
    'everything ticked: the issue closes, with the list as it stood',
  );

  // The two that broke on a real repository: a closed issue came back as a NEW one, with
  // every item unticked, on the very next push.
  r = decide(tick(first, 'html', 'idor'), 'CLOSED', first);
  assert(r.action === 'none', 'closed with everything ticked: the next push leaves it closed');
  r = decide(first, 'CLOSED', first);
  assert(
    r.action === 'none',
    'closed by hand with items unticked: closing it was the answer, it stays closed',
  );
  const added = summary([
    ['html', ['src/comment.js']],
    ['idor', ['server/index.js']],
    ['ssrf', ['server/index.js']],
  ]);
  r = decide(first, 'CLOSED', added);
  assert(
    r.action === 'reopen' && ticked(r.body).join() === 'xhtml,xidor, ssrf',
    'something new: the same issue reopens, and only the new item is unticked',
  );
  r = decide(first, 'CLOSED', grown);
  assert(
    r.action === 'reopen' && ticked(r.body).join() === ' html,xidor',
    'a new file in a listed item reopens it too, with that item unticked',
  );

  // A list cut at eight files hides the rest: only the very same lines keep a tick.
  const cut = (n: number) =>
    `- [ ] **Review** — html needs a look.\n  Files: \`a.js\`, \`b.js\` and ${n} more\n`;
  assert(
    ticked(decide(tick(cut(3), 'html'), 'OPEN', cut(3)).body)[0] === 'xhtml',
    'a cut list, unchanged: the tick holds',
  );
  assert(
    ticked(decide(tick(cut(3), 'html'), 'OPEN', cut(4)).body)[0] === ' html',
    'a cut list that grew behind "and N more": the tick goes',
  );
  assert(
    ticked(decide(tick(first, 'html').replace(/\n/g, '\r\n'), 'OPEN', first).body)[0] === 'xhtml',
    'a body saved from the browser with CRLF line endings still has its ticks read',
  );
  const es = '- [ ] **Revisar** — html revisa.\n  Archivos: `a.js` y 2 más\n';
  assert(
    /^- \[x\]/.test(decide(es.replace('- [ ]', '- [X]'), 'OPEN', es).body),
    'Spanish, and a capital X, read the same',
  );

  // End to end with the CLI's own summary, so the format above cannot drift from the real one.
  const app = join(work, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  writeFileSync(
    join(app, 'src', 'comment.js'),
    "export const show = (el, c) => { el.innerHTML = '<p>' + c.body + '</p>'; };\n",
  );
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const scan = (out: string) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        cli,
        'scan',
        app,
        '--summary',
        out,
        '--public-summary',
        '--yes',
      ],
      { encoding: 'utf8', env: { ...process.env, CI: '1' } },
    );
  scan(join(work, 'real-1.md'));
  const real1 = existsSync(join(work, 'real-1.md'))
    ? readFileSync(join(work, 'real-1.md'), 'utf8')
    : '';
  writeFileSync(
    join(app, 'src', 'profile.js'),
    "export const bio = (el, p) => { el.innerHTML = '<div>' + p.bio + '</div>'; };\n",
  );
  scan(join(work, 'real-2.md'));
  const real2 = existsSync(join(work, 'real-2.md'))
    ? readFileSync(join(work, 'real-2.md'), 'utf8')
    : '';
  const htmlTicked = (body: string) =>
    /^- \[x\] \*\*Review\*\* — Check that nothing a user typed/m.test(body);
  const owner = real1.replace(
    /^- \[ \] (\*\*Review\*\* — Check that nothing a user typed)/m,
    '- [x] $1',
  );
  assert(
    htmlTicked(owner) && htmlTicked(decide(owner, 'OPEN', real1).body),
    'the real summary: a ticked HTML-sink review holds while the code does not change',
  );
  assert(
    real2.includes('src/profile.js') && !htmlTicked(decide(owner, 'OPEN', real2).body),
    'and goes when a second file with innerHTML appears',
  );

  const yml = readFileSync(join(import.meta.dirname, '..', 'action.yml'), 'utf8');
  assert(
    /gh issue list[^\n]*--state all/.test(yml) && yml.includes('action/issue.mjs'),
    'action.yml looks for the issue open or closed, and lets action/issue.mjs decide',
  );
  assert(
    !/gh issue create[\s\S]*gh issue create/.test(yml),
    'and has one way to create an issue, not two',
  );
  rmSync(work, { recursive: true, force: true });
}

console.log(
  fail === 0 ? `\n✅  ${pass} passed, 0 failed\n` : `\n❌  ${pass} passed, ${fail} failed\n`,
);
if (fail > 0) process.exit(1);
