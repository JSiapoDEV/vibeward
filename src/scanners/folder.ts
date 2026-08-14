import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename, sep } from 'node:path';
import { scanSource } from '../checks/secrets.js';
import { scanBackendFile } from '../checks/backend.js';
import { analyzeMigrations } from '../checks/migrations.js';
import { finish, loadSupabaseExport } from '../reporters/output.js';
import { C, log } from '../core/terminal.js';
import type { Args } from '../core/args.js';
import type { Finding } from '../core/types.js';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'out',
  'coverage',
  '.vercel',
  '.turbo',
  '.cache',
  'vendor',
  '.svelte-kit',
]);
const SCAN_EXT = new Set([
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.json',
  '.py',
  '.rb',
  '.go',
  '.php',
  '.java',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
]);
const SCAN_FILE = new Set(['Dockerfile', 'dockerfile', 'Procfile']);
const MAX_FILE = 2_000_000; // skip files larger than 2 MB
const ENV_SAFE = /\.env\.(example|sample|template)$/i;

export interface FolderScan {
  findings: Finding[];
  filesScanned: number;
  migrations: { path: string; content: string }[];
  /** Whether the project looks like a Supabase (direct-to-DB) app vs a server+ORM app. */
  supabaseContext: boolean;
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!IGNORE_DIRS.has(name)) out.push(...collectFiles(full));
    } else if (st.size <= MAX_FILE) {
      out.push(full);
    }
  }
  return out;
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function scanFolder(root: string): FolderScan {
  const findings: Finding[] = [];
  const migrations: { path: string; content: string }[] = [];
  let filesScanned = 0;
  let supabaseContext = false;

  for (const file of collectFiles(root)) {
    const rel = relative(root, file);
    const base = basename(file);
    const ext = extname(file);

    if (rel.includes(`supabase${sep}`)) supabaseContext = true;

    if (ext === '.sql') {
      const content = read(file);
      if (content) migrations.push({ path: rel, content });
      continue;
    }

    const isEnv = base === '.env' || (base.startsWith('.env') && !ENV_SAFE.test(base));
    if (!SCAN_EXT.has(ext) && !SCAN_FILE.has(base) && !isEnv) continue;

    const content = read(file);
    if (content === null) continue;
    filesScanned++;

    if (
      (base === 'package.json' && content.includes('@supabase')) ||
      content.includes('.supabase.co')
    ) {
      supabaseContext = true;
    }

    findings.push(...scanSource(content, rel));
    findings.push(...scanBackendFile(rel, content));

    if (isEnv) {
      findings.push({
        id: 'committed_env_file',
        label: `Environment file '${rel}' is in the codebase`,
        severity: 'high',
        check: 3,
        cwe: 'CWE-540',
        source: rel,
        evidence: 'A .env file was found in the project tree',
        exploit:
          'If this file is committed to the repo (or shipped in a build), anyone with repo/bundle access reads every secret in it.',
        why: 'Secrets belong in the host environment, not in a file in the codebase. Confirm it is git-ignored and not bundled.',
        references: ['https://cwe.mitre.org/data/definitions/540.html'],
      });
    }
  }

  return { findings, filesScanned, migrations, supabaseContext };
}

/** White-box: scan a local folder (code + Supabase migrations) plus an optional export. */
export function runFolderScan(dir: string, args: Args): never {
  log(`${C.gray}▸ Scanning folder ${dir}…${C.reset}`);
  const { findings, filesScanned, migrations, supabaseContext } = scanFolder(dir);
  log(
    `${C.gray}▸ ${filesScanned} file(s) scanned, ${migrations.length} SQL file(s) found${C.reset}`,
  );
  const scanned = [
    `Source files in ${dir} (secrets, committed .env, Next.js headers, server-action auth, formula injection)`,
  ];

  if (migrations.length) {
    findings.push(...analyzeMigrations(migrations, { supabaseContext }));
    scanned.push(
      `Supabase/SQL migrations (RLS, permissive policies, SECURITY DEFINER, anon grants)`,
    );
  }
  if (args.supabaseJson) {
    findings.push(...loadSupabaseExport(args.supabaseJson));
    scanned.push('Live Supabase audit export (--supabase)');
  }

  finish(dir, findings, null, scanned, args);
}
