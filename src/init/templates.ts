// Everything `init` can write, as TypeScript constants and not as .md/.yml assets: the
// build is `rm -rf dist && tsc` with no asset copying, so a template kept as a real file
// would never reach dist/ and `init` would break only in the published package.
//
// The instruction text exists exactly once. Each target only wraps it in its own
// frontmatter, so N targets never cost N maintenances.
import { VERSION } from '../core/version.js';

/** Stamped on every generated file so a later run can tell its own output from a hand-written one. */
export const MARK = `vibeward v${VERSION}`;

/** Merged files only ever own what sits between these two lines. */
export const MARKER_START = '<!-- vibeward:start -->';
export const MARKER_END = '<!-- vibeward:end -->';

/**
 * Everything a template needs to know about the machine it is being written on and what the
 * user asked for. The guard command is resolved once per run (see `binary.ts`) instead of
 * hardcoded: it is normally a pinned `npx`, and the version in it changes with every release.
 * The hook manifests themselves live in `hooks.ts` — seven native formats do not belong in the
 * file that holds the prose.
 */
export interface RenderContext {
  guardCommand: string;
  guardTimeout: number;
  /** Which moments the user chose to guard. Empty means skill and rules only. */
  moments: import('../guard/verdict.js').Moment[];
}

const TITLE = '# vibeward — audit a deployed site and report what it finds';

/**
 * Frontmatter `description` for every target that has one. No `: ` anywhere: a colon
 * followed by a space would end the plain YAML scalar and break the frontmatter.
 *
 * Written to match how a user phrases the ask, not to summarise the tool. A host picks a
 * skill by matching this text against the request, so the words that have to appear are the
 * ones a person actually types — "leaked key", "RLS", "before I deploy" — and they have to
 * appear early. The previous version opened by naming the scanner, which is the one thing
 * the user has no reason to say.
 */
const DESCRIPTION =
  'Scan a deployed URL or a code folder for exposed secrets, open Supabase Row-Level Security, Firebase exposure and insecure backends — plus SEO, metadata and AI visibility on a live site. Deterministic, with no LLM call anywhere. Use when the user asks to audit, scan, check or review an app, a website or a repo for security problems, when they mention a leaked key, service_role or RLS, or right after a deploy. Detects and reports only; it never fixes what it finds.';

/**
 * The canonical text. Written as lines instead of a template literal so the markdown can
 * use backticks freely, which a skill body is made of.
 */
