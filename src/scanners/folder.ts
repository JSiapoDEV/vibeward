import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname, basename, sep } from 'node:path';
import {
  asBrowserBound,
  asLocalOnly,
  BROWSER_ENV_PREFIX,
  mergeRepeatedSecrets,
  scanSource,
} from '../checks/secrets.js';
import { scanBackendFile } from '../checks/backend.js';
import { checkUploadValidation } from '../checks/uploads.js';
import { analyzeMigrations } from '../checks/migrations.js';
import { finish, loadSupabaseExport } from '../reporters/output.js';
import { C, log } from '../core/terminal.js';
import { AREA, ledger } from '../core/coverage.js';
import { coverage } from '../core/i18n.js';
import { VERSION } from '../core/version.js';
import { isOlder } from '../init/binary.js';
import { HISTORY_MAX_COMMITS, onlyDeleted, scanHistory } from './history.js';
import {
  buildPending,
  builderFromFile,
  collectSignals,
  emptySignals,
  type ReviewSignals,
} from '../core/pending.js';
import type { CoverageEntry } from '../core/coverage.js';
import type { Args } from '../core/args.js';
import type { Finding } from '../core/types.js';

const IGNORE_DIRS = new Set([
  // vibeward's own reports: rescanning one would count masked evidence as new findings.
  '.vibeward',
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
  // GoogleService-Info.plist carries the iOS app's Firebase key; it was the one key in a real
  // repository that no scan ever read.
  '.plist',
  // Mobile code. Flutter's generated firebase_options.dart carries the keys for every
  // platform, and in a real app the web one existed nowhere else — so it was never seen.
  '.dart',
  '.kt',
  '.kts',
  '.swift',
  '.gradle',
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
  /** What the pending review items are about: HTML sinks, server entry points, the builder. */
  signals: ReviewSignals;
}

/**
 * What git knows about the folder, when it is a repository.
 *
 * A folder scan used to read everything on disk, so it reported what git never sees: the
 * Firebase sample projects inside Flutter's downloaded plugins, build output, a vendored SDK.
 * Keys in there are somebody else's, and a report that leads with them is not about this repo.
 * Inside a repository the scan now reads what git would — tracked files and untracked ones it
 * does not ignore — plus ignored `.env` files, which are judged as local rather than leaked.
 */
export interface GitView {
  /** Ignored, untracked paths relative to the root, `/`-separated; folders end with `/`. */
  ignored: Set<string>;
  /** Whether any commit, on any branch, ever touched `rel`. */
  everCommitted(rel: string): boolean;
}

export function gitView(root: string): GitView | null {
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  const inside = git('rev-parse', '--is-inside-work-tree');
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  const listed = git(
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  );
  if (listed.status !== 0) return null;
  return {
    ignored: new Set(listed.stdout.split('\0').filter(Boolean)),
    everCommitted(rel: string): boolean {
      const log = git('log', '--all', '--format=%h', '-1', '--', rel);
      return log.status === 0 && log.stdout.trim() !== '';
    },
  };
}

/** Test code, in the conventions of the languages scanned. */
const TEST_PATH =
  /(^|\/)(?:test|tests|__tests__|spec|specs|fixtures?|e2e|__mocks__|mocks?)\/|\.(?:test|spec)\.[a-z]+$|_test\.(?:dart|go|py)$|Tests?\.(?:kt|swift|java)$/;

/** A real `.env`, as opposed to the committed sample of one. */
function isEnvName(base: string): boolean {
  return base === '.env' || (base.startsWith('.env') && !ENV_SAFE.test(base));
}

interface Collected {
  full: string;
  /** Git ignores it; only ever true for `.env` files, the one ignored kind still read. */
  ignored: boolean;
}

function collectFiles(dir: string, root: string, view: GitView | null): Collected[] {
  const out: Collected[] = [];
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
      // lstat, not stat: a symlink is not followed. Flutter's `.symlinks` point into the
      // package cache, and a link can just as easily point at the home folder or at itself.
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const rel = relative(root, full).split(sep).join('/');
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(name) || view?.ignored.has(`${rel}/`)) continue;
      out.push(...collectFiles(full, root, view));
    } else if (st.size <= MAX_FILE) {
      const ignored = view?.ignored.has(rel) ?? false;
      if (ignored && !isEnvName(name)) continue;
      out.push({ full, ignored });
    }
  }
  return out;
}

/** A report an older vibeward wrote beside the code, before reports went to `.vibeward/`. */
const OLD_REPORT_NAME = /^(?:vibeward-report|vibeward-code-report|informe)-?.*\.md$/i;
const REPORT_FOOTER = /_(?:Generated with|Generado con) vibeward v\d/;

