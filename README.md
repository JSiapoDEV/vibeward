# vibeward

**Stops the insecure prompt before your agent runs it — and audits what it already shipped.**

```
> disable RLS on the users table so the query works

⚠  vibeward flagged a risky request

✗ Disabling Row-Level Security
  why:  every row becomes readable by anyone holding the public anon key — the single
        most common cause of vibe-coded data leaks.
  do this instead:  keep RLS on and add a policy:
        CREATE POLICY ... USING (auth.uid() = user_id)
```

Most vibe-coded holes do not start as bad code. They start as a reasonable-sounding request:
_"disable RLS so it works"_, _"use the service_role key in the frontend"_, _"remove the login for
now"_. The agent complies, because complying is the job. `vibeward guard` runs as a Claude Code
hook and catches that the moment you type it — in English, Spanish or Portuguese — with why it is
dangerous and what to do instead, **before** the agent acts. The rules are deterministic, with no
LLM call anywhere, so they cannot be prompt-injected away.

For what is already shipped, the same tool is a read-only scanner: exposed secrets, broken
Supabase Row-Level Security, Firebase exposure and insecure backends, from a live URL or from the
repo — plus, on a scale of its own that never gates a build, the SEO and AI-visibility gaps that
give a vibe-coded site away.

![node](https://img.shields.io/badge/node-%3E%3D20-3c873a) ![license](https://img.shields.io/badge/license-MIT-blue) ![types](https://img.shields.io/badge/types-TypeScript-3178c6)

> ⚠️ **Authorized use only.** Run this only against applications whose owner hired or
> authorized you to audit them. Scanning is strictly read-only — no writes, no deletes, no data
> exfiltration — but scanning systems you don't own without permission may be illegal.
> (`vibeward init` is the one command that writes, and only into your own project, after
> showing you exactly which files it will touch.)

---

## The contract

This is the whole of what vibeward promises, and the reference for settling any question about
what it should do next.

**It does three things:**

1. **Detects**, deterministically and with no LLM call anywhere — 38 finding rules over a
   deployed site or a code folder, plus 8 intent rules over natural language in English,
   Spanish and Portuguese.
2. **Reports** — a parseable JSON payload for an agent, a formatted markdown report for a person.
3. **Warns first**, through editor hooks, at the moments risk enters the system.

**It does not:**

- **Fix anything.** Not security findings, not website ones, not the one-line mechanical ones,
  and not on request. It does not edit files, open PRs or deploy. Findings carry no `fix` field
  and no `autofix` field, by design — a clear report is the finished product, not a step toward
  one. What to change is the owner's decision and the owner's edit.
- **Call an LLM.** Not to classify, not to rank, not to suppress false positives. A guardrail
  that can be talked out of its own rules is not a guardrail.
- **Decide severity at runtime.** It is in the rule table or it does not exist.
- **Scan without authorization.** `--passive` is the default; the full scan requires the user to
  state they own the target.
- **Let security be silenced.** `vibeward.json` can only suppress `kind: "web"` ids.
- **Prove a site is safe.** It covers a known, finite list. A clean report means those checks
  passed, nothing more.

What the hooks can actually enforce depends on which editor you run — the guarantees are not the
same everywhere, and [Install it into your AI tools](#install-it-into-your-ai-tools) says exactly
where each one degrades.

---

## Why this exists

The failure is documented, not hypothetical — with the caveats attached, because all three of
these are usually cited badly:

- **[CVE-2025-48757][cve]** — insufficient Row-Level Security in Lovable-generated sites let
  unauthenticated attackers read or write arbitrary tables, "through 2025-04-15". The **9.3
  Critical is CVSS v3.1 assigned by the CNA (MITRE)**, not by NVD: NVD never ran a primary
  analysis, the record is *Deferred* there, and 9.3 appears as a Secondary metric. The record is
  also formally **DISPUTED** — the vendor's position, quoted inside the CVE text, is that each
  customer owns their own app's data. The much-repeated **"170 of 1,645 projects (10.3%)"** is in
  neither the CVE nor NVD: its only primary source is [the reporter's own write-up][cve-statement],
  which reports "303 endpoints across 170 projects (approximately 10.3% of the 1645 analyzed)" from
  a scan completed 21 Mar 2025. That scan visited **the homepage of each site** in the *Lovable
  Launched* showcase, which makes 10.3% a floor rather than a rate: a table the homepage never
  queries was never tested. Both authors — Matt Palmer and Kody Low — work in Developer Relations
  at Replit, a direct competitor.
- **[Moltbook][moltbook-wiz] (Jan 2026)** — the failure was **absent RLS plus unauthenticated
  writes**, not a leaked key: the `sb_publishable_` key in the bundle belongs in the client by
  design. The finding was that tables answered it. Wiz names four — `agents`, `owners`,
  `agent_messages`, `observers` — and reports **29,631 observer emails** (early-access signups),
  **4,060 private DM conversations between agents**, **~17,000 human owner accounts** and
  **~4.75M records**. Remediation took *multiple rounds*: write access to public tables was still
  open after the first, and Wiz demonstrated it by editing a live post. Every figure is as reported
  by Wiz, who say the team "secured it within hours", so nobody verified the counts independently.
  [404 Media][moltbook-404] covered it too; that article is paywalled, so nothing here rests on it.
  Wiz also headline **1.5M API authentication tokens and 35,000 email addresses**. Both are real
  counts from that post — but they count *records*, not people: one token per registered agent, on
  a platform where agent registration was open and automated. The human-scale number in the same
  post is ~17,000 owners.
- **[Veracode, 2026 GenAI Code Security Report][veracode]** — the **average security pass rate is
  56%** across more than 100 models tested over four years, and it "hasn't moved" while the volume
  of AI-generated code exploded — equivalently, **44% of generations fail** security review. The
  2026 edition adds 11 new models over **80 tasks**. Those three
  figures are on the public page; the per-CWE breakdown everyone quotes — XSS, log injection, SQL
  injection, weak crypto — is inside the report itself, behind registration, so treat it as
  uncheckable at the link. It measures out-of-the-box code completion, not whole agent-built apps.

The platforms tell you securing the data is *your* responsibility. `vibeward` is how you check.

[cve]: https://www.cve.org/CVERecord?id=CVE-2025-48757
[cve-statement]: https://mattpalmer.io/posts/2025/05/statement-on-CVE-2025-48757/
[moltbook-wiz]: https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys
[moltbook-404]: https://www.404media.co/exposed-moltbook-database-let-anyone-take-control-of-any-ai-agent-on-the-site/
[veracode]: https://www.veracode.com/resources/analyst-reports/2026-genai-code-security-report/

## What it scans

### Security

1. **Exposed secrets** in every JS bundle — Supabase `service_role` and the new-format
   `sb_secret_` key, Stripe, OpenAI, Anthropic, Google, AWS, GitHub, Slack, database
   connection strings, Resend, SendGrid, Twilio, private PEM keys, and suspicious assignments.
2. **Supabase Row-Level Security** — **enumerates the exposed tables live** from the data API
   (falling back to common names), then probes each with the public key — including new-format
   `sb_publishable_` keys. If a table returns data, RLS is broken; it flags which columns hold
   personal data, scans returned rows for leaked third-party secrets, and checks GraphQL
   introspection. `--write-test` adds an opt-in, non-mutating check for unauthenticated writes.
3. **Firebase** — detects the client config and probes for an open Realtime Database and a
   publicly listable Storage bucket.
4. **Source maps & HTTP headers** — exposed `.map` files, plus CSP, HSTS, X-Frame-Options,
   X-Content-Type-Options, and technology leaks.
5. **Server-rendered stacks** (Next.js + Prisma/Drizzle) — missing security headers in
   `next.config`, server actions and route handlers that mutate data with no auth guard, and
   formula injection in Excel/CSV exports.

### Website quality & AI visibility

Every URL scan also crawls up to 8 same-host pages and reports, **in its own section with its own
scale**:

- **AI visibility** — a `robots.txt` that blocks GPTBot / ClaudeBot / PerplexityBot / CCBot /
  Google-Extended, and a missing `llms.txt`.
- **Search & social** — missing `<title>` or the *same* title on every page, no meta description,
  no canonical, no Open Graph tags, no JSON-LD structured data, no `sitemap.xml`.
- **Structure & accessibility** — zero or multiple `<h1>` per page, missing `lang` attribute,
  images with no `alt`.
- **Quality** — no real 404 page, no favicon, broken assets (a 404 on a `<script>` or `<img>` *is*
  a console error), console errors, and an oversized JS bundle.
- **Vibe-coded fingerprint** — platform domain (`*.vercel.app`, `*.netlify.app`, `*.lovable.app`…),
  detected framework, and an empty view-source, scored out of 12.

**These never gate.** Website findings stay out of the severity counts, out of the SARIF file, and
out of the exit code. A missing favicon must never share a scale with an exposed service key.
Skip them entirely with `--no-web`.

> vibeward is **not Lighthouse**: it detects *binary absences* — the tag isn't there, the file
> isn't there — which is exactly what a vibe-coded site is missing. Core Web Vitals and full WCAG
> auditing are out of scope.

### `vibeward.json` — tell it what the site is meant to be

Some "problems" are decisions. Drop a `vibeward.json` next to the project (or point at one with
`--config`) and vibeward checks reality against what you declared:

```json
{
  "schemaVersion": 1,
  "intent": { "aiCrawlers": "blocked", "siteType": "website" },
  "suppress": [{ "id": "web_missing_og", "reason": "private landing, never shared" }]
}
```

**`intent` is not a mute button.** Declaring `aiCrawlers: "blocked"` stops vibeward calling that a
mistake — and turns the question around: *are you blocked as thoroughly as you think?* If your
robots.txt shuts out three of the twelve AI crawlers, that incomplete block is now the finding.
Believing you are closed while nine crawlers walk in is worse than not having decided.

`siteType` switches off a whole family in one line: an `internal` tool is not judged on sitemaps,
Open Graph or canonical URLs, but still on broken assets and `alt` text.

**`suppress` never hides anything.** Every entry needs a `reason`, the report prints
*"produced with N suppression(s) in effect"* right under the verdict, and lists each one with its
declared reason. And **only `kind: "web"` checks can be suppressed** — a security finding cannot be
silenced by a config file, by design. A verdict anyone can edit their way out of is not a verdict.

The file is read from **local disk only**, never from the site being scanned: otherwise anyone
could silence their own audit by uploading a file to their own server.

By default the scan is strictly read-only. `--passive` narrows it further, to only the assets a
browser already downloads (bundles, headers, public pages) with no data probing at all — that is
the mode to use when you are looking at an app whose owner has not authorized a full scan yet.

The deeper server-side classes (IDOR/BOLA behind a login, rate limiting, orphaned datastores,
business logic) are **not** claimed by an automated scan — they are the manual part of an audit.

## Run it

No install:

```bash
npx vibeward@latest https://client-app.lovable.app
npx vibeward@latest init
```

If you use it more than once, a global install is the same commands without the wait:

```bash
npm i -g vibeward
vibeward https://client-app.lovable.app
```

Either entry point is fine, including for setting up the guard — `init` resolves that part
itself and **never writes `@latest` into your settings**. The examples below drop the prefix.

**Why the guard hook is the exception.** A scan is something you run on purpose, a few times a
day; paying `npx`'s registry round-trip for it is fine. The guard runs on *every prompt you
type*, and there `npx vibeward@latest` costs you three things:

```
npx vibeward@latest guard   1.78s
vibeward guard              0.16s   ← 11×
```

1.8 s added to every prompt, a hard dependency on the network (`@latest` re-resolves against
the registry every run, so offline means a failing hook), and — the one that actually
matters for a security tool — **every future version I publish executes on your machine
without review.** If my npm account is ever compromised, `@latest` is instant code execution
across every user, on their next keystroke. An installed binary is a version you chose.

## Guardrail — stop risky requests before they happen

Eight rules, matched against what you actually asked for: disabling RLS, moving a `service_role`
key into the client, making a bucket or a table public, removing an auth check, a CORS wildcard,
hardcoding a secret, turning off CSRF or rate limiting, committing a `.env`. Each one answers with
the risk, why it matters, and the safe alternative.

It is a rule engine and not a model, which is the whole point: *"ignore previous instructions"*
does not work on a regex. It also means it is a seatbelt and not a boundary — someone will always
find a phrasing that means "disable RLS" and does not trip a rule. Report those, they are how the
lexicon grows.

**It works in English, Spanish and Portuguese.** Not by translating eight rules three times —
the dangerous *objects* are already language-independent (`RLS`, `service_role`, `CORS`, `.env`
are identifiers, not words), so a language costs one small verb table in `src/checks/lexicon.ts`
and nothing else. That is roughly 40 entries a native speaker can review in five minutes, which
is the only way a rule set in a language you don't read ever gets audited. PRs adding a table
are welcome; the benign corpus in `test/intent-test.ts` is what a new language has to pass.

**`vibeward init` wires it up for you, from either entry point.** It looks for an installed
`vibeward`, offers to install one if there is none, and pins to an exact version if you decline —
so `npx vibeward@latest init` is a perfectly good way in, and `@latest` still never reaches your
settings. Re-running it also repoints a hook an older version left on `@latest`, keeping any
flags you added.

To do it by hand instead, install the binary and add it as a **Claude Code**
`UserPromptSubmit` hook (in `~/.claude/settings.json` or a project's `.claude/settings.json`):

```bash
npm i -g vibeward
```

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "vibeward guard" }] }
    ]
  }
}
```

Use the installed binary here, not `npx vibeward@latest` — see [Run it](#run-it) for why a
hook that runs on every prompt is the one place `@latest` is a bad trade. Update on your own
schedule with `npm i -g vibeward@latest`.

**How you find out there is a newer one.** A pinned copy could quietly rot, so it keeps track
of its own age: past 60 days, the guard adds one line asking you to update — but only when it
was already firing about something else, so a benign prompt never carries a maintenance notice.
`vibeward init` and every scan say it too.

It says *how old it is*, not *that an update exists*, because it never asks anyone. There is no
version check, no ping, no daily request — the claim that vibeward makes no network call except
to the target you name stays literally true, and a nudge that overstates what it actually
checked is a nudge people learn to ignore.

By default a risky request is **not blocked**. `UserPromptSubmit` is the one hook whose stdout is
fed back into the model's context, so the guard exits `0` and injects the rule — the risk, why it
matters, and the safe alternative — into the context of the agent that is about to act. Your prompt
survives, and the agent corrects its own approach. A false positive costs you one ignored note.

Add `--block` if you want the hard stop instead (`exit 2`): Claude Code then blocks the prompt
**and erases it**, which is the right trade for a small team with a strict policy and the wrong one
for everyone else. `--warn` still works as an alias of the default for older `settings.json` files.

## Install it into your AI tools

```bash
npx vibeward@latest init
```

An interactive picker asks **where** (this project or your user account) and **what**, pre-checking
whatever it detects in your repo:

```
? Where do you want it?
❯ ● This project      ~/Developer/my-site
  ○ My user account   available in every repo