export const INSTRUCTION = [
  'vibeward is a deterministic scanner: it detects, you report. Never the other way round.',
  'You do not decide whether a tag, a file or a header is missing — vibeward does, and it is',
  'the only thing allowed to say so. If it is not in the report, it is not a finding.',
  '',
  '**Your job is to tell the user what is wrong. It is not to make it go away.** vibeward is a',
  'detector, not a repair tool, and so are you while you are using it. A scan that ends in a',
  'report the user understands is a complete success — not a step on the way to one.',
  '',
  '**You do not fix anything you find here.** Not the security findings, not the website ones,',
  'not the one-line mechanical ones, and not when the user asks you to as a follow-up. If they',
  'want changes made, that is a new task they start deliberately, with the report in hand — not',
  'something that happens automatically because a scan produced a list. Findings ship without a',
  '`fix` field and without an `autofix` field on purpose: there is no work order here to carry',
  'out, only a `why` written for a person to read.',
  '',
  '## 1. Scan',
  '',
  'A deployed site, from the outside:',
  '',
  '```bash',
  'npx vibeward@latest <url> --passive --json --stdout --out vibeward-report.md --yes',
  '```',
  '',
  'The code, from the inside — run this **before** a deploy, because it sees what a URL scan',
  'cannot: secrets committed to the repo, a checked-in `.env`, migrations that create tables',
  'without RLS, `USING (true)` policies and `SECURITY DEFINER` functions:',
  '',
  '```bash',
  'npx vibeward@latest scan <folder> --json --stdout --out vibeward-code-report.md',
  '```',
  '',
  'Use both when you have both. A leaked `service_role` key is usually visible in the repo long',
  'before it is visible in a bundle.',
  '',
  '`--stdout` puts the JSON payload on stdout and every human-facing line on stderr, so',
  'stdout parses cleanly. `--out` writes the full formatted report as markdown — that file is',
  'the deliverable for the human, and without the flag it is built and thrown away.',
  '',
  'Most of a scan is a browser: the page, its bundles, the crawl, the headers, the',
  'plain-HTTP address. None of that asks anything. vibeward stops and asks exactly once, and',
  'only if it finds a Supabase or Firebase backend in the bundles, because reading rows out',
  'of a data API is the part a visitor never does. `--yes` answers that question in advance,',
  'and `--passive` skips those probes altogether — which is why `--passive` is the default here.',
  '',
  '**Do not pass `--yes` on your own.** It pre-authorizes reading live data out of somebody',
  "else's database. It needs the user to say, in this conversation, that they own the target",
  'or were hired to audit it. A URL merely appearing in the conversation is not authorization:',
  'if the user says "check out competitor.com", scan it passively or ask. Re-run with `--yes`',
  'only after they confirm.',
  '',
  '`vibeward-report.md` is a generated artifact. Mention where it is, and do not commit it',
  'unless the user asks.',
  '',
  '### Exit codes',
  '',
  '- **`0`** — the scan ran. There may still be findings, and usually there are.',
  '- **`2`** — the scan ran and found critical **security** findings. Not a broken run: the',
  '  payload is on stdout exactly as with `0`. Read it, do not retry the command.',
  '- **`1`** — the scan itself failed. There is no payload. See section 2.',
  '',
  '## 2. When the scan does not come back',
  '',
  'A scanner that could not reach the site has found nothing — it has not found *nothing*.',
  'Those are different results and only one of them is reportable. Say which one happened,',
  'in plain words, and stop:',
  '',
  '- **DNS failure, connection refused, timeout** — the URL may be wrong, private, not',
  '  deployed yet, or behind a VPN. Ask the user which. Do not try variations of the domain',
  '  on your own; guessing hostnames is scanning machines nobody authorized.',
  '- **`401` / `403` on everything** — the site is behind auth or a WAF. A passive scan of a',
  '  login wall legitimately reports almost nothing. Say so explicitly, or the empty report',
  '  reads as a clean bill of health.',
  '- **Heavy client-side rendering** — the scan reads what the server sends. If the HTML is',
  '  an empty `<div id="root">`, that is itself a finding vibeward reports, not a scan error.',
  '- **The command is missing or the network is down** — report the failure. Do not fall back',
  '  to `curl`, `WebFetch` or reading the repo and calling the result an audit.',
  '',
  'Retry once if it looks transient. After that, report the failure and let the user decide.',
  'Never substitute your own reading of a page for a scan that did not run.',
  '',
  '## 3. Report — this is the deliverable',
  '',
  'Write the summary in chat and point at `vibeward-report.md` for the detail. The whole',
  'value of a deterministic scanner is that the numbers are not yours, so do not launder',
  'them through your own judgement:',
  '',
  '- **Lead with `impact`, not with the count.** "Anyone can read every row of `profiles`"',
  '  lands; "3 high, 6 medium" does not.',
  '- **Quote `evidence` verbatim.** It holds the real numbers, the real URLs, the real key',
  '  prefix. Paraphrasing it is how a finding quietly loses its proof.',
  '- **Never restate a severity in your own words.** If vibeward says critical, it is',
  '  critical — you do not get to call it "worth looking at eventually".',
  '- **List the affected pages** from `meta.pages` instead of saying "several pages".',
  '- **Report what was silenced.** Anything in `suppressed` was hidden by a config file, with',
  '  a `reason`. A user reading a clean report deserves to know what is not in it.',
  '- **Report what was never checked.** `coverage.notEvaluated` is the list of things this run',
  '  did not look at, each with the reason. Say it in the same breath as the result, not as a',
  '  footnote — see section 4.',
  '- **Do not pad.** If there are no findings, that is one sentence, not a page of reassurance.',
  '',
  'The payload:',
  '',
  '```json',
  '{',
  '  "schemaVersion": 4,',
  '  "verdict": "...",',
  '  "counts":    { "critical": 0, "high": 1, "medium": 2, "low": 3 },',
  '  "webCounts": { "critical": 0, "high": 2, "medium": 6, "low": 2 },',
  '  "fingerprint": { "score": 9, "total": 12, "signals": ["..."] },',
  '  "findings": [{ "id": "...", "kind": "web", "severity": "high", "evidence": "..." }],',
  '  "coverage": {',
  '    "complete": false,',
  '    "checked":       [{ "id": "http_headers",  "detail": "..." }],',
  '    "notEvaluated":  [{ "id": "supabase_rls",  "detail": "--passive: ... never read" }],',
  '    "notApplicable": [{ "id": "firebase_rules", "detail": "no Firebase config found" }],',
  '    "webChecks": { "checked": [], "notEvaluated": [], "notApplicable": [] }',
  '  }',
  '}',
  '```',
  '',
  'Every finding carries `id`, `label`, `severity`, `evidence` (the real numbers), `impact`',
  '(what it costs the business) and `why` (what it is and what a correct one looks like).',
  '`meta.pages` lists the URLs affected. There is no `fix` and no `autofix` — see the top of',
  'this file.',
  '',
  '## 4. An empty findings list is not a clean bill of health',
  '',
  '`findings: []` has two meanings and the payload tells you which one you are holding.',
  'Check `coverage` **before** you write the word "clean", "secure" or "no issues":',
  '',
  '- **`coverage.complete: true`** — every security check this run could make, it made. An',
  '  empty list means those checks passed. Say so plainly.',
  '- **`coverage.complete: false`** — something was skipped. Everything in',
  '  `coverage.notEvaluated` was **not looked at**, and you may not draw any conclusion about',
  '  it, in either direction. Name what was skipped and why, in the summary itself.',
  '',
  'The common case is the one that matters most: a `--passive` scan detects a Supabase backend',
  'and never reads it, so `supabase_rls` lands in `notEvaluated`. The findings list can be',
  'empty and the database still wide open. "No security findings — but the Supabase backend was',
  'detected and never tested, because the scan ran in passive mode" is the honest sentence.',
  '"Your app is secure" is not, and the payload told you so.',
  '',
  '`coverage.notApplicable` is different: those areas cannot exist on this target (no Firebase',
  'config in the assets, no SQL files in the tree). They are not gaps and do not need reporting',
  'unless the user asks what was covered.',
  '',
  '`coverage.webChecks` is the same three lists for the website pass, on its own scale. It never',
  'moves `complete` — a missing alt-text check says nothing about whether the app is safe.',
  '',
  'Never fill a gap yourself. If RLS was not evaluated, the answer is to re-run the scan with',
  'authorization, not to go and read the database, guess from the code, or reassure the user.',
  '',
  '## 5. Split by kind',
  '',
  '**`kind: "security"`** (or no `kind` at all) — **do not fix these, ever, even if asked.**',
  'Report them and stop there. A security finding usually means something is already exposed,',
  'such as a service key sitting in a bundle or a table readable without authentication.',
  'Deleting the line does not un-leak the key — it has to be rotated, and only the owner',
  'decides when, how, and whether the incident has to be disclosed. Quietly patching it hides',
  'an incident. Tell the user what to rotate and in what order, and let them do it.',
  '',
  '**`kind: "web"`** — quality and visibility. Report these the same way. They are not a',
  'lesser category you are allowed to go and fix; they are the category that is not urgent.',
  '',
  '## 6. When the user says they do not care about a finding',
  '',
  'That is a reporting decision, not a fix, and it is the one thing you may write to disk here.',
  'Record it in `vibeward.json` so the next run does not ask again. A `reason` is required, and',
  'it is printed in the report — so write the real one, not "not needed":',
  '',
  '```json',
  '{',
  '  "schemaVersion": 1,',
  '  "intent": { "aiCrawlers": "blocked", "siteType": "website" },',
  '  "suppress": [{ "id": "web_missing_og", "reason": "private landing, never shared" }]',
  '}',
  '```',
  '',
  '`intent` is not a mute button: declaring `aiCrawlers: "blocked"` makes vibeward check the',
  'opposite — that the block is actually complete. And only `kind: "web"` ids can be',
  'suppressed; a security finding cannot be silenced by a file, by design.',
  '',
  '## 7. Re-scanning',
  '',
  'You are done at section 3. Do not re-run the scan to produce a second identical report.',
  '',
  'The one time to re-scan is when the **user** tells you they have changed and deployed',
  'something and asks whether it worked. Then run the exact same command and compare',
  '`findings`: an id that disappeared is closed, an id still there means the change did not',
  'reach the live site — often because it was never deployed, since a local edit is invisible',
  'to a scanner reading a URL.',
  '',
  '## Never',
  '',
  '- Never say something is missing, or fixed, because you read the HTML yourself. Run the',
  '  scan and quote its `evidence`.',
  '- Never report a scan that failed as a scan that found nothing.',
  '- **Never fix a finding.** Not security, not web, not the one-line ones, not on request.',
  '  Report it and let the user decide what to do with their own site.',
  '- Never edit a file, open a PR or deploy as part of an audit. The only file you may write',
  '  is `vibeward.json`, and only to record a suppression the user asked for.',
  '- Never invent a claim about the business to fill a gap the report describes.',
].join('\n');

