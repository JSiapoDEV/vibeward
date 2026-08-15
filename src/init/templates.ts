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

/** The hook event that gates a prompt before the agent acts on it. */
export const HOOK_EVENT = 'UserPromptSubmit';

export interface HookHandler {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookGroup {
  /** Omitted on purpose for UserPromptSubmit, which supports no matcher. */
  matcher?: string;
  hooks: HookHandler[];
}

/**
 * Everything a template needs to know about the machine it is being written on. The guard
 * command is resolved once per run (see `binary.ts`) instead of hardcoded, because what the
 * hook should run depends on whether there is an installed `vibeward` to run.
 */
export interface RenderContext {
  guardCommand: string;
  guardTimeout: number;
}

/**
 * One matcher group for the guard. UserPromptSubmit takes no `matcher`, but the group
 * object is still required — flattening this into a bare list of handlers silently stops
 * the hook from loading. No `args`, so the command runs through a shell.
 * `timeout` is explicit because UserPromptSubmit caps hooks at 30 s and a cold `npx`
 * download can need longer; a timeout cancels the hook and discards its output.
 */
export function guardHook(ctx: RenderContext): HookGroup {
  return {
    hooks: [{ type: 'command', command: ctx.guardCommand, timeout: ctx.guardTimeout }],
  };
}

/** What the merge into an existing settings.json will add, for the preview. */
export function guardHookJson(ctx: RenderContext): string {
  return JSON.stringify({ hooks: { [HOOK_EVENT]: [guardHook(ctx)] } }, null, 2);
}

const TITLE = '# vibeward — audit the deployed site, then fix what is safe to fix';

/**
 * Frontmatter `description` for every target that has one. No `: ` anywhere: a colon
 * followed by a space would end the plain YAML scalar and break the frontmatter.
 */
const DESCRIPTION =
  'Audit a deployed website or web app with the vibeward scanner and fix what it reports — SEO, metadata, AI visibility, broken assets and security. Use when the user asks to check, audit or improve a live URL, or right after a deploy.';

/**
 * The canonical text. Written as lines instead of a template literal so the markdown can
 * use backticks freely, which a skill body is made of.
 */
export const INSTRUCTION = [
  'vibeward is a deterministic scanner: it detects, you fix. Never the other way round.',
  'You do not decide whether a tag, a file or a header is missing — vibeward does, and it is',
  'the only thing allowed to say so. If it is not in the report, it is not a finding.',
  '',
  '## 1. Scan',
  '',
  '```bash',
  'npx vibeward@latest <url> --passive --json --stdout --yes',
  '```',
  '',
  '`--stdout` puts the JSON payload on stdout and every human-facing line on stderr, so',
  'stdout parses cleanly. `--yes` skips the interactive authorization prompt — which is why',
  '`--passive` is the default here: it reads only assets the site already serves to any',
  'visitor (bundles, headers, public metadata) and probes no data.',
  '',
  '**Do not drop `--passive` on your own.** The full scan sends requests a site owner has',
  'not agreed to receive, so it needs the user to say, in this conversation, that they own',
  'the target or were hired to audit it. A URL merely appearing in the conversation is not',
  'authorization: if the user says "check out competitor.com", scan it passively or ask.',
  'Re-run without `--passive` only after they confirm.',
  '',
  'Exit code `2` means critical **security** findings are present — not a broken run. The',
  'payload is on stdout either way. Read it, do not retry the command.',
  '',
  'The payload:',
  '',
  '```json',
  '{',
  '  "schemaVersion": 1,',
  '  "verdict": "...",',
  '  "counts":    { "critical": 0, "high": 1, "medium": 2, "low": 3 },',
  '  "webCounts": { "critical": 0, "high": 2, "medium": 6, "low": 2 },',
  '  "fingerprint": { "score": 9, "total": 12, "signals": ["..."] },',
  '  "findings": [{ "id": "...", "kind": "web", "autofix": "auto", "fix": "..." }]',
  '}',
  '```',
  '',
  'Every finding carries `id`, `label`, `severity`, `evidence` (the real numbers), `impact`',
  '(what it costs the business), `why`, and usually `fix` (the concrete snippet) and',
  '`autofix` (how far you may go alone). `meta.pages` lists the URLs affected.',
  '',
  '## 2. Split by kind',
  '',
  '**`kind: "security"`** (or no `kind` at all) — **do not fix these.** Report them to the',
  'human and stop there. A security finding usually means something is already exposed, such',
  'as a service key sitting in a bundle or a table readable without authentication. Deleting',
  'the line does not un-leak the key — it has to be rotated, and only the owner decides when,',
  'how, and whether the incident has to be disclosed. Quietly patching it hides an incident.',
  '',
  '**`kind: "web"`** — quality and visibility. These you can work on, following `autofix`.',
  '',
  '## 3. Fix by autofix',
  '',
  '- **`auto`** — apply `fix` as written. It is mechanical: a canonical tag, a sitemap, a',
  '  `lang` attribute, a robots.txt line. No judgement, no business knowledge involved.',
  '- **`needs-input`** — the fix needs real facts about this business: what it actually',
  '  sells, to whom, where, what the photo actually shows. Take them from the copy already',
  '  on the site, from the README, or ask the user. `fix` ships placeholders (Acme,',
  '  "bookkeeping for freelancers") — never leave one in, and never invent a claim the',
  '  business has not made. A generic meta description is worse than none, because it looks',
  '  written and so nobody ever writes the real one.',
  '- **`manual`** — report it, do not touch it. Empty client-rendered HTML, console errors',
  '  and heavy bundles are architecture decisions, not text edits.',
  '',
  'Edit the source, not the build output: `index.html`, the page components, `public/`.',
  'Anything written into `dist/` is erased by the next build.',
  '',
  '## 3b. When the user does not want a fix',
  '',
  'Record the decision in `vibeward.json` instead of asking again on the next run. A `reason`',
  'is required, and it ends up printed in the report — so write the real one:',
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
  '## 4. Verify',
  '',
  'Re-run the exact same command and compare `findings`. Detect, fix, re-detect: the scanner',
  'is the test suite and you are the code under test.',
  '',
  '- Deploy first when the site is built and served from a host. A local edit is invisible',
  '  to a scanner reading the live URL.',
  '- A finding that disappeared is fixed. A finding still there means the edit did not land.',
  '- **Three rounds maximum.** If something survives three, stop and tell the user what is',
  '  left and what you tried. Repeating a failing edit burns their tokens and their patience.',
  '',
  '## Never',
  '',
  '- Never say something is missing, or fixed, because you read the HTML yourself. Run the',
  '  scan and quote its `evidence`.',
  '- Never fix a `kind: "security"` finding on your own.',
  '- Never fill a `needs-input` fix with placeholder or invented copy.',
  '- Never commit, push or deploy unless the user asked for it.',
].join('\n');

/** Title + body, the shape every markdown-ish target shares. */
function body(): string {
  return `${TITLE}\n\n${INSTRUCTION}\n`;
}

/**
 * `.claude/skills/vibeward/SKILL.md`. Only `name` and `description` are emitted: those are
 * the two the open Agent Skills standard requires, and the upload paths (claude.ai, the
 * Skills API) reject any field outside the standard six. `name` must equal the parent
 * directory name, and the slash command comes from that directory, not from this field.
 */
export function claudeSkill(): string {
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
 * `.cursor/rules/vibeward.mdc`. `alwaysApply: false` + a `description` and no `globs` is
 * "Apply Intelligently": Cursor pulls the rule in when the request looks related instead
 * of pinning it to every conversation. `.cursorrules` is legacy and never generated.
 */
export function cursorRule(): string {
  return [
    '---',
    `description: ${DESCRIPTION}`,
    'alwaysApply: false',
    '---',
    '',
    `<!-- ${MARK} — regenerate with \`npx vibeward@latest init\` -->`,
    '',
    body(),
  ].join('\n');
}

/**
 * `.devin/rules/vibeward.md` (Windsurf became Devin Desktop in June 2026; `.windsurf/rules`
 * still works as a legacy fallback). `trigger` is required in a directory rule to declare
 * how it activates; `model_decision` is the equivalent of Cursor's "Apply Intelligently".
 */
export function windsurfRule(): string {
  return [
    '---',
    'trigger: model_decision',
    `description: ${DESCRIPTION}`,
    '---',
    '',
    `<!-- ${MARK} — regenerate with \`npx vibeward@latest init\` -->`,
    '',
    body(),
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