? What should I install?
❯ ◉ Claude Code             skill + guard (prompt, action, content)
  ◉ Cursor                  skill + guard (prompt, action, content)
  ○ OpenAI Codex CLI        skill + guard (prompt, action, content)
  ○ GitHub Copilot CLI      skill + guard (action, content)
  ○ Gemini CLI              skill + guard (prompt, action, content)
  ○ Windsurf / Devin        skill + guard (prompt, action)
  ○ opencode                skill + guard (prompt, action, content)
  ◉ CLAUDE.md · always-on rules            merge
  ○ AGENTS.md · universal fallback         merge
  ○ GitHub Action · scan on every push

? What should the guard watch?
❯ ◉ When you send a prompt
  ◉ When the agent edits a file or runs a command
  ◉ When the agent reads a page, file or tool result
```

Each host gets one `SKILL.md` — the format is now shared, so the per-editor rule files
(`.cursor/rules`, `.devin/rules`) are gone and there is one body of text instead of four.

### The three moments, and where each one actually works

| | you send a prompt | the agent edits or runs | the agent reads |
|---|---|---|---|
| **Claude Code** | warns | asks, with the reason | warns |
| **Codex CLI** | warns | asks, with the reason | warns |
| **Cursor** | ⚠️ can only block | asks, with the reason | warns |
| **Copilot CLI** ¹ | ❌ output is discarded | asks, reason only on deny | warns |
| **Gemini CLI** | warns | ⚠️ deny only, no warning | warns |
| **Windsurf / Devin** | ⚠️ blocks or nothing | ⚠️ blocks or nothing | ❌ display-only |
| **opencode** | warns | blocks, with the reason | warns |

¹ **"Copilot" is two products here, and only one of them gets the guard.** Hooks exist in
Copilot CLI and the Copilot cloud agent — [not in the VS Code extension][copilot-hooks]. The
SKILL.md does reach VS Code and JetBrains agent mode, so installing the Copilot target from an
IDE gives you the audit skill and **no guard at all**. `init` says so after it writes.

[copilot-hooks]: https://docs.github.com/en/copilot/concepts/agents/hooks

"Warns" means the note reaches the **model** and nothing is interrupted — a false positive costs
one ignored paragraph. Where an editor cannot do that, vibeward **stays silent rather than
blocking**: losing the paragraph you just typed is how a guardrail gets uninstalled, and one that
is uninstalled protects nobody. `init` prints these limits after it writes, per editor, so you
know what you actually have. Pass `--block` on the hook command if you want the hard stop anyway.

The **action** row is the one worth reading twice. It is the only moment nobody asked for: the
agent hits a failing query and reaches for `DISABLE ROW LEVEL SECURITY` on its own. The prompt
gate never sees it, because there was no prompt.

It previews every file before touching disk, never overwrites a file it did not write, merges
settings files key by key (your other hooks stay put) and markdown between markers — so
re-running is how you *update*. It backs up any existing file to `<file>.vibeward.bak` before its
first change, and works non-interactively for CI and dotfiles:

```bash
vibeward init --scope project --targets claude-code,cursor --moments prompt,action --yes
vibeward init --scope user --all --yes
```

**Why a skill?** Because the split matters: **the deterministic package detects, the agent
explains.** An agent asked to "check if the meta description is missing" hallucinates. A parser
answering yes/no never does. So the scanner decides what is true, and the skill's job is to turn
that into something a human can act on — leading with what it costs, quoting the evidence
verbatim, and never restating a severity in its own words.

What the skill explicitly forbids is the agent going on to fix any of it. That is not a
limitation to be worked around, it is the point: an audit that ends in a pile of unrequested
diffs replaces the thing you can act on with a thing you now have to review. And on the security
side it is worse than untidy — deleting an exposed key from a bundle does not un-leak it. The key
has to be rotated, and only the owner decides when, and whether the incident has to be disclosed.
Quietly patching it hides an incident from the person accountable for it.

> One gotcha worth knowing: **Claude Code reads `CLAUDE.md`, not `AGENTS.md`.** If you install only
> the AGENTS.md target, add `@AGENTS.md` as the first line of your `CLAUDE.md` — or just install the
> Claude Code skill, which `init` offers first.

## Two modes

Beyond the guardrail, vibeward also scans finished code — the backstop.

**Black-box** (from a URL) is the quick outside-in check — great as a first look:

```bash
vibeward https://client-app.lovable.app
vibeward https://client-app.lovable.app --passive   # public assets only, no data probing
```

**White-box** (from the code) is the deep audit — it reads the actual folder (a git repo, a
downloaded ZIP from v0/Bolt/Lovable, or a synced folder) and reports exact `file:line` context:

```bash
vibeward scan ./client-app
```

It scans source files for secrets and a committed `.env`, and analyzes any Supabase/SQL
migrations for tables created without RLS, permissive `USING (true)` policies, and
`SECURITY DEFINER` functions.

### For agents and CI

```bash
vibeward https://client-app.lovable.app --json --stdout --yes
```

The JSON payload goes to **stdout** and every human-facing line to **stderr**, so it pipes straight
into a parser. No colors, no prompts, and no report files unless you pass `--out`. The payload
carries a `schemaVersion` — if the shape ever changes, that number changes with it.

### Deep Supabase audit without giving away credentials

Row-Level Security, policies and functions live in the Supabase project, not always in the code.
Print a read-only query, run it in the Supabase SQL Editor, download the single JSON result, and
feed it in — zero access to the client's project required:

```bash
vibeward supabase-sql > audit.sql        # 1. send/run this query in the SQL Editor
vibeward scan ./client-app --supabase result.json   # 2. fold the export into the report
```

### Optional: real browser console errors

Console errors need a real browser, and vibeward ships with **zero runtime dependencies** on
purpose. If Playwright happens to be installed, it is used; if not, the scan says so and falls back
to what it can prove without one (broken assets):

```bash
npm i -D playwright && npx playwright install chromium
```

### Flags

| Flag | Description |
|---|---|
| `--passive` | URL mode: read only public assets (bundles, headers, pages) — no data probing |
| `--write-test` | URL mode: opt-in, non-mutating check for unauthenticated writes |
| `--no-web` | URL mode: skip the website quality / AI-visibility checks |
| `--config <file>` | Path to a `vibeward.json` (default: beside the target, then the cwd) |
| `--supabase <file.json>` | Fold in a Supabase audit export (from `supabase-sql`) |
| `--supabase-url <url>` / `--anon-key <key>` | URL mode: Supabase config if not auto-detected |
| `--no-rls` | URL mode: skip the Row-Level Security probe |
| `--sarif <file>` | Write SARIF 2.1.0 (for GitHub code scanning) — security findings only |
| `--out <file.md>` | Report path |
| `--json` | Also dump raw findings as JSON |
| `--stdout` | Print the JSON payload on stdout, everything else on stderr (implies `--yes`) |
| `--yes` | Confirm authorization without the interactive prompt |

Exit code `2` when critical **security** findings are present (useful in CI). Website findings
never change it.

## GitHub Action

Run vibeward on every push and see findings in the repo's **Security** tab:

```yaml
# .github/workflows/vibeward.yml
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
      - uses: JSiapoDEV/vibeward@v0.5.0
        with:
          path: '.'
          # supabase: audit.json   # optional: a committed Supabase export