/** Title + body, the shape every markdown-ish target shares. */
function body(): string {
  return `${TITLE}\n\n${INSTRUCTION}\n`;
}

/**
 * `install-vibeward-guardrails` — the body for the setup ask.
 *
 * Its own failure mode, and the reason half of it is about restraint: `init` writes files into
 * somebody's repository. An agent that runs it unprompted, or picks the targets itself, has
 * edited a project nobody asked it to edit — which is the behaviour vibeward exists to catch.
 */
function installBody(): string {
  return [
    "# vibeward — install the guardrail into the user's editor",
    '',
    'Most vibe-coded holes do not start as bad code. They start as a reasonable-sounding',
    'request — _"disable RLS so it works"_, _"use the service_role key in the frontend"_,',
    '_"remove the login for now"_ — and the agent complies, because complying is the job.',
    '`vibeward guard` runs as an editor hook and catches that the moment it is typed, in',
    'English, Spanish or Portuguese, with why it is dangerous and what to do instead, **before**',
    'the agent acts. The rules are deterministic with no LLM call anywhere, so they cannot be',
    'prompt-injected away.',
    '',
    NEVER_FIXES,
    '',
    '## 1. The installer asks questions, and you are not the one to answer them',
    '',
    '`init` is interactive. Run bare, it opens a picker — where to install, which editors, which',
    'moments — and **it refuses to run without a terminal**, which is what you are calling it',
    'from. So there are two correct routes and one wrong one.',
    '',
    '**Preferred — hand it to the user.** It writes into their repository and their editor',
    'configuration, and which editors they use is not something inferable from a file tree:',
    '',
    '> Run this in your terminal and answer the picker:',
    '> ```',
    '> npx vibeward@latest init',
    '> ```',
    '',
    '**Or ask the questions here, then carry out the answer.** If the user would rather you did',
    'it, ask which editors and which moments, in chat, and pass what they said:',
    '',
    '```bash',
    '# only after the user has said "Claude Code and AGENTS.md, prompts and actions"',
    'npx vibeward@latest init --scope project \\',
    '  --targets claude-code,agents-md --moments prompt,action --yes',
    '```',
    '',
    '`--scope` is required in this non-interactive form: `project` installs into the repo, `user`',
    'into the machine-wide config so it covers every project. `--all` selects every target',
    'available for the scope.',
    '',
    '**What is wrong is choosing for them.** Do not pick targets from what you find in the tree,',
    'and do not pass `--all --yes` to get past the prompt. The picker is the consent step for a',
    "command that writes files, and answering it on the user's behalf is the behaviour this",
    'tool exists to catch, committed by its own installer.',
    '',
    '## 2. What to install where',
    '',
    '**Editors** — `claude-code`, `codex`, `cursor`, `copilot`, `gemini`, `windsurf`,',
    "`opencode`. Each gets a skill plus the hook manifest in that editor's native format.",
    '',
    '**Shared instruction files** — `claude-md` and `agents-md`. These are not hooks and enforce',
    'nothing; they are the always-on prohibitions, loaded into every conversation in the repo,',
    'for the case where nobody invoked anything and the fastest way past a failing query is to',
    'turn RLS off. Worth having alongside a hook, not instead of one.',
    '',
    '**CI** — `gh-action`. See the `ci-security-scanning-with-vibeward` skill.',
    '',
    '## 3. The moments',
    '',
    'The guard can fire at three points. More is not automatically better — each one costs a',
    'hook invocation on every matching event.',
    '',
    "- **`prompt`** — the user's message, before the agent reads it. This is the one that",
    '  catches _"disable RLS so the query works"_, and the one to install if only one is wanted.',
    '- **`action`** — before a Bash, Write or Edit call. Catches what the agent improvised on',
    '  its own, including the request the prompt gate never saw.',
    '- **`content`** — after a Read, WebFetch, WebSearch or Grep. Catches instructions hidden in',
    '  fetched content trying to steer the agent — the injection case.',
    '',
    'By default a match **warns the agent in context and lets the turn continue** (exit 0).',
    'Blocking is opt-in per install, because a blocked prompt is a lost paragraph and a',
    'guardrail people turn off protects nothing.',
    '',
    '## 4. Report honestly what was installed',
    '',
    '`init` prints a summary of what each target can and cannot enforce, given the moments that',
    'were actually chosen. **Relay it as printed.** The guarantees are genuinely not the same',
    'everywhere — some editors have no prompt hook at all, and in some the skill loads but the',
    'guard does not — and a summary that rounds "the skill loads here" up to "you are covered',
    'here" leaves someone believing in protection they do not have.',
    '',
    'Do not claim a moment was installed that the user declined, and do not describe the guard',
    'as blocking when it is set to warn.',
    '',
    '## 5. Claude Code — the plugin instead',
    '',
    'In Claude Code the plugin is the better route when the user has not already run `init`. It',
    'ships a pinned, offline copy of the CLI with the hooks already wired, so there is no',
    '`npx` resolution at the moment a prompt is typed and nothing to install at first use. It',
    'also brings the other skills, including this one.',
    '',
    '## 6. Verify, then stop',
    '',
    '```bash',
    'npx vibeward@latest --version',
    '```',
    '',
    'A hook that is installed and does not run is the one failure this project refuses to ship,',
    'so confirming the binary resolves is worth the one command. Beyond that, do not test the',
    'guard by writing a risky prompt into a file, and do not hand-edit the generated hook',
    'manifests to "improve" them — a later `init` overwrites them, and the version that was',
    'tested is the generated one.',
  ].join('\n');
}

