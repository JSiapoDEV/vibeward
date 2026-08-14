# vibeward

**Scanner for AI-generated / vibe-coded apps and websites** — Lovable, Bolt, v0, Supabase, MCP.

Things built with AI ship fast, and ship the same handful of holes. **Apps** leak API keys, forget
Row-Level Security and check authorization in the browser. **Websites** ship with no metadata, no
sitemap and a robots.txt that blocks the AI assistants people now search with — invisible to
Google and to ChatGPT alike. `vibeward` finds both from the outside, read-only, in one command.

![node](https://img.shields.io/badge/node-%3E%3D20-3c873a) ![license](https://img.shields.io/badge/license-MIT-blue) ![types](https://img.shields.io/badge/types-TypeScript-3178c6)

> ⚠️ **Authorized use only.** Run this only against applications whose owner hired or
> authorized you to audit them. Scanning is strictly read-only — no writes, no deletes, no data
> exfiltration — but scanning systems you don't own without permission may be illegal.
> (`vibeward init` is the one command that writes, and only into your own project, after
> showing you exactly which files it will touch.)

---

## Why this exists

The failure is documented, not hypothetical:

- **CVE-2025-48757** (CVSS **9.3**) — insufficient Supabase RLS in Lovable let unauthenticated
  attackers read/write arbitrary tables. **170 of 1,645 analyzed projects (10.3%)** were vulnerable.
- **Moltbook (2026)** — a vibe-coded app with no RLS policies and a public key in the client bundle
  exposed **~1.5M auth tokens and 35,000 emails**.
- **Veracode (2025)** — AI-generated code introduced security flaws in **45% of tests**.

The platforms tell you securing the data is *your* responsibility. `vibeward` is how you check.

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

No install needed — use `npx`, so you always run the latest version:

```bash
npx vibeward@latest https://client-app.lovable.app
```

(All the examples below drop the `npx vibeward@latest` prefix for brevity.)

## Install it into your AI tools

```bash
npx vibeward@latest init
```

An interactive picker asks **where** (this project or your user account) and **what**, pre-checking
whatever it detects in your repo:

```
? Where do you want it?
❯ ● This project      ~/Developer/my-site
  ○ My user account   ~/.claude — available in every repo

? What should I install?
❯ ◉ Claude Code · skill: audit + fix     .claude/skills/vibeward/SKILL.md
  ◉ Claude Code · guard hook             .claude/settings.json         merge
  ◉ Cursor · rule                        .cursor/rules/vibeward.mdc
  ○ AGENTS.md · universal fallback       AGENTS.md                     merge
  ○ Windsurf / Devin · rule              .devin/rules/vibeward.md
  ○ GitHub Action · scan on every push   .github/workflows/vibeward.yml
```

Options that the chosen scope cannot take are shown greyed out **with the reason** rather than
hidden — Cursor keeps user-level rules in its settings UI, not on disk, and a GitHub workflow only
ever lives inside a repository.

It previews every file before touching disk, never overwrites a file it did not write, merges
`settings.json` key by key (your other hooks stay put) and `AGENTS.md` between markers — so
re-running is how you *update*. It backs up any existing file to `<file>.vibeward.bak` before its
first change, and works non-interactively for CI and dotfiles:

```bash
vibeward init --scope project --targets claude-skill,claude-hook,cursor --yes
vibeward init --scope user --all --yes
```

**Why a skill?** Because the split matters: **the deterministic package detects, the agent fixes.**
An agent asked to "check if the meta description is missing" hallucinates. A parser answering
yes/no never does. So vibeward reports, the skill applies the fixes it can, and then **re-runs
vibeward to verify** — `detect → fix → re-detect`, the same loop as a test suite. Every finding
carries a `fix` and an `autofix` field (`auto` / `needs-input` / `manual`) that tells the agent
exactly how far it may go on its own.

The installed instructions are explicit that **security findings are never auto-fixed**: deleting an
exposed key from a bundle does not un-leak it, and only the owner decides when it is rotated and
whether the incident has to be disclosed.

> One gotcha worth knowing: **Claude Code reads `CLAUDE.md`, not `AGENTS.md`.** If you install only
> the AGENTS.md target, add `@AGENTS.md` as the first line of your `CLAUDE.md` — or just install the
> Claude Code skill, which `init` offers first.

## Guardrail — stop risky requests before they happen

Most vibe-coded holes start with a prompt: _"disable RLS so it works"_, _"use the service_role
key in the frontend"_, _"make it public to debug"_, _"remove the login for now"_. `vibeward guard`
catches those the moment you ask — and tells you why and what to do instead — **before** the agent
acts. The rules are deterministic (no LLM call), so they can't be prompt-injected away.

`vibeward init` wires it up for you. To do it by hand, add it as a **Claude Code**
`UserPromptSubmit` hook (in `~/.claude/settings.json` or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "npx vibeward@latest guard" }] }
    ]
  }
}
```

A risky request is now blocked with an explanation before the model runs. Use `guard --warn` to
warn without blocking.

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
      - uses: JSiapoDEV/vibeward@v0.3.0
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
    intent.ts          guardrail intent rules
  scanners/          orchestrators: url (black-box), folder (white-box), guard (hook)
  init/              the `init` command: targets, templates, installer
  reporters/         markdown report, SARIF output, output/finish
test/self-test.ts    synthetic tests (touch nothing external)
test/prompt-test.ts  interactive selectors, driven through a fake TTY
action.yml           GitHub Action (composite)
```

## License

MIT © José Siapo
