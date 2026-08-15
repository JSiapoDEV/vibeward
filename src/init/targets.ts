// One entry per place an agent reads its instructions from. A target knows its paths, how
// it has to be written, and how to guess whether this repo (or this machine) already uses
// that tool. It knows nothing about prompting or disk I/O — that is `run.ts`.
//
// Paths were verified against live documentation before shipping. A file written to a path
// a tool no longer reads is worse than no file at all: the user believes it is installed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RenderContext } from './templates.js';
import {
  GH_WORKFLOW,
  agentsBlock,
  claudeSkill,
  cursorRule,
  guardHookJson,
  windsurfRule,
} from './templates.js';

export type { RenderContext };

export type Scope = 'project' | 'user';

/**
 * `create` owns the whole file; `merge-json` inserts one key into an existing settings
 * file; `merge-markers` owns only the delimited block inside a file the user also writes in.
 */
export type Strategy = 'create' | 'merge-json' | 'merge-markers';

export interface Target {
  id: string;
  label: string;
  hint: string;
  scopes: Scope[];
  path(scope: Scope, cwd: string, home: string): string | null;
  strategy: Strategy;
  /** Templates that do not depend on the machine simply ignore the context. */
  render(ctx: RenderContext): string;
  /** Heuristic: does this repo/machine already use this tool? */
  detect(scope: Scope, cwd: string, home: string): boolean;
  /** Why it is unavailable in a scope, shown greyed out instead of hidden. */
  unavailable?(scope: Scope): string | null;
}

/** True when any of the given paths exists — the whole detection vocabulary. */
function any(...paths: string[]): boolean {
  return paths.some((p) => existsSync(p));
}

export const TARGETS: Target[] = [
  {
    id: 'claude-skill',
    label: 'Claude Code · skill: audit + fix',
    hint: 'the /vibeward skill, invoked by name or picked up automatically',
    scopes: ['project', 'user'],
    strategy: 'create',
    // The directory name is what creates the `/vibeward` command; the frontmatter `name`
    // only labels it, so the folder must stay called `vibeward`.
    path: (scope, cwd, home) =>
      join(scope === 'user' ? home : cwd, '.claude', 'skills', 'vibeward', 'SKILL.md'),
    render: claudeSkill,
    detect: (scope, cwd, home) =>
      scope === 'user'
        ? any(join(home, '.claude'))
        : any(join(cwd, '.claude'), join(cwd, 'CLAUDE.md')),
  },
  {
    id: 'claude-hook',
    label: 'Claude Code · guard hook',
    hint: 'blocks risky prompts before the agent acts on them',
    scopes: ['project', 'user'],
    strategy: 'merge-json',
    // settings.json and not settings.local.json: the project file is meant to be committed
    // and shared, and hooks merge across levels instead of replacing each other.
    path: (scope, cwd, home) => join(scope === 'user' ? home : cwd, '.claude', 'settings.json'),
    render: (ctx) => guardHookJson(ctx),
    detect: (scope, cwd, home) =>
      scope === 'user'
        ? any(join(home, '.claude'))
        : any(join(cwd, '.claude'), join(cwd, 'CLAUDE.md')),
  },
  {
    id: 'cursor',
    label: 'Cursor · rule',
    hint: 'applied when the request looks related (Apply Intelligently)',
    scopes: ['project'],
    strategy: 'create',
    path: (scope, cwd, _home) =>
      scope === 'user' ? null : join(cwd, '.cursor', 'rules', 'vibeward.mdc'),
    render: cursorRule,
    detect: (scope, cwd, _home) =>
      scope === 'project' && any(join(cwd, '.cursor'), join(cwd, '.cursorrules')),
    unavailable: (scope) =>
      scope === 'user' ? 'Cursor keeps user rules in its settings UI, not in a file on disk' : null,
  },
  {
    id: 'agents-md',
    label: 'AGENTS.md · universal fallback',
    hint: 'read by Codex, Copilot, Cursor, Windsurf, Jules, Aider and ~20 more',
    scopes: ['project', 'user'],
    strategy: 'merge-markers',
    // Codex is the one tool with a user-level AGENTS.md; the open standard defines none.
    path: (scope, cwd, home) =>
      scope === 'user' ? join(home, '.codex', 'AGENTS.md') : join(cwd, 'AGENTS.md'),
    render: agentsBlock,
    detect: (scope, cwd, home) =>
      scope === 'user' ? any(join(home, '.codex')) : any(join(cwd, 'AGENTS.md')),
  },
  {
    id: 'windsurf',
    label: 'Windsurf / Devin · rule',
    hint: 'workspace rule, activated by the model when relevant',
    scopes: ['project'],
    strategy: 'create',
    path: (scope, cwd, _home) => {
      if (scope === 'user') return null;
      // Windsurf became Devin Desktop in June 2026: `.devin/rules` is now the preferred
      // path and `.windsurf/rules` the legacy fallback, and both are still read. Writing
      // where this repo already keeps its rules means an older install still finds it.
      const legacy = join(cwd, '.windsurf', 'rules');
      if (!existsSync(join(cwd, '.devin')) && existsSync(legacy))
        return join(legacy, 'vibeward.md');
      return join(cwd, '.devin', 'rules', 'vibeward.md');
    },
    render: windsurfRule,
    detect: (scope, cwd, _home) =>
      scope === 'project' &&
      any(join(cwd, '.devin'), join(cwd, '.windsurf'), join(cwd, '.windsurfrules')),
    // TODO(verify): the user-level file is documented at
    // ~/.codeium/windsurf/memories/global_rules.md, but that path still carries the
    // pre-rebrand name and no ~/.devin equivalent was confirmed. It is also a single
    // always-on file capped at 6.000 characters, shared with every rule the user wrote by
    // hand. Re-verify before writing into it; per-project rules cost nothing meanwhile.
    unavailable: (scope) =>
      scope === 'user'
        ? 'Windsurf keeps global rules in one always-on file — install it per project instead'
        : null,
  },
  {
    id: 'gh-action',
    label: 'GitHub Action · scan on every push',
    hint: 'uploads findings as SARIF to the repository Security tab',
    scopes: ['project'],
    strategy: 'create',
    path: (scope, cwd, _home) =>
      scope === 'user' ? null : join(cwd, '.github', 'workflows', 'vibeward.yml'),
    render: () => GH_WORKFLOW,
    detect: (scope, cwd, _home) => scope === 'project' && any(join(cwd, '.github')),
    unavailable: (scope) =>
      scope === 'user' ? 'GitHub workflows always live inside a repository' : null,
  },
];

export function findTarget(id: string): Target | null {
  return TARGETS.find((t) => t.id === id) ?? null;
}

/** The targets installable in a scope, in menu order. */
export function targetsFor(scope: Scope): Target[] {
  return TARGETS.filter((t) => t.scopes.includes(scope));
}