/**
 * The prohibition, in one line, for the skills whose body is not the audit procedure.
 *
 * `INSTRUCTION` argues this at length because an agent holding a findings list is standing
 * right next to the temptation. The setup skills are not, so they get the rule and not the
 * argument — restating the full case in each would be the duplication this file exists to
 * avoid, and the version that drifts is always the copy.
 */
const NEVER_FIXES =
  'vibeward detects and reports. It does not fix anything it finds, and neither do you while ' +
  'you are using it — see the `vibeward` skill before acting on a report.';

/**
 * `ci-security-scanning-with-vibeward` — the body for the pipeline ask.
 *
 * The pinning argument is repeated here rather than linked because it is the part a
 * well-meaning agent silently undoes: `@latest` and a floating tag both look tidier in a
 * workflow file, and both hand a third party the ability to change what runs on every push.
 */
function ciBody(): string {
  return [
    '# vibeward — scan every pull request',
    '',
    'One npx command, no API key, no Docker, no LLM call and no runtime dependencies, so it',
    'runs on a bare runner in seconds. Findings fail the build on critical severity and land in',
    'the GitHub Security tab as SARIF.',
    '',
    NEVER_FIXES,
    '',
    '## 1. GitHub Actions',
    '',
    'The generated workflow is the shortest route, and `init` writes it for you:',
    '',
    '```bash',
    'npx vibeward@latest init --targets gh-action',
    '```',
    '',
    'To wire it by hand instead, use the published action:',
    '',
    '```yaml',
    'name: vibeward',
    'on: [push, pull_request]',
    '',
    'permissions:',
    '  security-events: write   # required to upload SARIF',
    '  contents: read',
    '',
    'jobs:',
    '  scan:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: JSiapoDEV/vibeward@<commit-sha>   # pin by SHA, see below',
    '        with:',
    '          path: .',
    '          fail-on-critical: true',
    '```',
    '',
    '**Pin the action by commit SHA, not by tag.** A tag is mutable: whoever controls the',
    "action's repository can move it, and every workflow trusting that tag then runs new code",
    'on the next push. This is the same argument vibeward makes against `npx @latest` inside a',
    'guard hook, and it would not be worth much if the CI advice ignored it. If the user prefers',
    'a tag for readability, say plainly what they are trading.',
    '',
    'Inputs: `path` (folder to scan, default `.`), `url` (scan a deployed URL instead — this',
    'adds the website quality and AI-visibility checks), `supabase` (a `vibeward supabase-sql`',
    'export), `fail-on-critical` (default `true`).',
    '',
    '## 2. Any other pipeline',
    '',
    'There is no plugin to install. GitLab CI, CircleCI, Jenkins, a git hook — all the same',
    'command:',
    '',
    '```bash',
    'npx vibeward@latest scan . --sarif vibeward.sarif --stdout > findings.json',
    '```',
    '',
    'Exit codes are the gate:',
    '',
    '- **`0`** — the scan ran. There may still be findings, and usually there are.',
    '- **`2`** — the scan ran and found **critical security** findings. The payload is on stdout',
    '  exactly as with `0`. This is the code that should fail a merge.',
    '- **`1`** — the scan itself failed and there is no payload. Do not treat this as a pass.',
    '',
    'Distinguish `1` from `2` explicitly in whatever wraps it. A pipeline that fails the build on',
    '"non-zero" reports a broken scanner as a security finding, and one that passes on "not 2"',
    'reports a crashed scanner as a clean repo.',
    '',
    '## 3. Scan the code, the deployment, or both',
    '',
    '**Code** (`scan <folder>`) is the one to gate merges on. It sees what a URL scan cannot —',
    'secrets committed to the repo, a checked-in `.env`, migrations creating tables without RLS,',
    '`USING (true)` policies, `SECURITY DEFINER` functions — and it needs no deployment to exist.',
    '',
    '**URL** is worth adding on a deploy or preview-environment workflow, against the preview',
    'URL. Use `--passive` there: it reads only public assets, so it needs no authorization',
    'decision inside a pipeline where nobody is present to make one. Never put `--yes` in a',
    'workflow file — it pre-authorizes reading live rows out of a database, and CI is exactly',
    'where nobody will see the prompt it is answering.',
    '',
    '## 4. Do not let a green build overstate itself',
    '',
    'The JSON payload carries a `coverage` block. `coverage.complete: false` means something was',
    'skipped, and everything in `coverage.notEvaluated` was **not looked at** — a passive scan of',
    'a Supabase app can exit `0` with an untested database. If the pipeline posts a summary,',
    'post that too, or the green check reads as more than it is.',
    '',
    'A folder scan never contacts the live backend at all, and says so in its own coverage. Pair',
    'it with a URL scan, or with a `vibeward supabase-sql` export, before calling the database',
    'covered.',
    '',
    '## 5. Secrets and permissions',
    '',
    'vibeward needs **no API key and no token of its own**. The only permission the workflow',
    'needs is `security-events: write`, and only to upload SARIF. If a setup seems to require a',
    'secret, something else is being configured — stop and ask. Never create, name or commit a',
    "repository secret on the user's behalf.",
  ].join('\n');
}

