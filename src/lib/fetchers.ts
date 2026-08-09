const UA = 'Mozilla/5.0 (compatible; vibeward/0.1; +authorized security audit)';

export interface FetchResult {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
  finalUrl?: string;
  error?: string;
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

function absolutize(base: string, ref: string): string | null {
  try {
    return new URL(ref, base).href;
  } catch {
    return null;
  }
}

/** Finds <script src>, module preloads and loose asset paths referenced by the HTML. */
export function discoverScripts(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<link[^>]+href=["']([^"']+\.js)["']/gi,
    /["'](\/assets\/[A-Za-z0-9._-]+\.js)["']/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const abs = absolutize(baseUrl, m[1]!);
      if (abs) urls.add(abs);
    }
  }
  return [...urls];
}

/** Follows one more level of chunk references (secrets often live in a lazy chunk). */
export function discoverChunksFromBundle(jsText: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const re = /["'`]([./][A-Za-z0-9/._-]*\.js)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsText)) !== null) {
    const abs = absolutize(baseUrl, m[1]!);
    if (abs && abs.endsWith('.js')) urls.add(abs);
  }
  return [...urls];
}