```

Findings upload as SARIF; the job fails on a critical finding (set `fail-on-critical: 'false'` to
report without gating).

## Development

Requires Node **24** (`.nvmrc`); the published build targets Node ≥ 20.

```bash
nvm use
npm install
npm run dev -- https://example.com --yes   # run from source (tsx)
npm test                                    # synthetic checks, touches nothing external
npm run build                               # compile to dist/
npm run lint && npm run format:check        # ESLint + Prettier
```

```
src/
  cli.ts             entry point — arg parsing & command dispatch
  core/              types, version, terminal helpers, arg parsing, prompts, vibeward.json
  http/              fetch client, script/bundle discovery, same-host site crawl
  checks/            detection logic, one file per domain:
    secrets.ts         secret patterns (URL + source)
    supabase.ts        table enumeration, RLS/write probe, GraphQL, audit export
    firebase.ts        RTDB + Storage exposure
    migrations.ts      SQL migration analysis
    backend.ts         Next.js/Prisma: headers, unguarded mutations, export injection
    headers.ts         security headers
    sourcemaps.ts      exposed source maps
    web.ts             SEO, AI visibility, quality, vibe-coded fingerprint
    console.ts         browser console errors (optional Playwright)
    intent.ts          guardrail intent rules (declared as verb + target, compiled per language)
    lexicon.ts         verb tables and shared targets — add a language here, nowhere else
  scanners/          orchestrators: url (black-box), folder (white-box), guard (hook)
  init/              the `init` command: targets, templates, installer
  reporters/         markdown report, SARIF output, output/finish
test/self-test.ts    synthetic tests (touch nothing external)
test/prompt-test.ts  interactive selectors, driven through a fake TTY
action.yml           GitHub Action (composite)
```

## Audits

The limits above are real, and they are the interesting half. Broken object-level authorization
behind a login, a tenant boundary that holds on the first request and leaks on the third, business
logic that was wrong before anyone typed a prompt — no scanner finds those, this one included.

That part needs someone reading your app, and it is the work I do: Supabase and Firebase rules,
auth boundaries, and a written report specific enough that your own agent can act on it.
**[Book 20 minutes](https://cal.com/jsiapo)** and bring the URL.

vibeward stays free and MIT regardless. There is no paid tier and nothing is held back from it.

## License

MIT © José Siapo