/**
 * One skill per thing a user asks for.
 *
 * Split by the request, not by the feature: "audit my site", "stop Claude disabling RLS" and
 * "gate my pull requests" are three different jobs with three different commands, and a single
 * skill covering all of them needs a `description` that is a list, which is the shape a host
 * matches worst. They share no body — the two setup skills genuinely do not need the audit
 * procedure — so this costs no duplicated prose.
 *
 * Deliberately NOT split further into a URL skill and a folder skill. Those two share the
 * whole contract (authorization, coverage, how to report, what never to fix), so separating
 * them would either duplicate ~150 lines or leave one of them pointing at the other and
 * hoping. The distinction is one section inside the body, where it costs nothing.
 */
export interface SkillSpec {
  /** Directory name under `skills/`, and the frontmatter `name`. They must match. */
  name: string;
  description: string;
  body: () => string;
}

export const SKILLS: SkillSpec[] = [
  {
    name: 'vibeward',
    description: DESCRIPTION,
    body,
  },
  {
    name: 'install-vibeward-guardrails',
    description:
      'Install vibeward as a hook in Claude Code, Cursor, Codex, Copilot, Gemini, Windsurf or opencode, so risky requests are caught before the agent acts on them — "disable RLS", "use the service_role key in the frontend", "remove the login for now" — in English, Spanish and Portuguese. Deterministic rules with no LLM call, so they cannot be prompt-injected away. Use when the user asks to install vibeward, set up a guardrail, protect a repo from unsafe AI edits, or stop their agent weakening security.',
    body: installBody,
  },
  {
    name: 'ci-security-scanning-with-vibeward',
    description:
      'Add vibeward to CI so every pull request is scanned for exposed secrets, open Supabase RLS and Firebase exposure, failing the build on critical findings and publishing SARIF to the GitHub Security tab. Works as a GitHub Action or as one npx command in any pipeline, with no API key, no Docker and no LLM call. Use when the user asks to add security scanning, a secret check, a pre-merge gate or SARIF upload to their CI, pipeline or pull requests.',
    body: ciBody,
  },
];

