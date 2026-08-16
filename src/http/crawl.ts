// Network layer for the website checks: a small, same-host crawl of the client's site.
// Every request goes through fetchText and they run one at a time — this hits a live
// production site, so it must read like a browser, never like a scan.

import { fetchText } from './client.js';
import type { FetchResult } from './client.js';

export interface CrawledPage {
  url: string;
  status: number;
  html: string;
}

export interface BrokenAsset {
  url: string;
  status: number;
  from: string;
}

export interface SiteFiles {
  /** null = missing, unreachable, or answered with HTML (an SPA catch-all). */
  robotsTxt: string | null;
  llmsTxt: string | null;
  sitemapXml: string | null;
  faviconOk: boolean;
  /** Answer to an invented path: status + whether the HTML differs from the home. */
  notFound: { status: number; distinct: boolean };
}

export interface CrawlResult {
  pages: CrawledPage[];
  files: SiteFiles;
  brokenAssets: BrokenAsset[];
  /**
   * How many referenced files were actually requested. Zero broken assets out of zero
   * requests is not a clean bill of health, and the report needs to be able to tell the
   * difference between "nothing is broken" and "there was nothing to check".
   */
  assetsChecked: number;
}

const MAX_PAGES = 8;
const MAX_ASSETS = 30;
const FILE_TIMEOUT = 8000;
const ASSET_TIMEOUT = 8000;

/** Fixed on purpose: the same site must produce the same report on every run. */
const NOT_FOUND_PROBE = '/vibeward-404-probe-7f3a91';

/** Extensions that are files to download, never pages to crawl. */
const ASSET_EXT = /\.(?:pdf|jpe?g|png|gif|svg|webp|zip|mp4|css|js|xml|ico|woff2?|txt)$/i;

const NON_PAGE_SCHEME = /^(?:mailto:|tel:|sms:|javascript:|data:|blob:|about:)/i;

const HTML_START = /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i;

/** `<link>` relations that point at pages or origins, not at assets to download. */
const NON_ASSET_REL = /\b(?:canonical|alternate|preconnect|dns-prefetch)\b/i;

