import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename, sep } from 'node:path';
import { scanSource } from '../checks/secrets.js';
import { scanBackendFile } from '../checks/backend.js';
import { checkUploadValidation } from '../checks/uploads.js';
import { analyzeMigrations } from '../checks/migrations.js';
import { finish, loadSupabaseExport } from '../reporters/output.js';
import { C, log } from '../core/terminal.js';
import { AREA, ledger } from '../core/coverage.js';
import type { CoverageEntry } from '../core/coverage.js';
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
    const upload = checkUploadValidation(rel, content);
    if (upload) findings.push(upload);

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

/**
 * What a folder scan looked at, decided from the tree it actually walked.
 *
 * Pure and separate from `runFolderScan` so the decisions can be asserted: which of these
 * rows is a `checked` and which is a `not_evaluated` is the whole difference between a report
 * that means something and one that only looks like it does.
 */
export function folderCoverage(input: {
  dir: string;
  filesScanned: number;
  migrations: number;
  supabaseContext: boolean;
  supabaseExport: boolean;
}): CoverageEntry[] {
  const { dir, filesScanned, migrations, supabaseContext, supabaseExport } = input;
  const cov = ledger();
  cov.checked(
    AREA.sourceSecrets,
    `Secrets and committed environment files across ${filesScanned} source file(s) in ${dir}`,
    `Secretos y ficheros de entorno commiteados en ${filesScanned} fichero(s) fuente de ${dir}`,
  );
  cov.checked(
    AREA.backendAuthz,
    'Next.js security headers, server-action authorization and formula injection in the same files',
    'Cabeceras de seguridad de Next.js, autorización en server actions e inyección de fórmulas en esos mismos ficheros',
  );
  cov.checked(
    AREA.uploadValidation,
    'File-upload handlers whose type check reads only the extension, the `accept` attribute or the declared MIME type, never the content',
    'Manejadores de subida de archivos cuya comprobación de tipo solo lee la extensión, el atributo `accept` o el tipo MIME declarado, nunca el contenido',
  );

  if (migrations > 0) {
    cov.checked(
      AREA.sqlMigrations,
      `Supabase/SQL migrations in ${migrations} file(s) (RLS, permissive policies, SECURITY DEFINER, anon grants)`,
      `Migraciones de Supabase/SQL en ${migrations} fichero(s) (RLS, políticas permisivas, SECURITY DEFINER, permisos a anon)`,
    );
  } else if (supabaseContext) {
    // The loudest silence this scanner had. A Supabase project whose schema is managed in the
    // dashboard, or whose migrations live in another repository, has no .sql here — so every
    // RLS rule finds nothing and the report comes back clean on the exact surface that
    // CVE-2025-48757 is about. Nothing was checked; that has to be what it says.
    cov.notEvaluated(
      AREA.sqlMigrations,
      'this looks like a Supabase project but no .sql migration files were found — RLS, policies and SECURITY DEFINER were never examined. Schema managed in the dashboard is invisible here; scan the live URL, or export it with `vibeward supabase-sql`',
      'esto parece un proyecto de Supabase pero no se encontró ningún fichero de migración .sql — RLS, políticas y SECURITY DEFINER no se examinaron. Un esquema gestionado desde el panel es invisible aquí; escanea la URL en vivo, o expórtalo con `vibeward supabase-sql`',
    );
  } else {
    cov.notApplicable(
      AREA.sqlMigrations,
      'no .sql files in the tree and nothing identifying this as a Supabase project',
      'no hay ficheros .sql en el árbol ni nada que identifique esto como un proyecto de Supabase',
    );
  }

  if (supabaseExport) {
    cov.checked(
      AREA.supabaseExport,
      'Live Supabase audit export (--supabase)',
      'Export de auditoría de Supabase (--supabase)',
    );
  }

  // A folder scan touches no network and no live data at all, whatever flags were passed. The
  // deployed app is therefore entirely outside what this run can speak to — said here rather
  // than left for the reader to infer from the absence of a database section.
  cov.notEvaluated(
    AREA.supabaseRls,
    'a folder scan reads files and never contacts the live backend — the deployed database was not probed. Scan the URL to cover it',
    'un escaneo de carpeta lee ficheros y nunca contacta con el backend en vivo — no se sondeó la base de datos desplegada. Escanea la URL para cubrirlo',
  );

  return cov.entries();
}

/** White-box: scan a local folder (code + Supabase migrations) plus an optional export. */
export function runFolderScan(dir: string, args: Args): never {
  log(`${C.gray}▸ Scanning folder ${dir}…${C.reset}`);
  const { findings, filesScanned, migrations, supabaseContext } = scanFolder(dir);
  log(
    `${C.gray}▸ ${filesScanned} file(s) scanned, ${migrations.length} SQL file(s) found${C.reset}`,
  );

  if (migrations.length) findings.push(...analyzeMigrations(migrations, { supabaseContext }));
  if (args.supabaseJson) findings.push(...loadSupabaseExport(args.supabaseJson));

  const scanned = folderCoverage({
    dir,
    filesScanned,
    migrations: migrations.length,
    supabaseContext,
    supabaseExport: Boolean(args.supabaseJson),
  });

  finish(dir, findings, null, scanned, { ...args, active: false });
}