/**
 * A SKILL.md for one spec.
 *
 * Only `name` and `description` are emitted. Those are the two fields the open Agent Skills
 * standard defines, every host here reads both, and the upload paths (claude.ai, the Skills
 * API) reject anything outside the standard set. `name` must equal the parent directory name,
 * and on most hosts the invocation comes from that directory rather than from this field.
 *
 * `init` writes only the first spec. The other two are setup skills, and a project that has
 * just been set up has no use for the instructions for setting it up — they belong in the
 * discovery channels (`npx skills add`, the plugin), where somebody who has not installed
 * anything yet can find them.
 */
export function skillFile(spec: SkillSpec = SKILLS[0]!): string {
  return [
    '---',
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    '---',
    '',
    `<!-- ${MARK} — regenerate with \`npx vibeward@latest init\` -->`,
    '',
    spec.body(),
  ].join('\n');
}

/**
 * The always-on half, and the reason it is not just `INSTRUCTION` again.
 *
 * CLAUDE.md is loaded into every conversation in the repo, so what goes in it is paid for
 * on every turn — which makes a hundred-line audit procedure the wrong tenant. The split is
 * by PERMANENCE, not by tool: the procedure (scan, read, report) is needed only when someone
 * is auditing, and belongs in a skill that loads on demand. The prohibitions are needed
 * exactly when nobody invoked anything — when a query fails and the fastest way out is to
 * turn RLS off. A rule that only loads once the agent has decided to audit is not a
 * guardrail; it is a footnote.
 *
 * These are the risks the `guard` hook matches on a user's prompt, restated for the agent's
 * own decisions. The hook catches the request; this catches the improvisation.
 */