/** Where editors keep their hook settings — the only files whose pinned version runs. */
const HOOK_FILE =
  /(^|\/)\.(?:claude|codex|cursor|windsurf|opencode|gemini|codeium)\/|(^|\/)\.github\/hooks\//;

/** A hook that pins the guard to a version: `npx vibeward@0.8.0 guard`, or a local copy. */
const PINNED_GUARD =
  /vibeward@(\d+\.\d+\.\d+)\s+guard|\.vibeward[\\/](\d+\.\d+\.\d+)[\\/]vibeward\.mjs/g;

function leftoverReport(rel: string): Finding {
  return {
    id: `vibeward_report_in_tree_${rel.replace(/[^A-Za-z0-9]/g, '_')}`,
    label: `A vibeward report sits in the project where git can commit it: ${rel}`,
    severity: 'low',
    check: 3,
    cwe: 'CWE-538',
    source: rel,
    evidence: 'A report from an earlier vibeward, outside .vibeward/ and not ignored by git',
    exploit:
      'A report names where the app is exposed — the file and line of each key, with its first and last characters. Committed to a public repository, it is a map.',
    why: 'Delete it, or move it into .vibeward/reports/, which git ignores. Current versions write there.',
    references: ['https://cwe.mitre.org/data/definitions/538.html'],
    es: {
      label: `Hay un informe de vibeward en el proyecto, donde git puede commitearlo: ${rel}`,
      evidence: 'Un informe de una versión anterior de vibeward, fuera de .vibeward/ y sin ignorar',
      exploit:
        'Un informe dice dónde está expuesta la app: archivo y línea de cada clave, con sus primeros y últimos caracteres. Subido a un repositorio público, es un mapa.',
      why: 'Bórralo, o muévelo a .vibeward/reports/, que git ignora. Las versiones actuales escriben ahí.',
    },
  };
}

/** One finding for every hook file still on an older guard: one problem, one re-run fixes it. */
function outdatedGuard(files: { rel: string; version: string }[]): Finding {
  const version = files[0]!.version;
  const rel = files[0]!.rel;
  const others = files.slice(1).map((f) => f.rel);
  const also = others.length > 0 ? ` — also ${others.join(', ')}` : '';
  const alsoEs = others.length > 0 ? ` — también ${others.join(', ')}` : '';
  return {
    id: 'vibeward_guard_outdated',
    label: `Editor hooks run an older vibeward guard (${version}) in ${files.length} file(s)`,
    severity: 'low',
    check: 3,
    cwe: 'CWE-1104',
    source: rel,
    evidence: `Pinned to vibeward ${version}; this is ${VERSION}${also}`,
    exploit:
      'The guard on every prompt and every edit is running rules this version has since corrected — false alarms included.',
    why: 'Re-run `npx vibeward@latest init` to raise the pin; it rewrites the hook in place and keeps your flags.',
    references: ['https://cwe.mitre.org/data/definitions/1104.html'],
    es: {
      label: `Los hooks del editor corren un guardián de vibeward antiguo (${version}) en ${files.length} archivo(s)`,
      evidence: `Fijado a vibeward ${version}; esta es la ${VERSION}${alsoEs}`,
      exploit:
        'El guardián de cada prompt y cada edición corre reglas que esta versión ya corrigió, falsas alarmas incluidas.',
      why: 'Vuelve a ejecutar `npx vibeward@latest init` para subir la versión; reescribe el hook en su sitio y conserva tus opciones.',
    },
  };
}

