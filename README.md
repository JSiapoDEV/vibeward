# vibeward

**Security scanner for AI-generated / vibe-coded apps** — Lovable, Bolt, v0, Supabase, MCP.

Apps built with AI tools ship fast, and ship the same handful of critical holes:
exposed API keys, missing Row-Level Security, authorization checked in the browser.
`vibeward` finds them from the outside, read-only, in one command.

![node](https://img.shields.io/badge/node-%3E%3D20-3c873a) ![license](https://img.shields.io/badge/license-MIT-blue) ![types](https://img.shields.io/badge/types-TypeScript-3178c6)

> ⚠️ **Authorized use only.** Run this only against applications whose owner hired or
> authorized you to audit them. It is strictly read-only — no writes, no deletes, no data
> exfiltration — but scanning systems you don't own without permission may be illegal.

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

1. **Exposed secrets** in every JS bundle — Supabase `service_role` (decoded from the JWT role,
   so the public `anon` key is not flagged), Stripe, OpenAI, Anthropic, Google, AWS, GitHub,
   Resend, SendGrid, Twilio, private PEM keys, and suspicious secret assignments.
2. **Supabase Row-Level Security** — probes ~60 common table names with the public key. If a table
   returns data, RLS is broken, and it flags which columns hold personal data.
3. **HTTP security headers** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options, and tech leaks.

Server-side checks (authorization, input validation, rate limiting, backups) are covered by the
manual part of an audit — see [`CHECKLIST-25.md`](../CHECKLIST-25.md).

## Run it

No install needed — use `npx`, so you always run the latest version:

```bash
npx vibeward@latest https://client-app.lovable.app
```

(All the examples below drop the `npx vibeward@latest` prefix for brevity.)

## Guardrail — stop risky requests before they happen

Most vibe-coded holes start with a prompt: _"disable RLS so it works"_, _"use the service_role
key in the frontend"_, _"make it public to debug"_, _"remove the login for now"_. `vibeward guard`
catches those the moment you ask — and tells you why and what to do instead — **before** the agent
acts. The rules are deterministic (no LLM call), so they can't be prompt-injected away.

Add it as a **Claude Code** `UserPromptSubmit` hook (in `~/.claude/settings.json` or a project's
`.claude/settings.json`):

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
```

**White-box** (from the code) is the deep audit — it reads the actual folder (a git repo, a
downloaded ZIP from v0/Bolt/Lovable, or a synced folder) and reports exact `file:line` context:

```bash
vibeward scan ./client-app
```

It scans source files for secrets and a committed `.env`, and analyzes any Supabase/SQL
migrations for tables created without RLS, permissive `USING (true)` policies, and
`SECURITY DEFINER` functions.

### Deep Supabase audit without giving away credentials

Row-Level Security, policies and functions live in the Supabase project, not always in the code.
Print a read-only query, run it in the Supabase SQL Editor, download the single JSON result, and
feed it in — zero access to the client's project required:

```bash
vibeward supabase-sql > audit.sql        # 1. send/run this query in the SQL Editor
vibeward scan ./client-app --supabase result.json   # 2. fold the export into the report
```

### Flags

| Flag | Description |
|---|---|
| `--supabase <file.json>` | Fold in a Supabase audit export (from `supabase-sql`) |
| `--supabase-url <url>` / `--anon-key <key>` | URL mode: Supabase config if not auto-detected |
| `--no-rls` | URL mode: skip the Row-Level Security probe |
| `--sarif <file>` | Write SARIF 2.1.0 (for GitHub code scanning) |
| `--out <file.md>` | Report path |
| `--json` | Also dump raw findings as JSON |
| `--yes` | Confirm authorization without the interactive prompt |

Exit code `2` when critical findings are present (useful in CI).

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
      - uses: JSiapoDEV/vibeward@v1
        with:
          path: '.'
          # supabase: audit.json   # optional: a committed Supabase export
```

Findings upload as SARIF; the job fails on a critical finding (set `fail-on-critical: 'false'` to
report without gating).

## Example report

Run `npm run demo` to generate a sample report from synthetic data — it's identical to what a
client receives, with critical findings, an executive summary and a database-exposure table.

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
  scan.ts          CLI entry (url / scan / supabase-sql)
  demo.ts          sample-report generator
  lib/
    fetchers.ts    fetch + bundle discovery
    secrets.ts     secret patterns & detection (URL + source)
    supabase.ts    RLS probe + audit-export analysis
    folder.ts      white-box folder walk
    migrations.ts  SQL migration analysis
    headers.ts     security headers
    report.ts      Markdown report
    sarif.ts       SARIF 2.1.0 output
    types.ts       shared types
test/self-test.ts  synthetic tests
action.yml         GitHub Action (composite)
```

## License

MIT © José Siapo