const ALWAYS_ON = [
  '## Security rules',
  '',
  'These hold in every conversation in this repo, with or without a scan.',
  '',
  '- **Never disable, weaken or work around a security control to make something pass** —',
  '  Row-Level Security, an auth check, CSRF, a rate limit, signature or certificate',
  '  verification. A control that rejects your request is usually catching a real bug. Fix',
  '  the policy, not the guard.',
  '- **Never put a `service_role` / `sb_secret` / admin key where a browser can reach it.**',
  '  Client code gets the anon (publishable) key plus RLS; privileged work goes server-side,',
  '  in an Edge Function or a backend route.',
  '- **Never make a table or a storage bucket public to debug.** Use an authenticated test',
  '  user and a real policy. "Temporarily" is how it ships.',
  '- **Never commit `.env`, and never log the value of a secret.** The name is fine, the',
  '  value is not, and git history keeps it after you delete the line.',
  '- **Never widen CORS to `*` on an authenticated API.** Whitelist the exact domains.',
  '- **Validate an uploaded file by its content, on the server.** Read its first bytes (magic',
  '  bytes) and match them against an allowlist. The extension, the `accept` attribute and the',
  '  declared MIME type are chosen by the sender — a hint for the UI, never the check.',
  '',
  'If a leak has already happened, **say so and stop.** Deleting the line does not un-leak the',
  'key — it has to be rotated, and only the owner decides when, how, and whether the incident',
  'has to be disclosed. Report it; quietly patching it hides an incident from the person who',
  'is accountable for it.',
  '',
  'To audit a deployed URL, use the vibeward skill, or run',
  '`npx vibeward@latest <url> --passive --json --stdout --out vibeward-report.md --yes`.',
].join('\n');

