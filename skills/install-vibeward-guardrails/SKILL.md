---
name: install-vibeward-guardrails
description: Install vibeward as a hook in Claude Code, Cursor, Codex, Copilot, Gemini, Windsurf or opencode, so risky requests are caught before the agent acts on them — "disable RLS", "use the service_role key in the frontend", "remove the login for now" — in English, Spanish and Portuguese. Deterministic rules with no LLM call, so they cannot be prompt-injected away. Use when the user asks to install vibeward, set up a guardrail, protect a repo from unsafe AI edits, or stop their agent weakening security.
---

<!-- vibeward v0.7.0 — regenerate with `npx vibeward@latest init` -->

# vibeward — install the guardrail into the user's editor

Most vibe-coded holes do not start as bad code. They start as a reasonable-sounding
request — _"disable RLS so it works"_, _"use the service_role key in the frontend"_,
_"remove the login for now"_ — and the agent complies, because complying is the job.
`vibeward guard` runs as an editor hook and catches that the moment it is typed, in
English, Spanish or Portuguese, with why it is dangerous and what to do instead, **before**
the agent acts. The rules are deterministic with no LLM call anywhere, so they cannot be
prompt-injected away.

vibeward detects and reports. It does not fix anything it finds, and neither do you while you are using it — see the `vibeward` skill before acting on a report.

## 1. The installer asks questions, and you are not the one to answer them

`init` is interactive. Run bare, it opens a picker — where to install, which editors, which
moments — and **it refuses to run without a terminal**, which is what you are calling it
from. So there are two correct routes and one wrong one.

**Preferred — hand it to the user.** It writes into their repository and their editor
configuration, and which editors they use is not something inferable from a file tree:

> Run this in your terminal and answer the picker:
> ```
> npx vibeward@latest init
> ```

**Or ask the questions here, then carry out the answer.** If the user would rather you did
it, ask which editors and which moments, in chat, and pass what they said:

```bash
# only after the user has said "Claude Code and AGENTS.md, prompts and actions"
npx vibeward@latest init --scope project \
  --targets claude-code,agents-md --moments prompt,action --yes
```

`--scope` is required in this non-interactive form: `project` installs into the repo, `user`
into the machine-wide config so it covers every project. `--all` selects every target
available for the scope.

**What is wrong is choosing for them.** Do not pick targets from what you find in the tree,
and do not pass `--all --yes` to get past the prompt. The picker is the consent step for a
command that writes files, and answering it on the user's behalf is the behaviour this
tool exists to catch, committed by its own installer.

## 2. What to install where

**Editors** — `claude-code`, `codex`, `cursor`, `copilot`, `gemini`, `windsurf`,
`opencode`. Each gets a skill plus the hook manifest in that editor's native format.

**Shared instruction files** — `claude-md` and `agents-md`. These are not hooks and enforce
nothing; they are the always-on prohibitions, loaded into every conversation in the repo,
for the case where nobody invoked anything and the fastest way past a failing query is to
turn RLS off. Worth having alongside a hook, not instead of one.

**CI** — `gh-action`. See the `ci-security-scanning-with-vibeward` skill.

## 3. The moments

The guard can fire at three points. More is not automatically better — each one costs a
hook invocation on every matching event.

- **`prompt`** — the user's message, before the agent reads it. This is the one that
  catches _"disable RLS so the query works"_, and the one to install if only one is wanted.
- **`action`** — before a Bash, Write or Edit call. Catches what the agent improvised on
  its own, including the request the prompt gate never saw.
- **`content`** — after a Read, WebFetch, WebSearch or Grep. Catches instructions hidden in
  fetched content trying to steer the agent — the injection case.

By default a match **warns the agent in context and lets the turn continue** (exit 0).
Blocking is opt-in per install, because a blocked prompt is a lost paragraph and a
guardrail people turn off protects nothing.

## 4. Report honestly what was installed

`init` prints a summary of what each target can and cannot enforce, given the moments that
were actually chosen. **Relay it as printed.** The guarantees are genuinely not the same
everywhere — some editors have no prompt hook at all, and in some the skill loads but the
guard does not — and a summary that rounds "the skill loads here" up to "you are covered
here" leaves someone believing in protection they do not have.

Do not claim a moment was installed that the user declined, and do not describe the guard
as blocking when it is set to warn.

## 5. Claude Code — the plugin instead

In Claude Code the plugin is the better route when the user has not already run `init`. It
ships a pinned, offline copy of the CLI with the hooks already wired, so there is no
`npx` resolution at the moment a prompt is typed and nothing to install at first use. It
also brings the other skills, including this one.

## 6. Verify, then stop

```bash
npx vibeward@latest --version
```

A hook that is installed and does not run is the one failure this project refuses to ship,
so confirming the binary resolves is worth the one command. Beyond that, do not test the
guard by writing a risky prompt into a file, and do not hand-edit the generated hook
manifests to "improve" them — a later `init` overwrites them, and the version that was
tested is the generated one.