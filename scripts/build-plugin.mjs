// Regenerates every file the Claude Code plugin ships, from the sources that already own them.
//
// The plugin carries its own copy of the CLI on purpose. Claude Code can install a plugin's npm
// dependencies for you, but when that install fails the plugin still loads — and a guard that
// loads without running is the one failure this project refuses to ship: it installs cleanly, it
// runs nothing, and the user believes they are covered. vibeward has no runtime dependencies, so
// a single bundled file is a complete, offline, pinned copy with nothing left to resolve at the
// moment the user types a prompt.
//
// Nothing here is authored by hand. SKILL.md comes from templates.ts, the version comes from
// package.json, and the bundle comes from the build. CI runs this and fails on any diff, so a
// plugin that has drifted from the source cannot reach a user.
import { build } from 'esbuild';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/** Writes only when the bytes change, so a no-op run leaves mtimes alone. */
function writeFile(relative, contents) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // Not there yet — first run.
  }
  if (current === contents) return false;
  writeFileSync(path, contents);
  return true;
}

const { version } = JSON.parse(read('package.json'));

// 1. The CLI, as one self-contained ESM file. Not minified: a security tool asks people to trust
//    a committed artifact, and an unreadable one is a worse ask than a large one. `playwright` is
//    an optional peer loaded through a variable specifier, so it stays external either way.
await build({
  entryPoints: [join(root, 'dist/cli.js')],
  outfile: join(root, 'bin/vibeward.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['playwright'],
  legalComments: 'inline',
});
chmodSync(join(root, 'bin/vibeward.mjs'), 0o755);

// 2. A POSIX shim, because `bin/` is added to the Bash tool's PATH while the plugin is enabled —
//    so the agent can run `vibeward <url>` directly, at the same pinned version as the hook.
const shim = ['#!/bin/sh', 'exec node "$(dirname "$0")/vibeward.mjs" "$@"', ''].join('\n');
writeFile('bin/vibeward', shim);
chmodSync(join(root, 'bin/vibeward'), 0o755);

// 3. The skill, from the same template `init` writes at every host. One source, seven
//    destinations, and now an eighth.
const { skillFile } = await import(join(root, 'dist/init/templates.js'));
writeFile('skills/vibeward/SKILL.md', skillFile());

// 4. The manifest version. The marketplace entry deliberately carries no `version`: Claude Code
//    always reads plugin.json, so a second copy can only ever be the stale one.
const manifestPath = '.claude-plugin/plugin.json';
const manifest = JSON.parse(read(manifestPath));
manifest.version = version;
writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`plugin built for v${version}`);