/**
 * The block merged into `CLAUDE.md`. Deliberately the short always-on rules and not the
 * audit procedure: see the note on ALWAYS_ON.
 */
export function claudeMdBlock(): string {
  return [
    MARKER_START,
    `<!-- ${MARK} — regenerate with \`npx vibeward@latest init\` -->`,
    '',
    ALWAYS_ON,
    MARKER_END,
  ].join('\n');
}

/**
 * The block merged into `AGENTS.md`. Only what sits between the markers belongs to
 * vibeward, so a re-run replaces this and leaves the rest of the file untouched.
 */
export function agentsBlock(): string {
  return [
    MARKER_START,
    `<!-- ${MARK} — regenerate with \`npx vibeward@latest init\` -->`,
    '',
    body(),
    MARKER_END,
  ].join('\n');
}

// No `.claude/commands/vibeward.md` template on purpose: custom commands have been merged
// into skills, both forms produce the same `/vibeward`, and the skill wins on a name clash.
// Shipping the second form would only create a file that can never take effect.

/** `.github/workflows/vibeward.yml` — findings land in the repo Security tab as SARIF. */
export const GH_WORKFLOW = `# ${MARK} — regenerate with \`npx vibeward@latest init\`
name: vibeward

on: [push, pull_request]

permissions:
  security-events: write
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: JSiapoDEV/vibeward@v${VERSION}
        with:
          path: '.'
          # url: https://your-site.com   # also scan the deployed site (SEO / AI visibility)
          # supabase: audit.json         # a committed export from \`vibeward supabase-sql\`
          # fail-on-critical: 'false'    # report without failing the job
`;
