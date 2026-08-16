// Identifies the scanner and points at its docs, the way every well-behaved crawler does.
// It deliberately claims nothing about authorization: the site owner reads this string in
// their logs, and vibeward is in no position to assert to them that the operator had their
// permission. The operator is asked that question at the terminal instead.
const UA = 'Mozilla/5.0 (compatible; vibeward/0.5; +https://vibeward.ai)';

export interface FetchResult {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
  finalUrl?: string;
  error?: string;
}

/** What a single request answered before any redirect was followed. */
export interface HopResult {
  /** 0 when the host never answered (refused, reset, DNS, timeout). */
  status: number;
  /** The `Location` of a 3xx, resolved against the request URL. */
  location: string | null;
  error?: string;
}

/**
 * One request, redirects left unfollowed.
 *
 * `fetchText` follows redirects, which is right for reading a page and wrong for judging
 * one: a site that answers plain HTTP with a 301 and one that serves the whole page over
 * plain HTTP both end up at the same final URL, and the difference between them is the
 * entire finding. Only `redirect: 'manual'` can tell them apart.
 */
export async function fetchHop(url: string, timeout = 8000): Promise<HopResult> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'manual',
      signal: controller.signal,
    });
    const raw = res.headers.get('location');
    let location: string | null = null;
    if (raw) {
      try {
        location = new URL(raw, url).toString();
      } catch {
        location = raw;
      }
    }
    return { status: res.status, location };
  } catch (err) {
    return { status: 0, location: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchText(url: string, timeout = 15000): Promise<FetchResult> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      body: await res.text(),
      finalUrl: res.url,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      body: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(t);
  }
}
