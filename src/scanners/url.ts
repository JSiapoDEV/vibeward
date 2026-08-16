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
import type { FirebaseConfig } from '../checks/firebase.js';
import { finish, loadSupabaseExport } from '../reporters/output.js';
import { applySuppressions, loadConfig, notApplicableChecks } from '../core/config.js';
import { C, confirm, log, write, normalizeUrl } from '../core/terminal.js';
import { coverage } from '../core/i18n.js';
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
  const scanned: CoverageLine[] = [];

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
      // Recorded, not silently dropped: a report that omitted this would read as "the
      // backend was checked and was fine".
      scanned.push(
        coverage(
          `Backend probes declined at the prompt — ${service} was detected but never tested`,
          `Sondas al backend rechazadas en el prompt — se detectó ${service} pero no se probó`,
        ),
      );
    }
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
  scanned.push(
    coverage(
      'HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)',
      'Cabeceras de seguridad HTTP (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)',
    ),
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
  scanned.push(
    coverage(
      'HTTP→HTTPS redirect (whether the site answers on plain http://)',
      'Redirección HTTP→HTTPS (si el sitio responde en http:// plano)',
    ),
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
  scanned.push(
    coverage(
      `Exposed secrets/credentials in ${scannedBundles.size} JavaScript bundle(s)`,
      `Secretos y credenciales expuestos en ${scannedBundles.size} bundle(s) de JavaScript`,
    ),
  );
  scanned.push(
    coverage(
      'Exposed source maps (original source code downloadable from the URL)',
      'Source maps expuestos (código fuente original descargable desde la URL)',
    ),
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
    scanned.push(
      coverage(
        `Website quality & AI visibility across ${crawl.pages.length} page(s) — metadata, headings, ` +
          `structured data, robots.txt/llms.txt/sitemap, 404 page, broken assets, JS weight`,
        `Calidad del sitio y visibilidad ante las IA en ${crawl.pages.length} página(s) — metadatos, ` +
          `encabezados, datos estructurados, robots.txt/llms.txt/sitemap, página 404, recursos rotos, peso del JS`,
      ),
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

  let rls: RlsResult | null = null;
  if (
    doActive &&
    !args.noRls &&
    supabaseCfg?.projectUrl &&
    supabaseCfg.anonKey &&
    (await confirmProbe('Supabase', `${supabaseCfg.projectUrl}/rest/v1/`))
  ) {
    write(`${C.gray}▸ Enumerating tables & probing Row Level Security…${C.reset}`);
    rls = await probeRLS(supabaseCfg.projectUrl, supabaseCfg.anonKey, {
      writeTest: args.writeTest,
    });
    log(` ${C.green}done${C.reset} (${rls.enumerated} enumerated, ${rls.probed} probed)`);
    scanned.push(
      coverage(
        `Supabase RLS — ${rls.probed} tables probed (${rls.enumerated} enumerated live)${args.writeTest ? ', write access tested' : ''}`,
        `RLS de Supabase — ${rls.probed} tablas probadas (${rls.enumerated} enumeradas en vivo)${args.writeTest ? ', acceso de escritura comprobado' : ''}`,
      ),
    );
    findings.push(...rlsFindings(rls));

    write(`${C.gray}▸ Checking GraphQL introspection…${C.reset}`);
    const gql = await checkGraphqlIntrospection(supabaseCfg.projectUrl, supabaseCfg.anonKey);
    log(` ${C.green}done${C.reset}`);
    scanned.push(
      coverage(
        'Supabase GraphQL introspection exposure',
        'Exposición de la introspección GraphQL de Supabase',
      ),
    );
    if (gql) findings.push(gql);
  } else if (doActive && !args.noRls && !supabaseCfg?.anonKey) {
    // Only when there genuinely was no key. Saying it after a declined prompt would report
    // "nothing to probe" for a backend the operator chose not to touch.
    log(`${C.gray}▸ No Supabase key detected. Skipping RLS/GraphQL probe.${C.reset}`);
  }

  if (doActive && firebaseCfg && (await confirmProbe('Firebase', firebaseTarget(firebaseCfg)))) {
    log(`${C.gray}▸ Probing Firebase RTDB & Storage…${C.reset}`);
    findings.push(...(await checkFirebase(firebaseCfg)));
    scanned.push(
      coverage(
        'Firebase Realtime Database and Storage bucket exposure',
        'Exposición de Firebase Realtime Database y del bucket de Storage',
      ),
    );
  } else if (args.passive && (firebaseCfg || supabaseCfg?.anonKey)) {
    scanned.push(
      coverage(
        'Detected a Supabase/Firebase config (not probed — passive mode)',
        'Se detectó una configuración de Supabase/Firebase (no se probó — modo pasivo)',
      ),
    );
  }

  if (args.supabaseJson) {
    findings.push(...loadSupabaseExport(args.supabaseJson));
    scanned.push(
      coverage(
        'Live Supabase audit export (--supabase)',
        'Export de auditoría de Supabase (--supabase)',
      ),
    );
  }

  finish(
    target,
    findings,
    rls,
    scanned,
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
