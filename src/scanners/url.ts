import { fetchText } from '../http/client.js';
import { discoverScripts, discoverChunksFromBundle } from '../http/discovery.js';
import { crawlSite } from '../http/crawl.js';
import { scanText, scanCrawledPages, extractSupabaseConfig } from '../checks/secrets.js';
import { checkSourceMap } from '../checks/sourcemaps.js';
import { checkHeaders } from '../checks/headers.js';
import { checkPlainHttp } from '../checks/transport.js';
import { checkWeb, parsePage, fingerprintStack, webChecksNotEvaluated } from '../checks/web.js';
import type { StackFingerprint } from '../checks/web.js';
import { readConsoleErrors } from '../checks/console.js';
import { probeRLS, rlsFindings, checkGraphqlIntrospection } from '../checks/supabase.js';
import type { RlsResult } from '../checks/supabase.js';
import { extractFirebaseConfig, checkFirebase, firebaseTarget } from '../checks/firebase.js';
import { hasFileInput } from '../checks/uploads.js';
import type { FirebaseConfig } from '../checks/firebase.js';
import { finish, loadSupabaseExport } from '../reporters/output.js';
import { applySuppressions, loadConfig, notApplicableChecks } from '../core/config.js';
import { C, confirm, log, write, normalizeUrl } from '../core/terminal.js';
import { AREA, ledger } from '../core/coverage.js';
import type { CoverageLine } from '../core/i18n.js';
import type { Args } from '../core/args.js';
import type { Finding, SuppressedFinding, SupabaseConfig } from '../core/types.js';

const MAX_BUNDLES = 40;

