# Security Policy

vibeward is a security tool, which means two different things can be reported here and they
are not the same: **a vulnerability in vibeward itself**, and **a hole vibeward failed to
find in your app**. Only the first one is a security report. The second is a normal issue,
and it is welcome — see [Not a vulnerability](#not-a-vulnerability-but-please-report-it-anyway).

## Reporting a vulnerability

**Do not open a public issue for a vulnerability in vibeward.**

Use GitHub's private reporting. It is enabled on this repository, the thread is visible only
to you and the maintainer, and it is the only channel — there is no email address to harvest
off this page, and nobody will ever ask you for one:

**→ [Report a vulnerability](https://github.com/JSiapoDEV/vibeward/security/advisories/new)**

If you cannot use GitHub at all, open a normal issue containing **no details** — just "I have
a security report" — and a private channel will be arranged from there.

Please include:

- the version (`vibeward --version`) and how it was run — `npx`, global install, the
  GitHub Action, or as a Claude Code hook;
- the command line or the prompt that triggers it;
- what an attacker gets, concretely;
- a minimal reproduction, if you have one. A crafted URL, a repo fixture or a prompt is enough.

### What to expect

| | |
|---|---|
| First reply | within **72 hours** |
| Assessment and a fix plan | within **7 days** |
| Fix released | as fast as the severity warrants — a critical gets a same-week patch release |

This is a one-maintainer project, not a company with an on-call rotation. Those are honest
targets, not an SLA. If 72 hours pass with no reply, ping the issue tracker with *"sent a
security report on <date>"* and no details — that is not a disclosure, it is a nudge.

Credit is given in the advisory and the release notes unless you ask to stay anonymous.
There is no bug bounty.

### Disclosure

Coordinated. A fix ships first, then the advisory. **90 days** is the ceiling: if a fix is
not out by then, publish anyway — a deadline that slips forever is how reports rot. If the
flaw is already being exploited in the wild, that window collapses to whatever is safe, and
we say so publicly on day one.

## Supported versions

vibeward is `0.x`, and pre-1.0 means exactly what it says: **only the latest release gets
security fixes.** There are no maintenance branches. `npx vibeward@latest` and a fresh
`npm i -g vibeward` always resolve to the supported version.

| Version | Supported |
|---|---|
| 0.3.x | ✅ |
| < 0.3 | ❌ upgrade |

## What vibeward promises

The security-relevant half of [the contract](README.md#the-contract), restated here because it
bounds what a report against this project can even be about:

- **It detects and reports. It never fixes.** No finding carries a `fix` or an `autofix`
  field, and the installed instructions forbid an agent from acting on one. If you find a
  path by which vibeward edits a user's application code, that is a vulnerability in this
  project, not a feature working.
- **It never calls an LLM.** Every rule is deterministic and in the repository. A guardrail
  that could be argued out of its own rules would not be one.
- **It reads; it does not write to the systems it scans.** The one exception is `--write-test`,
  which is opt-in, off by default and documented as a write.
- **Security findings cannot be silenced by a config file.** `vibeward.json` may only suppress
  `kind: "web"` ids. A way to make a critical security finding disappear from a report through
  configuration is a vulnerability — the report is what someone is trusting.
- **A clean report is not proof of safety.** It means a known, finite list of checks passed.

## Scope

### In scope

The things that make vibeward more dangerous than the average CLI:

- **The guard hook.** It runs on **every prompt you type** and, once the action and content
  moments are installed, on every file the agent writes and every tool result it reads — in
  the user's shell, before the agent acts. Anything that turns any of that input into command
  execution is the highest-severity class in this project. Report it first.
- **The content gate parses hostile input by design.** It scans web pages, README files and
  MCP results that an attacker may control. A crash, a hang (catastrophic backtracking) or an
  escape from it is in scope.
- **`init` writes to a user's real project** and merges into settings files they own. A path
  by which it destroys or exfiltrates existing content is in scope.
- **`vibeward init`.** The one command that writes to disk. Path traversal outside the
  chosen scope, clobbering a file it did not author, writing outside the previewed set, a
  malformed `settings.json` merge that breaks your other hooks — all in scope.
- **Scanner-side injection.** vibeward parses hostile input by definition: JS bundles,
  HTML, `robots.txt`, SQL migrations, a `vibeward.json`, a Supabase JSON export. If a
  scanned target can make vibeward execute code, write outside its output path, exfiltrate
  a local file, or hang forever, that is a vulnerability.
- **The report as an injection vector.** Findings are fed to an LLM agent by design. If a
  scanned site can plant text that reaches the agent as instructions — prompt injection
  through a `<title>`, a filename, an error message — that is in scope and it is the class
  most likely to be real.
- **Suppression bypass.** A `vibeward.json` that silences a `kind: "security"` finding, or
  any input that lowers a severity or empties the SARIF file. The design promise is that a
  security finding cannot be silenced by a config file; a way around that is a bug in the
  verdict itself.
- **Secret handling.** vibeward reads keys and prints evidence. A secret written in full to
  a report, a log, or anywhere on disk that the redaction was supposed to cover is in scope.
- **The published artifact.** The npm package or the GitHub Action shipping something that
  is not built from the tagged commit in this repository.

### Out of scope

- **Findings vibeward misses, or gets wrong.** False negatives and false positives are
  bugs, not vulnerabilities. [Open an issue.](https://github.com/JSiapoDEV/vibeward/issues)
- **Vulnerabilities in the apps you scan.** Those belong to their owner. vibeward is not
  the reporting channel for a leak it found in someone else's Supabase project — tell the
  owner.
- **The guard being talked around.** See below; it is a bug worth reporting, but not a
  vulnerability report.
- **`--write-test` writing.** It is opt-in, documented and off by default. Passing a flag
  that says it writes and then observing a write is the flag working.
- **Anything requiring an already-compromised machine.** If an attacker can edit your
  `~/.claude/settings.json`, the hook command is the least of it.
- Missing hardening with no exploit path, automated-scanner output with no analysis, and
  reports about dependencies vibeward does not ship — it has **zero runtime dependencies**
  on purpose, and Playwright is an optional peer.

## Not a vulnerability, but please report it anyway

**The guardrail is a seatbelt, not a boundary.** `vibeward guard` is a deterministic rule
engine, which is what makes it immune to *"ignore previous instructions"* — but it matches
intent expressed in language, and language is infinite. Someone will always find a phrasing
that means "disable RLS" and does not trip a rule.

That is expected, and it is still worth an issue. A missed phrasing is how the lexicon
grows. Two things make such a report immediately useful:

- **the exact prompt**, verbatim, and the language it is in;
- whether it is a **miss** (dangerous, not caught) or a **false positive** (benign, caught).

False positives matter as much as misses: a guard that cries wolf gets uninstalled, and an
uninstalled guard catches nothing. The benign corpus in `test/intent-test.ts` is the
regression suite for exactly this — a good report usually ends up as a line in it.

**Do not treat the guard as an access control.** It cannot stop a determined user, and it
is not designed to: it exits `0` by default and injects an explanation into the agent's
context. It changes what a careless prompt leads to, which is the actual failure mode. If
you need a hard stop, `--block` is there, and it is still not a boundary.

## Running vibeward safely

- **Authorized targets only.** Scanning is read-only, but pointing it at systems you do not
  own or were not hired to audit may be illegal where you live. `--passive` narrows the scan
  to assets a browser already downloads, with no data probing — that is the mode for a
  target whose owner has not authorized a full scan yet.
- **Prefer a pinned, installed binary over `npx …@latest` for the hook.** `npm i -g vibeward`
  and a hook command of `vibeward guard` means the code running on every prompt is a version
  you chose and can inspect. `@latest` re-resolves against the registry on every run, so any
  future publish executes on your machine without review — including a publish that is not
  ours. It also makes the guard's *availability* depend on the registry: with the network
  down, `npx` hangs and then produces nothing, so the prompt goes through unguarded and
  nothing says so. A stale guard still runs; an absent one does not. See the README's install
  section.
- **Update deliberately, and know when to.** A pinned copy tracks its own age and asks you to
  update once it is over 60 days old. It does that offline, from a build date, and never asks
  a server — so it can tell you it is old, but not that a specific fix has shipped. When a
  security fix goes out it is announced in the GitHub advisory and the release notes; watch
  the repository if you want that the day it happens.
- **Reports contain secrets.** A finding quotes the key it found. Treat `report.md`, the
  JSON payload and the SARIF file as sensitive: do not commit them, and do not paste one
  into a public issue without redacting. If you need to share a finding with us, redact the
  key — we do not need its value to fix the parser.

## Supply chain

- Releases are published from a tagged commit in this repository; the tag is what the
  GitHub Action pins to.
- The npm account has two-factor authentication set to `auth-and-writes` — 2FA is required to
  publish, not just to log in.
- vibeward ships **zero runtime dependencies**. There is no transitive tree to audit.
- The build is `rm -rf dist && tsc` — no bundler, no minifier, no postinstall script.
  What is in `dist/` corresponds to what is in `src/`, and you can regenerate it.

If you ever see a vibeward release whose `dist/` does not correspond to its tag, that is the
report to send first.

## License

MIT. Reporting a vulnerability grants no rights beyond it, and asks none of you.
