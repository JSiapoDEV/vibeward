// Where the guard hook's command comes from.
//
// The hook runs on every prompt the user types, which makes it the one place `npx
// vibeward@latest` is the wrong default: it adds a registry round-trip per prompt, fails
// with no network, and — the part that matters for a security tool — executes whatever was
// published most recently, on every user's machine, with nobody reviewing it. So `init`
// writes a *pinned* npx, and `@latest` never reaches a settings.json.
//
// Nothing recommends a global install any more: it froze every user's copy at whatever they
// happened to install, which for a tool whose value is an up-to-date rule set is the worse
// failure. The PATH lookup survives anyway, because a contributor or an older install should
// get the fast path rather than be punished for it. What replaces the install is
// `upgradeGuardCommand`, which raises the pin on the next `init` — see the note there.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../core/version.js';

/**
 * The npx cache directory. A `vibeward` found in there belongs to the `npx vibeward@latest
 * init` that is running right now: it is a temporary extraction that will not exist by the
 * next prompt, and writing it into a hook produces a command that silently fails forever.
 */
const NPX_CACHE = /[\\/]_npx[\\/]/;

/**
 * The first real `name` on PATH, or null. Deliberately not `which`/`where`: spawning a
 * process to answer a filesystem question is slower, needs a shell, and behaves differently
 * on Windows. `env` is a parameter so this is testable without touching the real PATH.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PATH ?? env.Path ?? '';
  if (!raw) return null;

  // On Windows an executable is only executable if its extension is in PATHEXT; elsewhere
  // the bare name is the whole story.
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const dir of raw.split(delimiter)) {
    if (!dir || NPX_CACHE.test(dir)) continue;
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not there, or not readable. Both mean "keep looking".
      }
    }
  }
  return null;
}

export interface GuardResolution {
  /** What the hook will run. */
  command: string;
  /** The resolved binary, or null when falling back to a pinned npx. */
  binary: string | null;
  /** Hook timeout in seconds. A cold npx download needs far longer than a local binary. */
  timeout: number;
}

/** The pinned fallback. Never `@latest`: see the note at the top of this file. */
export function pinnedNpxGuard(version: string = VERSION): string {
  return `npx vibeward@${version} guard`;
}

export function resolveGuard(env: NodeJS.ProcessEnv = process.env): GuardResolution {
  const binary = findOnPath('vibeward', env);
  return binary
    ? { command: 'vibeward guard', binary, timeout: 10 }
    : { command: pinnedNpxGuard(), binary: null, timeout: 60 };
}

// ---------------------------------------------------------------------------
// The vendored copy
// ---------------------------------------------------------------------------

/**
 * Where a vendored copy lives: one directory per version, under the user's home.
 *
 * Versioned rather than a single `current.mjs` so that raising the pin is not an in-place
 * overwrite of a file some other host's hook is about to execute. Old versions are left
 * behind on purpose — a host the user did not re-select on this run still points at one, and
 * deleting it to save 300 KB would break that hook silently.
 */
export function vendorPath(home: string, version: string = VERSION): string {
  return join(home, '.vibeward', version, 'vibeward.mjs');
}

/**
 * The single-file bundle shipped beside this code — the same artifact the Claude Code plugin
 * runs. Present in the published package and after `npm run build:plugin`; absent in a source
 * checkout that has not built it, which is why every caller has to handle null.
 */
function bundledCli(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/init/binary.js and src/init/binary.ts are both two levels below the package root.
  const candidate = join(here, '..', '..', 'bin', 'vibeward.mjs');
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Copies the bundle under the user's home and returns a hook that runs it directly.
 *
 * This exists because of a measurement. With nothing recommending a global install, every
 * hook fell back to a pinned `npx`, and on the author's machine that costs 2.06s per prompt
 * with a warm cache against 0.13s for a local file — 15x, on every single thing you type.
 * The pin was right; paying npx's process overhead for it was not.
 *
 * User scope only. A project's `.claude/settings.json` gets committed, and an absolute path
 * into one developer's home directory is both a broken hook for their teammates and their
 * username published in a repository. Project scope keeps the pinned npx, which works for
 * everyone who checks the repo out without anyone having to run anything.
 *
 * Returns null on any failure — a read-only home, a partial copy, a copy that does not
 * actually run. The caller then keeps the npx pin. A hook that points at something broken is
 * worse than a slow one: it fails on every prompt, and it fails quietly.
 */
export function vendorGuard(home: string): GuardResolution | null {
  const source = bundledCli();
  if (!source) return null;

  const target = vendorPath(home);
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  } catch {
    return null;
  }

  // Proof, not assumption: run the copy and make it say its own version. This is the check
  // that stops `init` from reporting success over a hook that will never fire.
  const probe = spawnSync(process.execPath, [target, '--version'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (probe.status !== 0 || probe.stdout.trim() !== VERSION) return null;

  return { command: `node "${target}" guard`, binary: target, timeout: 10 };
}

/** `x.y.z` as a comparable tuple, or null for anything that is not a plain release version. */
function semver(raw: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isOlder(a: string, b: string): boolean {
  const [x, y] = [semver(a), semver(b)];
  if (!x || !y) return false; // a prerelease or a tag: not ours to reason about
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) return x[i]! < y[i]!;
  }
  return false;
}

/**
 * Rewrites a hook command written by an older vibeward, and only that. A command the user
 * edited by hand — a different binary, an absolute path — is theirs, and any flags they added
 * are preserved when the prefix is one we wrote.
 *
 * Three shapes get raised:
 *
 *  - `npx vibeward@latest guard` — what versions before the pin used to write.
 *  - `npx vibeward@<older> guard` — a pin this tool wrote itself.
 *  - `node "…/.vibeward/<older>/vibeward.mjs" guard` — an older vendored copy. Recognisable
 *    as ours by the whole shape, not by the fact that it is an absolute path: a path someone
 *    typed themselves stays theirs.
 *
 * The second one used to be left alone, on the reasoning that a pin was a choice: you were
 * offered the global install, and declining is what produced it. That offer is gone, so a
 * pinned npx is no longer a decision anybody made — it is the only thing `init` writes. Left
 * untouchable it would freeze every user's rules at whatever shipped the day they ran init,
 * which is precisely the rot the guard's own staleness notice exists to complain about.
 * Raising it on re-run is what makes `npx vibeward@latest init` a real update path.
 *
 * Only ever upward. Running an older `init` must not drag a newer hook back down.
 */
export function upgradeGuardCommand(current: string, next: string): string | null {
  const shapes: { pattern: RegExp; version: (m: RegExpExecArray) => string }[] = [
    { pattern: /^npx\s+vibeward@([^\s]+)\s+guard\b/, version: (m) => m[1]! },
    {
      pattern: /^node\s+"?[^"]*[\\/]\.vibeward[\\/]([^\\/"]+)[\\/]vibeward\.mjs"?\s+guard\b/,
      version: (m) => m[1]!,
    },
  ];

  for (const shape of shapes) {
    const match = shape.pattern.exec(current);
    if (!match) continue;
    const found = shape.version(match);
    if (found !== 'latest' && !isOlder(found, VERSION)) return null;
    const upgraded = current.replace(shape.pattern, next);
    return upgraded === current ? null : upgraded;
  }
  return null;
}
