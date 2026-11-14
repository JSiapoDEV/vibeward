# vibeward — Agent Guide

vibeward stops the insecure prompt before your AI agent runs it, and audits what already
shipped. This file is for AI coding agents that want to **use** vibeward (scan an app, install
the guardrail) or **contribute** to it.

It is hand-written and is not the block `vibeward init` merges into a user's `AGENTS.md`. That
block lives between `<!-- vibeward:start -->` markers and is generated from
`src/init/templates.ts`; nothing here is generated.

---

## Using vibeward from an agent

Install the agent skills for step-by-step workflows:

```bash
npx skills add JSiapoDEV/vibeward#plugin
```

- `vibeward` — scan a deployed URL or a code folder and report what it finds
- `install-vibeward-guardrails` — install the prompt/action guard into the user's editor
- `ci-security-scanning-with-vibeward` — gate pull requests and publish SARIF

Claude Code users can instead install the plugin, which ships the same skills plus the hooks
already wired: the guard runs on every prompt with no `init` step.

### Scanning

No install, no API key, no Docker, no LLM call anywhere:

```bash
# A deployed site, from the outside. --passive reads only public assets.
npx vibeward@latest <url> --passive --json --stdout --out vibeward-report.md

# The code, from the inside — secrets, committed .env, migrations without RLS.
npx vibeward@latest scan <folder> --json --stdout --out vibeward-code-report.md
```

`--stdout` puts the JSON payload on stdout and every human-facing line on stderr, so stdout
parses cleanly. `--out` writes the markdown report, which is the deliverable for the person.

- **Exit codes:** `0` the scan ran (there may still be findings), `2` the scan ran and found
  **critical security** findings — the payload is on stdout exactly as with `0`, so read it
  rather than retrying, `1` the scan itself failed and there is no payload.
- **`--yes` pre-authorizes reading live data out of a Supabase or Firebase backend.** Do not
  pass it on your own. A URL appearing in the conversation is not authorization. `--stdout`
  implies it, which is why `--passive` belongs in the agent-facing command above.
- **An empty `findings` list is not a clean bill of health.** Check `coverage.complete` before
  writing the word "clean": everything in `coverage.notEvaluated` was not looked at, and a
  `--passive` scan over a Supabase app reports zero findings and an unevaluated database.
  Those are two facts, not one.

### Installing the guardrail

```bash
npx vibeward@latest init                      # interactive picker
npx vibeward@latest init --targets claude-code,agents-md --moments prompt,action --yes
```

Targets: `claude-code`, `codex`, `cursor`, `copilot`, `gemini`, `windsurf`, `opencode`,
`claude-md`, `agents-md`, `gh-action`. Moments: `prompt`, `action`, `content`. `init` is the
only command that writes to disk, and only into the user's own project, after showing the file
list. What each editor can actually enforce differs — the summary it prints after installing
says where the guarantee degrades, and it never claims coverage the user declined.

### What vibeward will not do, so do not ask it to

It does not fix anything, call an LLM, decide severity at runtime, or scan a backend without
asking. Findings carry no `fix` and no `autofix` field by design. **Only scan targets the user
owns or is authorized to audit.**

---

## Contributing to this repo

- Node ≥ 20 (`.nvmrc`), TypeScript, ESM. **No runtime dependencies** — that is a contract, not
  an accident, so a PR that adds one needs to argue for it.
- No lockfile is committed (there is nothing to lock), so use `npm install`, not `npm ci`.

```bash
npm install
npm run dev -- <url>     # run from source via tsx
npm test                 # six suites, 842 assertions
npm run lint             # eslint
npm run typecheck        # tsc --noEmit, source and tests
npm run format:check     # prettier
npm run build            # rm -rf dist && tsc
npm run build:plugin     # build + regenerate skills/, bin/ and the plugin manifest
```

CI runs lint, typecheck, format:check and the full suite on every pull request, and separately
checks that `npm run build:plugin` still produces what the hooks expect to run.

### Layout

| Path            | What lives there                                                              |
| --------------- | ----------------------------------------------------------------------------- |
| `src/checks/`   | Every rule. One file per family — secrets, supabase, firebase, headers, migrations, web, intent, injection |
| `src/scanners/` | The two entry points: `url.ts` (black-box) and `folder.ts` (white-box)         |
| `src/guard/`    | The editor hook — verdicts, per-host payload parsing, the moments it fires at  |
| `src/reporters/`| Markdown, the JSON payload, SARIF, and the report strings in both languages    |
| `src/core/`     | Types, args, config, i18n, the coverage ledger                                 |
| `src/init/`     | The installer: which hosts exist, what each can enforce, and every template    |
| `src/http/`     | Fetch, crawl, bundle discovery                                                 |
| `test/`         | Six suites. `contract-test.ts` asserts the promises the README makes           |

### Rules to work inside

- **Every rule is deterministic.** No LLM call anywhere, at any point, for any reason —
  including to rank or to suppress false positives. A guardrail that can be talked out of its
  own rules is not a guardrail.
- **A new rule needs a false-positive corpus**, not just a positive case. The suites carry
  bodies of harmless input built specifically to make the rules misfire; a detector that has
  only ever been shown input it should catch has not been tested.
- **Severity is in the rule, never computed at runtime.**
- **A finding must never gain a `fix` or `autofix` field.** `contract-test.ts` fails the build
  if one does. What to change belongs in `why`, in prose a person can act on.
- **Security findings cannot be suppressed.** `vibeward.json` may only silence `kind: "web"`
  ids, and a suppressed finding is listed in the report rather than dropped.
- **Anything a scan skipped must reach `coverage`**, with the reason. Silence there is how a
  report ends up sounding more thorough than the run was.
- **Every finding needs a Spanish `es` overlay.** An untranslated one is a failing test, not a
  mixed-language report someone notices in a client's inbox.
- Prose in a template or a report string is source. Change it in `src/`, never in the generated
  file under `skills/` or `bin/`.

`METHODOLOGY.md` states what the published numbers were measured against, what they do not
cover, and how to reproduce each one from a tag.
