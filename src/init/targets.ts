// One entry per place an agent reads its instructions from. A target knows which files it
// owns, how each has to be written, and how to guess whether this repo (or this machine)
// already uses that tool. It knows nothing about prompting or disk I/O — that is `run.ts`.
//
// Every path comes from capabilities.ts, which is the verified table. Nothing here invents a
// location: a file written where a tool no longer reads is worse than no file at all, because
// the user believes it is installed.
//
// A target may own more than one file — a host normally means "the skill and the hook
// manifest" — so the unit the picker offers is the tool, not the file. Eleven rows a person
// can reason about beat seventeen they scroll past.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Moment } from '../guard/verdict.js';
import { HOSTS, explain, type Host } from './capabilities.js';
import { hookFile, isSharedSettings } from './hooks.js';
import type { RenderContext } from './templates.js';
import { GH_WORKFLOW, agentsBlock, claudeMdBlock, skillFile } from './templates.js';

export type { RenderContext };

export type Scope = 'project' | 'user';

/**
 * `create` owns the whole file; `merge-json` inserts our hooks into a settings file the user
 * also writes in; `merge-markers` owns only the delimited block inside a shared markdown file.
 */
export type Strategy = 'create' | 'merge-json' | 'merge-markers';

export interface TargetFile {
  path: string;
  strategy: Strategy;
  render(ctx: RenderContext): string;
  /** What this file is, for the plan line. */
  kind: 'skill' | 'hooks' | 'rules' | 'ci';
}

export interface Target {
  id: string;
  label: string;
  hint: string;
  scopes: Scope[];
  files(scope: Scope, cwd: string, home: string, ctx: RenderContext): TargetFile[];
  /** Heuristic: does this repo/machine already use this tool? */
  detect(scope: Scope, cwd: string, home: string): boolean;
  /**
   * True when this target installs a hook that the guard actually runs. Structural, not
   * inferred: an earlier version decided this by grepping the summary prose for the word
   * "warns", so rewording the summary silently changed which questions `init` asked.
   */
  guardable?: boolean;
  /** Why it is unavailable in a scope, shown greyed out instead of hidden. */
  unavailable?(scope: Scope): string | null;
  /**
   * What it protects and what it cannot, given the moments actually installed. Printed after
   * install, verbatim. Takes the chosen moments so the summary can never claim coverage the
   * user declined.
   */
  explain?(chosen?: Moment[]): string[];
}

/** True when any of the given paths exists — the whole detection vocabulary. */
function any(...paths: string[]): boolean {
  return paths.some((p) => existsSync(p));
}

function at(scope: Scope, cwd: string, home: string, relative: string): string {
  return join(scope === 'user' ? home : cwd, relative);
}

/**
 * The first path segment, which is also the directory that tells us the tool is in use:
 * `.cursor/skills/vibeward/SKILL.md` detects on `.cursor`.
 */
function root(relative: string): string {
  return relative.split('/')[0] ?? relative;
}