const REL_ATTR = /\brel=["']([^"']*)["']/i;
const HREF_ATTR = /\bhref=["']([^"']*)["']/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Absolute http(s) URL for any reference, hash stripped. Used for assets, not pages. */
function absolutize(ref: string, base: string): string | null {
  const t = ref.trim();
  if (!t || t.startsWith('#') || NON_PAGE_SCHEME.test(t)) return null;
  try {
    const u = new URL(t, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function decodeXml(text: string): string {
  return text
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Canonical form of a crawlable page URL, or null when it is not a page at all:
 * a mail/phone/script link, a bare anchor, or a file to download. Hash, trailing
 * slash and `utm_*` parameters are dropped so the same page is never fetched twice.
 * Pure — no network. The same-host rule is applied by the callers.
 */
export function normalizePageUrl(raw: string, base: string): string | null {
  const ref = raw.trim();
  if (!ref || ref.startsWith('#') || NON_PAGE_SCHEME.test(ref)) return null;

  let url: URL;
  try {
    url = new URL(ref, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (ASSET_EXT.test(url.pathname)) return null;

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  if (url.searchParams.size === 0) url.search = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.href;
}

/**
 * Same-host pages linked from an HTML document, capped at `max`. The document's own
 * URL is left out — the caller already has it. Pure — no network.
 */
export function discoverInternalLinks(html: string, baseUrl: string, max: number): string[] {
  const host = hostOf(baseUrl);
  if (!host || max <= 0) return [];
  const self = normalizePageUrl(baseUrl, baseUrl);
  const out = new Set<string>();
  const re = /<a\b[^>]*?\shref=["']([^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.size < max) {
    const abs = normalizePageUrl(m[1]!, baseUrl);
    if (!abs || abs === self || hostOf(abs) !== host) continue;
    out.add(abs);
  }
  return [...out];
}

/**
 * Page URLs listed in a sitemap, restricted to `host` and capped at `max`. Entries
 * pointing at other sitemaps or at files are dropped by the page rules. Pure — no network.
 */
export function parseSitemapUrls(xml: string, host: string, max: number): string[] {
  if (max <= 0) return [];
  const out = new Set<string>();
  const base = `https://${host}/`;
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && out.size < max) {
    const abs = normalizePageUrl(decodeXml(m[1]!), base);
    if (!abs || hostOf(abs) !== host) continue;
    out.add(abs);
  }
  return [...out];
}

/**
 * Same-host assets the page pulls in: `<script src>`, `<link href>` and `<img src>`.
 * Pure — no network.
 */
export function discoverAssets(html: string, baseUrl: string): string[] {
  const host = hostOf(baseUrl);
  if (!host) return [];
  const out = new Set<string>();

  const add = (ref: string): void => {
    const abs = absolutize(ref, baseUrl);
    if (abs && hostOf(abs) === host) out.add(abs);
  };

  for (const re of [
    /<script\b[^>]*?\ssrc=["']([^"']*)["']/gi,
    /<img\b[^>]*?\ssrc=["']([^"']*)["']/gi,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) add(m[1]!);
  }

  const linkRe = /<link\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = linkRe.exec(html)) !== null) {
    const rel = tag[0].match(REL_ATTR)?.[1] ?? '';
    if (NON_ASSET_REL.test(rel)) continue;
    const href = tag[0].match(HREF_ATTR)?.[1];
    if (href) add(href);
  }

  return [...out];
}

function normalizeForCompare(html: string): string {
  return html.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Whether two documents are, for reporting purposes, the same page. Compares total
 * length and a normalized prefix, which is enough to catch the case that matters: an
 * SPA serving the very same `index.html` for every unknown path. Pure — no network.
 */
export function looksLikeSamePage(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return na === nb;
  const longer = Math.max(na.length, nb.length);
  if (Math.abs(na.length - nb.length) / longer > 0.1) return false;
  return na.slice(0, 400) === nb.slice(0, 400);
}

function isHtmlResponse(res: FetchResult): boolean {
  const type = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) return true;
  return HTML_START.test(res.body.slice(0, 200));
}

/**
 * Body of a text file the site is supposed to serve, or null when it is missing.
 * A 200 that answers with HTML is treated as missing: that is an SPA host handing
 * `index.html` to every path, the single most common case on a vibe-coded site.
 *
 * The body decides, not the Content-Type. Plenty of hosts serve a perfectly real
 * robots.txt or sitemap.xml as `text/html`, and reporting "you have no sitemap" to
 * someone who does is exactly the kind of false claim this scanner cannot afford.
 */
async function fetchSiteFile(url: string): Promise<string | null> {
  const res = await fetchText(url, FILE_TIMEOUT);
  if (res.status !== 200) return null;
  if (HTML_START.test(res.body.slice(0, 200))) return null;
  return res.body;
}

/** The `href` of the home's icon link, exactly as written in the HTML. */
function faviconHref(html: string): string | null {
  const re = /<link\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = re.exec(html)) !== null) {
    const rel = tag[0].match(REL_ATTR)?.[1] ?? '';
    if (!/\bicon\b/i.test(rel)) continue;
    const href = tag[0].match(HREF_ATTR)?.[1];
    if (href && href.trim()) return href.trim();
  }
  return null;
}

async function iconExists(url: string): Promise<boolean> {
  const res = await fetchText(url, FILE_TIMEOUT);
  return res.status === 200 && !isHtmlResponse(res);
}

/** True when either `/favicon.ico` or the home's icon link resolves to a real file. */
async function probeFavicon(origin: string, homeHtml: string, home: string): Promise<boolean> {
  if (await iconExists(`${origin}/favicon.ico`)) return true;

  const href = faviconHref(homeHtml);
  if (!href) return false;
  if (/^data:/i.test(href)) return true; // inlined icon: nothing to request

  const abs = absolutize(href, home);
  if (!abs || abs === `${origin}/favicon.ico`) return false;
  return iconExists(abs);
}

async function runCrawl(result: CrawlResult, home: string, homeHtml: string): Promise<void> {
  const url = new URL(home);
  const origin = url.origin;
  const host = url.host;
  const files = result.files;

  files.robotsTxt = await fetchSiteFile(`${origin}/robots.txt`);
  files.llmsTxt = await fetchSiteFile(`${origin}/llms.txt`);
  files.sitemapXml = await fetchSiteFile(`${origin}/sitemap.xml`);
  files.faviconOk = await probeFavicon(origin, homeHtml, home);

  const probe = await fetchText(`${origin}${NOT_FOUND_PROBE}`, FILE_TIMEOUT);
  // A probe that never got an answer proves nothing, so it is not held against the site.
  const distinct =
    probe.status === 0 || probe.status >= 400 || !looksLikeSamePage(probe.body, homeHtml);
  files.notFound = { status: probe.status, distinct };

  const fromSitemap = files.sitemapXml ? parseSitemapUrls(files.sitemapXml, host, MAX_PAGES) : [];
  const candidates = fromSitemap.length
    ? fromSitemap
    : discoverInternalLinks(homeHtml, home, MAX_PAGES);

  const seen = new Set<string>([home]);
  for (const candidate of candidates) {
    if (result.pages.length >= MAX_PAGES) break;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const res = await fetchText(candidate);
    if (res.status !== 200 || !isHtmlResponse(res)) continue;

    const finalUrl = normalizePageUrl(res.finalUrl ?? candidate, candidate) ?? candidate;
    // The host is checked again AFTER the redirect: `fetchText` follows redirects, and a
    // link to /blog that lands on a Substack or a Shopify storefront would otherwise get
    // crawled and its missing tags billed to this client.
    if (hostOf(finalUrl) !== host) continue;
    if (finalUrl !== candidate && seen.has(finalUrl)) continue; // redirected onto a known page
    seen.add(finalUrl);
    result.pages.push({ url: finalUrl, status: res.status, html: res.body });
  }

  for (const asset of discoverAssets(homeHtml, home).slice(0, MAX_ASSETS)) {
    const res = await fetchText(asset, ASSET_TIMEOUT);
    result.assetsChecked++;
    // Only a real error response counts. `status === 0` is our own timeout, DNS failure or
    // reset — evidence about this network, not about the site, and the report would present
    // it as "answers with 4xx/5xx", which would simply be untrue.
    if (res.status >= 400) {
      result.brokenAssets.push({ url: asset, status: res.status, from: home });
    }
  }
}

/**
 * Crawls the site around an already-fetched home page: its well-known files, a 404
 * probe, up to 8 same-host pages (sitemap first, internal links as fallback) and the
 * assets the home references. Requests are sequential. Never throws: a network
 * failure is a result, so a partial crawl is returned instead of aborting the scan.
 */
export async function crawlSite(homeUrl: string, homeHtml: string): Promise<CrawlResult> {
  const home = normalizePageUrl(homeUrl, homeUrl) ?? homeUrl;
  const result: CrawlResult = {
    pages: [{ url: home, status: 200, html: homeHtml }],
    files: {
      robotsTxt: null,
      llmsTxt: null,
      sitemapXml: null,
      faviconOk: false,
      notFound: { status: 0, distinct: true },
    },
    brokenAssets: [],
    assetsChecked: 0,
  };

  try {
    await runCrawl(result, home, homeHtml);
  } catch {
    // Whatever was collected before the failure still stands.
  }
  return result;
}