/** Files that set security headers outside the framework: a proxy or a host config. */
const HEADER_CONFIG = /\.conf$|^_headers$|^Caddyfile$|^\.htaccess$|^vercel\.json$|^netlify\.toml$/i;
const SECURITY_HEADER =
  /content-security-policy|strict-transport-security|x-frame-options|x-content-type-options/i;

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function scanFolder(root: string, view: GitView | null = gitView(root)): FolderScan {
  const findings: Finding[] = [];
  const migrations: { path: string; content: string }[] = [];
  let filesScanned = 0;
  let supabaseContext = false;
  let headersElsewhere = false;
  const outdated: { rel: string; version: string }[] = [];
  const signals = emptySignals();

  for (const { full: file, ignored } of collectFiles(root, root, view)) {
    const rel = relative(root, file);
    const base = basename(file);
    const ext = extname(file);

    if (rel.includes(`supabase${sep}`)) supabaseContext = true;
    // Before the extension filter: `.replit` and `.bolt/` hold files no scanner reads.
    signals.builder ??= builderFromFile(rel, base === 'package.json' ? read(file) : null);

    if (ext === '.sql') {
      const content = read(file);
      if (content) migrations.push({ path: rel, content });
      continue;
    }

    const isEnv = isEnvName(base);
    if (OLD_REPORT_NAME.test(base) && !ignored) {
      const content = read(file);
      if (content && REPORT_FOOTER.test(content)) findings.push(leftoverReport(rel));
    }
    if (HEADER_CONFIG.test(base)) {
      const content = read(file);
      if (content && SECURITY_HEADER.test(content)) headersElsewhere = true;
    }
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

    // An ignored `.env` that no commit ever touched is on this machine, not in the repo.
    const localOnly = ignored && isEnv && !view?.everCommitted(rel.split(sep).join('/'));
    // In a test, `token = "…"` is a fixture: the generic rule is noise there. A vendor key in a
    // test is still a real key that leaked, so every other rule keeps reading test files.
    const secrets = scanSource(content, rel).filter(
      (f) => f.id !== 'generic_secret_assign' || !TEST_PATH.test(rel.split(sep).join('/')),
    );
    findings.push(
      ...(localOnly
        ? secrets.map((f) =>
            // Judged by the line it sits on: a `VITE_` key is not local, it ships.
            BROWSER_ENV_PREFIX.test(
              content.split('\n')[Number(f.source?.split(':').pop()) - 1] ?? '',
            )
              ? asBrowserBound(f)
              : asLocalOnly(f),
          )
        : secrets),
    );
    findings.push(...scanBackendFile(rel, content));
    for (const m of HOOK_FILE.test(rel.split(sep).join('/'))
      ? content.matchAll(PINNED_GUARD)
      : []) {
      const pinned = m[1] ?? m[2] ?? '';
      if (pinned && isOlder(pinned, VERSION)) {
        outdated.push({ rel: rel.split(sep).join('/'), version: pinned });
        break;
      }
    }
    collectSignals(signals, rel, content);
    const upload = checkUploadValidation(rel, content);
    if (upload) findings.push(upload);

    // An ignored file is not "in the codebase" — that is what ignoring it means.
    if (isEnv && !ignored) {
      findings.push({
        id: 'committed_env_file',
        label: view
          ? `Environment file '${rel}' is not ignored by git`
          : `Environment file '${rel}' is in the codebase`,
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

  // Headers set by nginx, a host or a proxy are headers the app has; asking for them again in
  // next.config would send someone to fix what is already fixed.
  if (outdated.length > 0) findings.push(outdatedGuard(outdated));
  const kept = headersElsewhere
    ? findings.filter((f) => f.id !== 'nextjs_no_security_headers')
    : findings;
  return {
    findings: mergeRepeatedSecrets(kept),
    filesScanned,
    migrations,
    supabaseContext,
    signals,
  };
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
  const { filesScanned, migrations, supabaseContext, supabaseExport } = input;
  const cov = ledger();
  cov.checked(
    AREA.sourceSecrets,
    `Secrets and committed environment files, across ${filesScanned} project files`,
    `Secretos y archivos de entorno subidos al repositorio, en ${filesScanned} archivos del proyecto`,
  );
  cov.checked(
    AREA.backendAuthz,
    'Next.js security headers, server-action authorization and formula injection in the same files',
    'Cabeceras de seguridad de Next.js, autorización en server actions e inyección de fórmulas en esos mismos archivos',
  );
  cov.checked(
    AREA.uploadValidation,
    'File-upload handlers whose type check reads only the extension, the `accept` attribute or the declared MIME type, never the content',
    'Manejadores de subida de archivos cuya comprobación de tipo solo lee la extensión, el atributo `accept` o el tipo MIME declarado, nunca el contenido',
  );

  if (migrations > 0 && supabaseContext) {
    cov.checked(
      AREA.sqlMigrations,
      `Supabase/SQL migrations in ${migrations} file(s) (RLS, permissive policies, SECURITY DEFINER, anon grants, dynamic SQL in functions, policies that trust user_metadata, views that skip RLS)`,
      `Migraciones de Supabase/SQL en ${migrations} archivo(s) (RLS, políticas permisivas, SECURITY DEFINER, permisos a anon, SQL dinámico en funciones, políticas que confían en user_metadata, vistas que se saltan RLS)`,
    );
  } else if (migrations > 0) {
    // No Supabase here, so the RLS rules have nothing to say and naming them would suggest the
    // project was judged on a model it does not use.
    cov.checked(
      AREA.sqlMigrations,
      `SQL in ${migrations} file(s) (SECURITY DEFINER and dynamic SQL in functions, grants)`,
      `SQL en ${migrations} archivo(s) (SECURITY DEFINER y SQL dinámico en funciones, permisos)`,
    );
  } else if (supabaseContext) {
    // The loudest silence this scanner had. A Supabase project whose schema is managed in the
    // dashboard, or whose migrations live in another repository, has no .sql here — so every
    // RLS rule finds nothing and the report comes back clean on the exact surface that
    // CVE-2025-48757 is about. Nothing was checked; that has to be what it says.
    cov.notEvaluated(
      AREA.sqlMigrations,
      'this looks like a Supabase project but no .sql migration files were found — RLS, policies and SECURITY DEFINER were never examined. Schema managed in the dashboard is invisible here; scan the live URL, or export it with `vibeward supabase-sql`',
      'esto parece un proyecto de Supabase pero no se encontró ningún archivo de migración .sql — RLS, políticas y SECURITY DEFINER no se examinaron. Un esquema gestionado desde el panel es invisible aquí; escanea la URL en vivo, o expórtalo con `vibeward supabase-sql`',
    );
  } else {
    cov.notApplicable(
      AREA.sqlMigrations,
      'no .sql files in the tree and nothing identifying this as a Supabase project',
      'no hay archivos .sql en el árbol ni nada que identifique esto como un proyecto de Supabase',
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
    'The live database was not checked: a folder scan only reads files. Scan the URL to cover it',
    'No se revisó la base de datos en producción: un escaneo de carpeta solo lee archivos. Escanea la URL para cubrirlo',
  );

  return cov.entries();
}

function entry(id: string, status: CoverageEntry['status'], en: string, es: string): CoverageEntry {
  return { id, status, detail: coverage(en, es) };
}

/** White-box: scan a local folder (code + Supabase migrations) plus an optional export. */
export function runFolderScan(dir: string, args: Args): never {
  log(`${C.gray}▸ Scanning folder ${dir}…${C.reset}`);
  const { findings, filesScanned, migrations, supabaseContext, signals } = scanFolder(dir);
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

  // The history is read only when asked: on a large repository it is the slow part, and it
  // reads every branch rather than the folder in front of the person.
  if (args.history) {
    log(`${C.gray}▸ Reading the git history…${C.reset}`);
    const history = scanHistory(dir);
    if (!history) {
      scanned.push(
        entry(
          AREA.gitHistory,
          'not_applicable',
          'not a git repository',
          'no es un repositorio de git',
        ),
      );
    } else {
      const deleted = onlyDeleted(history.findings, findings);
      findings.push(...deleted);
      log(`${C.gray}▸ ${history.commits} commit(s) read${C.reset}`);
      if (history.shallow) {
        scanned.push(
          entry(
            AREA.gitHistory,
            'not_evaluated',
            `a shallow clone: only ${history.commits} commit(s) are on this machine. In GitHub Actions, check out with fetch-depth: 0`,
            `un clon superficial: en esta máquina solo hay ${history.commits} commit(s). En GitHub Actions, haz el checkout con fetch-depth: 0`,
          ),
        );
      } else {
        scanned.push(
          entry(
            AREA.gitHistory,
            'checked',
            // Said with its result, so "searched" cannot be read as "found". The count is of
            // commits with changes of their own — a merge adds none — so it can sit below
            // `git rev-list --all --count`.
            `Keys that were added and later deleted, searched in ${history.commits} commit(s) with changes across every branch and tag (merges add none of their own): ${deleted.length === 0 ? 'none' : `${deleted.length} found`}`,
            `Claves que se agregaron y luego se borraron, buscadas en ${history.commits} commit(s) con cambios de todas las ramas y tags (los merges no agregan nada propio): ${deleted.length === 0 ? 'ninguna' : `${deleted.length} encontrada(s)`}`,
          ),
        );
        if (history.capped) {
          scanned.push(
            entry(
              AREA.gitHistory,
              'not_evaluated',
              `commits older than the newest ${HISTORY_MAX_COMMITS} were not read`,
              `no se leyeron los commits anteriores a los ${HISTORY_MAX_COMMITS} más recientes`,
            ),
          );
        }
      }
    }
  } else if (gitView(dir)) {
    scanned.push(
      entry(
        AREA.gitHistory,
        'not_evaluated',
        'the git history was not read: a key deleted from the code is still in the commit that added it. Run with --history to cover it',
        'no se leyó el historial de git: una clave borrada del código sigue en el commit que la agregó. Ejecútalo con --history para cubrirlo',
      ),
    );
  }

  const pending = buildPending({
    scanned,
    signals,
    ignoreUnchecked: supabaseContext ? [] : [AREA.supabaseRls],
  });

  finish(dir, findings, null, scanned, { ...args, active: false, folder: true }, { pending });
}
