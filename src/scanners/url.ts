import { fetchText } from '../http/client.js';
import { discoverScripts, discoverChunksFromBundle } from '../http/discovery.js';
import { crawlSite } from '../http/crawl.js';
import { scanText, extractSupabaseConfig } from '../checks/secrets.js';
import { checkSourceMap } from '../checks/sourcemaps.js';
import { checkHeaders } from '../checks/headers.js';
import { checkWeb, parsePage, fingerprintStack } from '../checks/web.js';
import type { StackFingerprint } from '../checks/web.js';
import { readConsoleErrors } from '../checks/console.js';
import { probeRLS, rlsFindings, checkGraphqlIntrospection } from '../checks/supabase.js';
import type { RlsResult } from '../checks/supabase.js';
import { extractFirebaseConfig, checkFirebase } from '../checks/firebase.js';
import type { FirebaseConfig } from '../checks/firebase.js';
import { finish, loadSupabaseExport } from '../reporters/output.js';
import { applySuppressions, loadConfig, notApplicableChecks } from '../core/config.js';
import { C, confirm, log, write, normalizeUrl } from '../core/terminal.js';
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
  } else {
    log(`\n${C.yellow}${C.bold}⚠  AUTHORIZED USE ONLY${C.reset}`);
    log(`${C.dim}About to actively probe:${C.reset} ${C.cyan}${target}${C.reset}`);
    log(
      `${C.dim}Only do this if the owner authorized you to audit this app. (Use --passive to read only public assets.)${C.reset}`,
    );
    if (args.writeTest) {
      log(
        `${C.yellow}--write-test: a non-mutating write probe (empty insert) will run on exposed tables.${C.reset}`,
      );
    }
    log('');
    if (!args.yes) {
      if (!(await confirm(`Do you confirm you have authorization? (y/n) `))) {
        log(`${C.red}Cancelled.${C.reset}`);
        process.exit(1);
      }
      log('');
    }
  }

  const findings: Finding[] = [];
  const scanned: string[] = [];

  write(`${C.gray}▸ Fetching main page…${C.reset}`);
  const mainPage = await fetchText(target);
  if (!mainPage.ok) {
    log(
      `\n${C.red}Could not reach ${target} (status ${mainPage.status}${mainPage.error ? `: ${mainPage.error}` : ''}).${C.reset}`,
    );
    process.exit(1);
  }
  log(` ${C.green}ok${C.reset} (${mainPage.status})`);
  scanned.push('HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)');
  findings.push(...checkHeaders(mainPage.headers));

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
  scanned.push(`Exposed secrets/credentials in ${scannedBundles.size} JavaScript bundle(s)`);
  scanned.push('Exposed source maps (original source code downloadable from the URL)');

  // Website quality, AI visibility and the vibe-coded fingerprint. These are public GETs —
  // exactly what a browser does — so they run in passive mode too. They never gate the exit
  // code; they live in their own report section.
  let fingerprint: StackFingerprint | null = null;
  let consoleChecked: boolean | undefined;
  let suppressed: SuppressedFinding[] = [];
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
    const split = applySuppressions(web, cfg);
    suppressed = split.suppressed;
    findings.push(...split.kept);
    if (suppressed.length > 0) {
      log(
        `${C.yellow}▸ ${suppressed.length} website finding(s) suppressed by vibeward.json${C.reset}`,
      );
    }
    scanned.push(
      `Website quality & AI visibility across ${crawl.pages.length} page(s) — metadata, headings, ` +
        `structured data, robots.txt/llms.txt/sitemap, 404 page, broken assets, JS weight`,
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
  if (doActive && !args.noRls && supabaseCfg?.projectUrl && supabaseCfg.anonKey) {
    log(`${C.gray}▸ Supabase detected: ${supabaseCfg.projectUrl}${C.reset}`);
    write(`${C.gray}▸ Enumerating tables & probing Row Level Security…${C.reset}`);
    rls = await probeRLS(supabaseCfg.projectUrl, supabaseCfg.anonKey, {
      writeTest: args.writeTest,
    });
    log(` ${C.green}done${C.reset} (${rls.enumerated} enumerated, ${rls.probed} probed)`);
    scanned.push(
      `Supabase RLS — ${rls.probed} tables probed (${rls.enumerated} enumerated live)${args.writeTest ? ', write access tested' : ''}`,
    );
    findings.push(...rlsFindings(rls));

    write(`${C.gray}▸ Checking GraphQL introspection…${C.reset}`);
    const gql = await checkGraphqlIntrospection(supabaseCfg.projectUrl, supabaseCfg.anonKey);
    log(` ${C.green}done${C.reset}`);
    scanned.push('Supabase GraphQL introspection exposure');
    if (gql) findings.push(gql);
  } else if (doActive && !args.noRls) {
    log(`${C.gray}▸ No Supabase key detected. Skipping RLS/GraphQL probe.${C.reset}`);
  }

  if (doActive && firebaseCfg) {
    log(`${C.gray}▸ Firebase detected — probing RTDB & Storage…${C.reset}`);
    findings.push(...(await checkFirebase(firebaseCfg)));
    scanned.push('Firebase Realtime Database and Storage bucket exposure');
  } else if (args.passive && (firebaseCfg || supabaseCfg?.anonKey)) {
    scanned.push('Detected a Supabase/Firebase config (not probed — passive mode)');
  }

  if (args.supabaseJson) {
    findings.push(...loadSupabaseExport(args.supabaseJson));
    scanned.push('Live Supabase audit export (--supabase)');
  }

  finish(target, findings, rls, scanned, args, {
    fingerprint,
    consoleChecked,
    suppressed,
    notApplicable: loaded ? notApplicableChecks(loaded.config) : undefined,
    configPath: loaded?.path ?? null,
  });
}