/** Black-box: scan a live URL from the outside. */
export async function runUrlScan(rawTarget: string, args: Args): Promise<never> {
  const target = normalizeUrl(rawTarget);

  if (args.passive) {
    log(
      `\n${C.gray}Passive scan of ${C.cyan}${target}${C.reset}${C.gray} — reading public assets only, no data access.${C.reset}\n`,
    );
  }

  const findings: Finding[] = [];
  const cov = ledger();

  /**
   * The authorization question, asked at the moment the scan stops being a browser.
   *
   * It used to be a banner at the top of the run, in front of everything. That put it in
   * front of nothing: fetching the page, its bundles, the crawl, robots.txt and the
   * plain-HTTP twin are requests a visitor's browser already makes, and on a site whose
   * bundles carry no backend config the whole scan completed without ever reaching a probe.
   * The prompt was asking permission to behave like a visitor, which taught everyone who saw
   * it to type `y` without reading — the exact opposite of what a confirmation is for.
   *
   * Below this line the scan does something a visitor never does: it enumerates tables and
   * reads rows out of somebody's data API. That is worth stopping for, and stopping here
   * means the question can name the service and the URL it is about to touch.
   *
   * Declining skips the probes and keeps the report. Everything above already ran, and
   * throwing away a finished scan would only teach the same reflex from the other side.
   */
  let probeOk: boolean | null = null;
  const confirmProbe = async (service: string, endpoint: string): Promise<boolean> => {
    if (probeOk !== null) return probeOk;

    log(`\n${C.yellow}${C.bold}⚠  ${service} detected — the next step reads live data.${C.reset}`);
    log(`${C.dim}About to probe:${C.reset} ${C.cyan}${endpoint}${C.reset}`);
    log(
      `${C.dim}Everything so far was public assets, the way a browser reads them. This is not.${C.reset}`,
    );
    if (args.writeTest) {
      log(
        `${C.yellow}--write-test: a non-mutating write probe (empty insert) will run on exposed tables.${C.reset}`,
      );
    }

    if (args.yes) {
      probeOk = true;
      log('');
      return true;
    }
    log('');
    probeOk = await confirm(`Do you have authorization to probe it? (y/n) `);
    log('');
    if (!probeOk) {
      log(`${C.yellow}Skipping the backend probes. The rest of the report stands.${C.reset}`);
    }
    // The decline is recorded by the caller, against the areas it actually cost. Recording it
    // here would file one prose line for a prompt that gates two different backends.
    return probeOk;
  };

  write(`${C.gray}▸ Fetching main page…${C.reset}`);
  const mainPage = await fetchText(target);
  if (!mainPage.ok) {
    log(
      `\n${C.red}Could not reach ${target} (status ${mainPage.status}${mainPage.error ? `: ${mainPage.error}` : ''}).${C.reset}`,
    );
    process.exit(1);
  }
  log(` ${C.green}ok${C.reset} (${mainPage.status})`);
  cov.checked(
    AREA.httpHeaders,
    'HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)',
    'Cabeceras de seguridad HTTP (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)',
  );
  findings.push(...checkHeaders(mainPage.headers));

  // One GET to the plain-HTTP twin of the target — the same request a visitor makes by
  // typing the domain — so it runs in passive mode too. It reads nothing private.
  write(`${C.gray}▸ Checking the plain-HTTP address…${C.reset}`);
  const plainHttp = await checkPlainHttp(target);
  log(
    plainHttp
      ? ` ${C.yellow}served over HTTP${C.reset}`
      : ` ${C.green}ok${C.reset} (redirects to HTTPS or refuses)`,
  );
  cov.checked(
    AREA.transport,
    'HTTP→HTTPS redirect (whether the site answers on plain http://)',
    'Redirección HTTP→HTTPS (si el sitio responde en http:// plano)',
  );
  if (plainHttp) findings.push(plainHttp);

  const baseUrl = mainPage.finalUrl ?? target;
  const scriptUrls = discoverScripts(mainPage.body, baseUrl);
  log(`${C.gray}▸ ${scriptUrls.length} script(s) found in the HTML${C.reset}`);
  findings.push(...scanText(mainPage.body, target));

  const scannedBundles = new Set<string>();
  const chunkQueue = [...scriptUrls];
  let supabaseCfg: SupabaseConfig | null = args.supabaseUrl
    ? { projectUrl: normalizeUrl(args.supabaseUrl), anonKey: args.anonKey ?? null }
    : null;
  let firebaseCfg: FirebaseConfig | null = extractFirebaseConfig(mainPage.body);
  let fileInputSeen = hasFileInput(mainPage.body);

  let count = 0;
  let sourceMapFound = false;
  let jsBytes = 0;
  while (chunkQueue.length && count < MAX_BUNDLES) {
    const url = chunkQueue.shift()!;
    if (scannedBundles.has(url)) continue;
    scannedBundles.add(url);
    count++;

    write(`${C.gray}▸ [${count}] scanning ${url.slice(0, 70)}…${C.reset}\r`);
    const bundle = await fetchText(url);
    if (!bundle.ok || !bundle.body) continue;

    jsBytes += Buffer.byteLength(bundle.body, 'utf8');
    findings.push(...scanText(bundle.body, url));
    if (!supabaseCfg) supabaseCfg = extractSupabaseConfig(bundle.body);
    if (!firebaseCfg) firebaseCfg = extractFirebaseConfig(bundle.body);
    if (!fileInputSeen) fileInputSeen = hasFileInput(bundle.body);

    if (!sourceMapFound && count <= 12) {
      const sm = await checkSourceMap(url, bundle.body);
      if (sm) {
        findings.push(sm);
        sourceMapFound = true;
      }
    }

    if (count < 12) {
      for (const m of discoverChunksFromBundle(bundle.body, url)) {
        if (!scannedBundles.has(m)) chunkQueue.push(m);
      }
    }
  }
  write(`${' '.repeat(90)}\r`);
  log(`${C.gray}▸ ${scannedBundles.size} bundle(s) scanned${C.reset}`);
  cov.checked(
    AREA.bundleSecrets,
    `Exposed secrets/credentials in ${scannedBundles.size} JavaScript bundle(s)`,
    `Secretos y credenciales expuestos en ${scannedBundles.size} bundle(s) de JavaScript`,
  );
  // The queue stops at MAX_BUNDLES, so a large app can have code this scan never fetched.
  // Silence there would read as "no secrets in the bundles" rather than "not all of them".
  if (chunkQueue.length > 0) {
    cov.notEvaluated(
      AREA.bundleSecrets,
      `${chunkQueue.length} further bundle(s) were left unread — the scan stops at ${MAX_BUNDLES}`,
      `Quedaron ${chunkQueue.length} bundle(s) sin leer — el escaneo se detiene en ${MAX_BUNDLES}`,
    );
  }
  cov.checked(
    AREA.sourceMaps,
    'Exposed source maps (original source code downloadable from the URL)',
    'Source maps expuestos (código fuente original descargable desde la URL)',
  );

  // Website quality, AI visibility and the vibe-coded fingerprint. These are public GETs —
  // exactly what a browser does — so they run in passive mode too. They never gate the exit
  // code; they live in their own report section.
  let fingerprint: StackFingerprint | null = null;
  let consoleChecked: boolean | undefined;
  let suppressed: SuppressedFinding[] = [];
  let notEvaluated = new Map<string, CoverageLine>();
  const loaded = args.noWeb ? null : loadConfig(args.config);
  if (loaded?.path) {
    log(`${C.gray}▸ Using ${loaded.path}${C.reset}`);
    for (const w of loaded.warnings) log(`${C.yellow}  ⚠ vibeward.json: ${w}${C.reset}`);
  }

  if (!args.noWeb) {
    write(`${C.gray}▸ Crawling the site (pages, robots.txt, sitemap, llms.txt, 404)…${C.reset}`);
    const crawl = await crawlSite(baseUrl, mainPage.body);
    log(` ${C.green}done${C.reset} (${crawl.pages.length} page(s))`);

    const consoleErrors = await readConsoleErrors(baseUrl);
    consoleChecked = consoleErrors !== null;
    log(
      consoleChecked
        ? `${C.gray}▸ Browser console: ${consoleErrors!.length} error(s)${C.reset}`
        : `${C.gray}▸ Browser console skipped (Playwright not installed)${C.reset}`,
    );

    // Secrets in the inline scripts of a secondary page: the home page and the external
    // bundles are scanned above, but a crawled page was only ever mined for meta tags — so on
    // a site whose marketing lives on `/` and whose application lives on `app.html`, the code
    // went unscanned. See scanCrawledPages for the dedup semantics.
    findings.push(...scanCrawledPages(crawl.pages, [target, baseUrl], findings));
    // A secondary page can carry the backend config the home page does not — pick it up so the
    // (authorized) full scan has a target to probe.
    for (const page of crawl.pages) {
      if (!supabaseCfg) supabaseCfg = extractSupabaseConfig(page.html);
      if (!firebaseCfg) firebaseCfg = extractFirebaseConfig(page.html);
      if (!fileInputSeen) fileInputSeen = hasFileInput(page.html);
    }

    const pages = crawl.pages.map((p) => parsePage(p.html, p.url));
    fingerprint = fingerprintStack(mainPage.body, baseUrl, jsBytes, crawl.files);
    const cfg = loaded?.config ?? {};
    const web = checkWeb({
      pages,
      files: crawl.files,
      brokenAssets: crawl.brokenAssets,
      jsBytes,
      consoleErrors,
      intent: cfg.intent,
      notApplicable: notApplicableChecks(cfg),
    });
    // What this crawl had no way to judge, measured from the crawl itself: one page cannot
    // have duplicate titles, and a page with no images cannot be missing alt text.
    notEvaluated = webChecksNotEvaluated({ pages, assetsChecked: crawl.assetsChecked });
    const split = applySuppressions(web, cfg);
    suppressed = split.suppressed;
    findings.push(...split.kept);
    if (suppressed.length > 0) {
      log(
        `${C.yellow}▸ ${suppressed.length} website finding(s) suppressed by vibeward.json${C.reset}`,
      );
    }
    cov.checked(
      AREA.websiteQuality,
      `Website quality & AI visibility across ${crawl.pages.length} page(s) — metadata, headings, ` +
        `structured data, robots.txt/llms.txt/sitemap, 404 page, broken assets, JS weight`,
      `Calidad del sitio y visibilidad ante las IA en ${crawl.pages.length} página(s) — metadatos, ` +
        `encabezados, datos estructurados, robots.txt/llms.txt/sitemap, página 404, recursos rotos, peso del JS`,
    );
    cov.checked(
      AREA.pageSecrets,
      `Inline scripts of ${crawl.pages.length} crawled page(s), for secrets the home page does not carry`,
      `Scripts en línea de ${crawl.pages.length} página(s) rastreada(s), por secretos que no lleva la portada`,
    );
  } else {
    // `--no-web` turns off the crawl, and the crawl is what reaches every page past the home
    // page. Skipping the website checks is the flag's advertised effect; taking the secret
    // scan of those pages with it is not, so it is recorded rather than assumed understood.
    cov.notEvaluated(
      AREA.websiteQuality,
      '--no-web: the website quality and AI-visibility checks were not run',
      '--no-web: no se ejecutaron las comprobaciones de calidad del sitio ni de visibilidad ante las IA',
    );
    cov.notEvaluated(
      AREA.pageSecrets,
      '--no-web: no pages beyond the home page were crawled, so their inline scripts went unscanned',
      '--no-web: no se rastreó ninguna página más allá de la portada, así que sus scripts en línea quedaron sin analizar',
    );
  }

  // Active probes access the app's backend (row reads, writes, introspection). Passive
  // mode skips all of them, reading only public assets — safe without the owner's permission.
  const doActive = !args.passive;
  if (args.passive) {
    log(
      `${C.gray}▸ Passive mode: skipping RLS/GraphQL/Firebase probes (public assets only).${C.reset}`,
    );
  }

  // Every path out of here writes a row. A backend that was detected and not probed is the
  // single most consequential thing this scan can fail to say: the report that omits it is
  // the report someone reads as "my Supabase is fine".
  const supabaseSkipped = (en: string, es: string): void => {
    cov.notEvaluated(AREA.supabaseRls, en, es);
    cov.notEvaluated(AREA.supabaseGraphql, en, es);
  };

  let rls: RlsResult | null = null;
  const supabaseReady = Boolean(supabaseCfg?.projectUrl && supabaseCfg.anonKey);
  if (!supabaseReady) {
    // No backend to probe, so nothing was missed. This is the one branch that may claim
    // `not_applicable`, and only because the assets were read and carried no config.
    cov.notApplicable(
      AREA.supabaseRls,
      'no Supabase project URL and public key were found in the served assets',
      'no se encontró una URL de proyecto de Supabase con clave pública en los recursos servidos',
    );
    cov.notApplicable(
      AREA.supabaseGraphql,
      'no Supabase project URL and public key were found in the served assets',
      'no se encontró una URL de proyecto de Supabase con clave pública en los recursos servidos',
    );
    if (doActive && !args.noRls) {
      log(`${C.gray}▸ No Supabase key detected. Skipping RLS/GraphQL probe.${C.reset}`);
    }
  } else if (args.noRls) {
    supabaseSkipped(
      '--no-rls: a Supabase backend was detected and its Row-Level Security was never tested',
      '--no-rls: se detectó un backend de Supabase y nunca se comprobó su Row-Level Security',
    );
  } else if (args.passive) {
    supabaseSkipped(
      '--passive: a Supabase backend was detected and its data API was never read',
      '--passive: se detectó un backend de Supabase y nunca se leyó su API de datos',
    );
  } else if (!(await confirmProbe('Supabase', `${supabaseCfg!.projectUrl}/rest/v1/`))) {
    supabaseSkipped(
      'backend probes declined at the prompt — Supabase was detected but never tested',
      'sondas al backend rechazadas en el prompt — se detectó Supabase pero no se probó',
    );
  } else {
    write(`${C.gray}▸ Enumerating tables & probing Row Level Security…${C.reset}`);
    rls = await probeRLS(supabaseCfg!.projectUrl, supabaseCfg!.anonKey!, {
      writeTest: args.writeTest,
    });
    log(` ${C.green}done${C.reset} (${rls.enumerated} enumerated, ${rls.probed} probed)`);
    cov.checked(
      AREA.supabaseRls,
      `Supabase RLS — ${rls.probed} tables probed (${rls.enumerated} enumerated live)${args.writeTest ? ', write access tested' : ''}`,
      `RLS de Supabase — ${rls.probed} tablas probadas (${rls.enumerated} enumeradas en vivo)${args.writeTest ? ', acceso de escritura comprobado' : ''}`,
    );
    // Enumeration is best-effort: when the project does not serve a table list, the probe
    // falls back to a list of common names. Tables outside it were never asked about, and a
    // reader has to know the sweep was a guess before drawing anything from a clean result.
    if (rls.enumerated === 0) {
      cov.notEvaluated(
        AREA.supabaseRls,
        `the project did not expose a table list — only ${rls.probed} common table names were tried, so any table outside that list is untested`,
        `el proyecto no expuso una lista de tablas — solo se probaron ${rls.probed} nombres habituales, así que cualquier tabla fuera de esa lista queda sin comprobar`,
      );
    }
    findings.push(...rlsFindings(rls));

    write(`${C.gray}▸ Checking GraphQL introspection…${C.reset}`);
    const gql = await checkGraphqlIntrospection(supabaseCfg!.projectUrl, supabaseCfg!.anonKey!);
    log(` ${C.green}done${C.reset}`);
    cov.checked(
      AREA.supabaseGraphql,
      'Supabase GraphQL introspection exposure',
      'Exposición de la introspección GraphQL de Supabase',
    );
    if (gql) findings.push(gql);
  }

  if (!firebaseCfg) {
    cov.notApplicable(
      AREA.firebaseRules,
      'no Firebase configuration was found in the served assets',
      'no se encontró configuración de Firebase en los recursos servidos',
    );
  } else if (args.passive) {
    cov.notEvaluated(
      AREA.firebaseRules,
      '--passive: a Firebase backend was detected and its database and storage rules were never tested',
      '--passive: se detectó un backend de Firebase y nunca se comprobaron sus reglas de base de datos y almacenamiento',
    );
  } else if (!(await confirmProbe('Firebase', firebaseTarget(firebaseCfg)))) {
    cov.notEvaluated(
      AREA.firebaseRules,
      'backend probes declined at the prompt — Firebase was detected but never tested',
      'sondas al backend rechazadas en el prompt — se detectó Firebase pero no se probó',
    );
  } else {
    log(`${C.gray}▸ Probing Firebase RTDB & Storage…${C.reset}`);
    findings.push(...(await checkFirebase(firebaseCfg)));
    cov.checked(
      AREA.firebaseRules,
      'Firebase Realtime Database and Storage bucket exposure',
      'Exposición de Firebase Realtime Database y del bucket de Storage',
    );
  }

  // The site takes uploads, and from the outside there is no way to tell whether the server
  // reads their content or trusts the name — short of uploading a disguised file, which is an
  // attack, not a scan. Said here so a clean report is not read as "uploads are safe".
  if (fileInputSeen) {
    cov.notEvaluated(
      AREA.uploadValidation,
      'the site has a file upload input, but whether the server checks the content (magic bytes) or only the extension and declared type cannot be seen from outside. Scan the code with `vibeward scan <folder>` to cover it',
      'el sitio tiene un campo de subida de archivos, pero si el servidor comprueba el contenido (magic bytes) o solo la extensión y el tipo declarado no se puede ver desde fuera. Escanea el código con `vibeward scan <carpeta>` para cubrirlo',
    );
  }

  if (args.supabaseJson) {
    findings.push(...loadSupabaseExport(args.supabaseJson));
    cov.checked(
      AREA.supabaseExport,
      'Live Supabase audit export (--supabase)',
      'Export de auditoría de Supabase (--supabase)',
    );
  }

  finish(
    target,
    findings,
    rls,
    cov.entries(),
    { ...args, active: doActive },
    {
      fingerprint,
      consoleChecked,
      suppressed,
      notApplicable: loaded ? notApplicableChecks(loaded.config) : undefined,
      notEvaluated,
      configPath: loaded?.path ?? null,
    },
  );
}
