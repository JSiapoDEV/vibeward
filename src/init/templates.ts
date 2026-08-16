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
 * hardcoded, because what the hook should run depends on whether there is an installed
 * `vibeward` to run. The hook manifests themselves live in `hooks.ts` — seven native formats
 * do not belong in the file that holds the prose.
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
 */
const DESCRIPTION =
  'Audit a deployed website or web app, or a code folder, with the vibeward scanner and report what it finds — exposed secrets, open database rules, SEO, metadata, AI visibility and broken assets. Use when the user asks to check, audit or review a live URL or a repo, or right after a deploy. Detects and reports only; it never fixes what it finds.';

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
  'the deliverable for the human, and without the flag it is built and thrown away. `--yes`',
  'skips the interactive authorization prompt — which is why `--passive` is the default',
  'here: it reads only assets the site already serves to any visitor (bundles, headers,',
  'public metadata) and probes no data.',
  '',
  '**Do not drop `--passive` on your own.** The full scan sends requests a site owner has',
  'not agreed to receive, so it needs the user to say, in this conversation, that they own',
  'the target or were hired to audit it. A URL merely appearing in the conversation is not',
  'authorization: if the user says "check out competitor.com", scan it passively or ask.',
  'Re-run without `--passive` only after they confirm.',
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
  '- **Do not pad.** If there are no findings, that is one sentence, not a page of reassurance.',
  '',
  'The payload:',
  '',
  '```json',
  '{',
  '  "schemaVersion": 2,',
  '  "verdict": "...",',
  '  "counts":    { "critical": 0, "high": 1, "medium": 2, "low": 3 },',
  '  "webCounts": { "critical": 0, "high": 2, "medium": 6, "low": 2 },',
  '  "fingerprint": { "score": 9, "total": 12, "signals": ["..."] },',
  '  "findings": [{ "id": "...", "kind": "web", "severity": "high", "evidence": "..." }]',
  '}',
  '```',
  '',
  'Every finding carries `id`, `label`, `severity`, `evidence` (the real numbers), `impact`',
  '(what it costs the business) and `why` (what it is and what a correct one looks like).',
  '`meta.pages` lists the URLs affected. There is no `fix` and no `autofix` — see the top of',
  'this file.',
  '',
  '## 4. Split by kind',
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
  '## 5. When the user says they do not care about a finding',
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
  '## 6. Re-scanning',
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
 * `<host>/skills/vibeward/SKILL.md` — the same file for every host.
 *
 * Only `name` and `description` are emitted. Those are the two fields the open Agent Skills
 * standard defines, every host here reads both, and the upload paths (claude.ai, the Skills
 * API) reject anything outside the standard set. `name` must equal the parent directory name,
 * and on most hosts the invocation comes from that directory rather than from this field — so
 * the folder has to stay called `vibeward`.
 *
 * One body, seven destinations. The per-host rule files this used to generate (`.cursor/rules`,
 * `.devin/rules`) are gone: SKILL.md replaced them at every host that had one, and three
 * formats carrying identical prose was three chances to let them drift.
 */
export function skillFile(): string {
  return [
    '---',
    'name: vibeward',
    `description: ${DESCRIPTION}`,
    '---',
    '',
    `<!-- ${MARK} — regenerate with \`npx vibeward@latest init\` -->`,
    '',
    body(),
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
 * These are the same eight risks the `guard` hook matches on a user's prompt, restated for
 * the agent's own decisions. The hook catches the request; this catches the improvisation.
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