/** Every host becomes one target: its skill, plus its hook manifest when it has one. */
function hostTarget(host: Host): Target {
  const moments = (['prompt', 'action', 'content'] as Moment[]).filter(
    (m) => host.moments[m].event !== null,
  );

  return {
    id: host.id,
    label: host.label,
    hint: moments.length > 0 ? `skill + guard (${moments.join(', ')})` : 'skill only',
    scopes: host.skill.user ? ['project', 'user'] : ['project'],
    guardable: host.hooks !== null && moments.length > 0,
    files(scope, cwd, home, ctx) {
      const relative =
        scope === 'user' ? (host.skill.user ?? host.skill.project) : host.skill.project;
      const out: TargetFile[] = [
        {
          path: at(scope, cwd, home, relative),
          strategy: 'create',
          render: skillFile,
          kind: 'skill',
        },
      ];

      // The guard is only written for moments this host can actually act on AND the user
      // asked for. A manifest entry for an event whose output the host discards costs a
      // process launch per turn and buys nothing.
      const wanted = ctx.moments.filter((m) => host.moments[m].event !== null);
      if (host.hooks && wanted.length > 0) {
        const hookRelative = scope === 'user' ? host.hooks.user : host.hooks.project;
        out.push({
          path: at(scope, cwd, home, hookRelative),
          strategy: isSharedSettings(host) ? 'merge-json' : 'create',
          render: (c) =>
            hookFile(
              host,
              c,
              c.moments.filter((m) => host.moments[m].event !== null),
            ),
          kind: 'hooks',
        });
      }
      return out;
    },
    detect(scope, cwd, home) {
      const relative =
        scope === 'user' ? (host.skill.user ?? host.skill.project) : host.skill.project;
      return any(at(scope, cwd, home, root(relative)));
    },
    unavailable: (scope) =>
      scope === 'user' && !host.skill.user
        ? `${host.label} keeps this per project, not per machine`
        : null,
    explain: (chosen) => explain(host, chosen),
  };
}

export const TARGETS: Target[] = [
  ...HOSTS.map(hostTarget),
  {
    id: 'claude-md',
    label: 'CLAUDE.md · always-on rules',
    hint: 'the short security rules, in context on every turn — not the audit procedure',
    scopes: ['project', 'user'],
    files: (scope, cwd, home) => [
      {
        path: scope === 'user' ? join(home, '.claude', 'CLAUDE.md') : join(cwd, 'CLAUDE.md'),
        strategy: 'merge-markers',
        render: claudeMdBlock,
        kind: 'rules',
      },
    ],
    detect: (scope, cwd, home) =>
      scope === 'user'
        ? any(join(home, '.claude'))
        : any(join(cwd, 'CLAUDE.md'), join(cwd, '.claude')),
    explain: () => [
      'applies when the agent improvises, with no skill invoked and no scan running',
      'it is instructions, not enforcement — nothing stops an agent that ignores them',
    ],
  },
  {
    id: 'agents-md',
    label: 'AGENTS.md · universal fallback',
    hint: 'read by the agents that do not load skills',
    scopes: ['project', 'user'],
    // Codex is the one tool with a user-level AGENTS.md; the open standard defines none.
    files: (scope, cwd, home) => [
      {
        path: scope === 'user' ? join(home, '.codex', 'AGENTS.md') : join(cwd, 'AGENTS.md'),
        strategy: 'merge-markers',
        render: agentsBlock,
        kind: 'rules',
      },
    ],
    detect: (scope, cwd, home) =>
      scope === 'user' ? any(join(home, '.codex')) : any(join(cwd, 'AGENTS.md')),
    explain: () => [
      'the fallback for Aider, Jules and anything else with no skills directory',
      'instructions only — no host enforces an AGENTS.md',
    ],
  },
  {
    id: 'gh-action',
    label: 'GitHub Action · scan on every push',
    hint: 'uploads findings as SARIF to the repository Security tab',
    scopes: ['project'],
    files: (_scope, cwd) => [
      {
        path: join(cwd, '.github', 'workflows', 'vibeward.yml'),
        strategy: 'create',
        render: () => GH_WORKFLOW,
        kind: 'ci',
      },
    ],
    detect: (scope, cwd) => scope === 'project' && any(join(cwd, '.github')),
    unavailable: (scope) =>
      scope === 'user' ? 'GitHub workflows always live inside a repository' : null,
    explain: () => [
      'runs the scan on push and pull request, and reports — it never fails a fix in',
    ],
  },
];

export function findTarget(id: string): Target | null {
  return TARGETS.find((t) => t.id === id) ?? null;
}

/** The targets installable in a scope, in menu order. */
export function targetsFor(scope: Scope): Target[] {
  return TARGETS.filter((t) => t.scopes.includes(scope) && !t.unavailable?.(scope));
}
