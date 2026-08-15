// Where the guard hook's command comes from.
//
// The hook runs on every prompt the user types, which makes it the one place `npx
// vibeward@latest` is the wrong default: it adds a registry round-trip per prompt, fails
// with no network, and — the part that matters for a security tool — executes whatever was
// published most recently, on every user's machine, with nobody reviewing it. An installed
// binary is a version the user chose. So `init` writes the binary when it can find one, and
// degrades to a *pinned* npx when it cannot. `@latest` never reaches a settings.json.
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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

/**
 * Rewrites a hook command written by an older vibeward, and only that. A command the user
 * edited by hand — extra flags, a different binary, an absolute path — is theirs, and the
 * flags are preserved when the prefix is the one we used to write.
 */
export function upgradeGuardCommand(current: string, next: string): string | null {
  const legacy = /^npx\s+vibeward@latest\s+guard\b/;
  if (!legacy.test(current)) return null;
  const upgraded = current.replace(legacy, next);
  return upgraded === current ? null : upgraded;
}
