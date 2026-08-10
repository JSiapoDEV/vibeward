import { fetchText } from '../http/client.js';
import { discoverScripts, discoverChunksFromBundle } from '../http/discovery.js';
import { scanText, extractSupabaseConfig } from '../checks/secrets.js';
import { checkSourceMap } from '../checks/sourcemaps.js';
import { checkHeaders } from '../checks/headers.js';
import { probeRLS, rlsFindings, checkGraphqlIntrospection } from '../checks/supabase.js';
import type { RlsResult } from '../checks/supabase.js';
import { extractFirebaseConfig, checkFirebase } from '../checks/firebase.js';
import type { FirebaseConfig } from '../checks/firebase.js';
import { finish, loadSupabaseExport } from '../reporters/output.js';
import { C, confirm, normalizeUrl } from '../core/terminal.js';
import type { Args } from '../core/args.js';
import type { Finding, SupabaseConfig } from '../core/types.js';

const MAX_BUNDLES = 40;

/** Black-box: scan a live URL from the outside. */
export async function runUrlScan(rawTarget: string, args: Args): Promise<never> {
  const target = normalizeUrl(rawTarget);

  if (args.passive) {
    console.log(
      `\n${C.gray}Passive scan of ${C.cyan}${target}${C.reset}${C.gray} — reading public assets only, no data access.${C.reset}\n`,
    );
  } else {
    console.log(`\n${C.yellow}${C.bold}⚠  AUTHORIZED USE ONLY${C.reset}`);
    console.log(`${C.dim}About to actively probe:${C.reset} ${C.cyan}${target}${C.reset}`);
    console.log(
      `${C.dim}Only do this if the owner authorized you to audit this app. (Use --passive to read only public assets.)${C.reset}`,
    );
    if (args.writeTest) {
      console.log(
        `${C.yellow}--write-test: a non-mutating write probe (empty insert) will run on exposed tables.${C.reset}`,
      );
    }
    console.log('');
    if (!args.yes) {
      if (!(await confirm(`Do you confirm you have authorization? (y/n) `))) {
        console.log(`${C.red}Cancelled.${C.reset}`);
        process.exit(1);
      }
      console.log('');
    }
  }

  const findings: Finding[] = [];
  const scanned: string[] = [];

  process.stdout.write(`${C.gray}▸ Fetching main page…${C.reset}`);
  const mainPage = await fetchText(target);
  if (!mainPage.ok) {
    console.log(
      `\n${C.red}Could not reach ${target} (status ${mainPage.status}${mainPage.error ? `: ${mainPage.error}` : ''}).${C.reset}`,
    );
    process.exit(1);
  }
  console.log(` ${C.green}ok${C.reset} (${mainPage.status})`);
  scanned.push('HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)');
  findings.push(...checkHeaders(mainPage.headers));

  const baseUrl = mainPage.finalUrl ?? target;
  const scriptUrls = discoverScripts(mainPage.body, baseUrl);
  console.log(`${C.gray}▸ ${scriptUrls.length} script(s) found in the HTML${C.reset}`);
  findings.push(...scanText(mainPage.body, target));

  const scannedBundles = new Set<string>();
  const chunkQueue = [...scriptUrls];
  let supabaseCfg: SupabaseConfig | null = args.supabaseUrl
    ? { projectUrl: normalizeUrl(args.supabaseUrl), anonKey: args.anonKey ?? null }
    : null;
  let firebaseCfg: FirebaseConfig | null = extractFirebaseConfig(mainPage.body);

  let count = 0;
  let sourceMapFound = false;
  while (chunkQueue.length && count < MAX_BUNDLES) {
    const url = chunkQueue.shift()!;
    if (scannedBundles.has(url)) continue;
    scannedBundles.add(url);
    count++;

    process.stdout.write(`${C.gray}▸ [${count}] scanning ${url.slice(0, 70)}…${C.reset}\r`);
    const bundle = await fetchText(url);
    if (!bundle.ok || !bundle.body) continue;

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
  process.stdout.write(`${' '.repeat(90)}\r`);
  console.log(`${C.gray}▸ ${scannedBundles.size} bundle(s) scanned${C.reset}`);
  scanned.push(`Exposed secrets/credentials in ${scannedBundles.size} JavaScript bundle(s)`);
  scanned.push('Exposed source maps (original source code downloadable from the URL)');

  // Active probes access the app's backend (row reads, writes, introspection). Passive
  // mode skips all of them, reading only public assets — safe without the owner's permission.
  const doActive = !args.passive;
  if (args.passive) {
    console.log(
      `${C.gray}▸ Passive mode: skipping RLS/GraphQL/Firebase probes (public assets only).${C.reset}`,
    );
  }

  let rls: RlsResult | null = null;
  if (doActive && !args.noRls && supabaseCfg?.projectUrl && supabaseCfg.anonKey) {
    console.log(`${C.gray}▸ Supabase detected: ${supabaseCfg.projectUrl}${C.reset}`);
    process.stdout.write(`${C.gray}▸ Enumerating tables & probing Row Level Security…${C.reset}`);
    rls = await probeRLS(supabaseCfg.projectUrl, supabaseCfg.anonKey, {
      writeTest: args.writeTest,
    });
    console.log(` ${C.green}done${C.reset} (${rls.enumerated} enumerated, ${rls.probed} probed)`);
    scanned.push(
      `Supabase RLS — ${rls.probed} tables probed (${rls.enumerated} enumerated live)${args.writeTest ? ', write access tested' : ''}`,
    );
    findings.push(...rlsFindings(rls));

    process.stdout.write(`${C.gray}▸ Checking GraphQL introspection…${C.reset}`);
    const gql = await checkGraphqlIntrospection(supabaseCfg.projectUrl, supabaseCfg.anonKey);
    console.log(` ${C.green}done${C.reset}`);
    scanned.push('Supabase GraphQL introspection exposure');
    if (gql) findings.push(gql);
  } else if (doActive && !args.noRls) {
    console.log(`${C.gray}▸ No Supabase key detected. Skipping RLS/GraphQL probe.${C.reset}`);
  }

  if (doActive && firebaseCfg) {
    console.log(`${C.gray}▸ Firebase detected — probing RTDB & Storage…${C.reset}`);
    findings.push(...(await checkFirebase(firebaseCfg)));
    scanned.push('Firebase Realtime Database and Storage bucket exposure');
  } else if (args.passive && (firebaseCfg || supabaseCfg?.anonKey)) {
    scanned.push('Detected a Supabase/Firebase config (not probed — passive mode)');
  }

  if (args.supabaseJson) {
    findings.push(...loadSupabaseExport(args.supabaseJson));
    scanned.push('Live Supabase audit export (--supabase)');
  }

  finish(target, findings, rls, scanned, args);
}
