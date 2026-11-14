---
name: ci-security-scanning-with-vibeward
description: Add vibeward to CI so every pull request is scanned for exposed secrets, open Supabase RLS and Firebase exposure, failing the build on critical findings and publishing SARIF to the GitHub Security tab. Works as a GitHub Action or as one npx command in any pipeline, with no API key, no Docker and no LLM call. Use when the user asks to add security scanning, a secret check, a pre-merge gate or SARIF upload to their CI, pipeline or pull requests.
---

<!-- vibeward v0.6.2 — regenerate with `npx vibeward@latest init` -->

# vibeward — scan every pull request

One npx command, no API key, no Docker, no LLM call and no runtime dependencies, so it
runs on a bare runner in seconds. Findings fail the build on critical severity and land in
the GitHub Security tab as SARIF.

vibeward detects and reports. It does not fix anything it finds, and neither do you while you are using it — see the `vibeward` skill before acting on a report.

## 1. GitHub Actions

The generated workflow is the shortest route, and `init` writes it for you:

```bash
npx vibeward@latest init --targets gh-action
```

To wire it by hand instead, use the published action:

```yaml
name: vibeward
on: [push, pull_request]

permissions:
  security-events: write   # required to upload SARIF
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: JSiapoDEV/vibeward@<commit-sha>   # pin by SHA, see below
        with:
          path: .
          fail-on-critical: true
```

**Pin the action by commit SHA, not by tag.** A tag is mutable: whoever controls the
action's repository can move it, and every workflow trusting that tag then runs new code
on the next push. This is the same argument vibeward makes against `npx @latest` inside a
guard hook, and it would not be worth much if the CI advice ignored it. If the user prefers
a tag for readability, say plainly what they are trading.

Inputs: `path` (folder to scan, default `.`), `url` (scan a deployed URL instead — this
adds the website quality and AI-visibility checks), `supabase` (a `vibeward supabase-sql`
export), `fail-on-critical` (default `true`).

## 2. Any other pipeline

There is no plugin to install. GitLab CI, CircleCI, Jenkins, a git hook — all the same
command:

```bash
npx vibeward@latest scan . --sarif vibeward.sarif --stdout > findings.json
```

Exit codes are the gate:

- **`0`** — the scan ran. There may still be findings, and usually there are.
- **`2`** — the scan ran and found **critical security** findings. The payload is on stdout
  exactly as with `0`. This is the code that should fail a merge.
- **`1`** — the scan itself failed and there is no payload. Do not treat this as a pass.

Distinguish `1` from `2` explicitly in whatever wraps it. A pipeline that fails the build on
"non-zero" reports a broken scanner as a security finding, and one that passes on "not 2"
reports a crashed scanner as a clean repo.

## 3. Scan the code, the deployment, or both

**Code** (`scan <folder>`) is the one to gate merges on. It sees what a URL scan cannot —
secrets committed to the repo, a checked-in `.env`, migrations creating tables without RLS,
`USING (true)` policies, `SECURITY DEFINER` functions — and it needs no deployment to exist.

**URL** is worth adding on a deploy or preview-environment workflow, against the preview
URL. Use `--passive` there: it reads only public assets, so it needs no authorization
decision inside a pipeline where nobody is present to make one. Never put `--yes` in a
workflow file — it pre-authorizes reading live rows out of a database, and CI is exactly
where nobody will see the prompt it is answering.

## 4. Do not let a green build overstate itself

The JSON payload carries a `coverage` block. `coverage.complete: false` means something was
skipped, and everything in `coverage.notEvaluated` was **not looked at** — a passive scan of
a Supabase app can exit `0` with an untested database. If the pipeline posts a summary,
post that too, or the green check reads as more than it is.

A folder scan never contacts the live backend at all, and says so in its own coverage. Pair
it with a URL scan, or with a `vibeward supabase-sql` export, before calling the database
covered.

## 5. Secrets and permissions

vibeward needs **no API key and no token of its own**. The only permission the workflow
needs is `security-events: write`, and only to upload SARIF. If a setup seems to require a
secret, something else is being configured — stop and ask. Never create, name or commit a
repository secret on the user's behalf.