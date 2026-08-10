const UA = 'Mozilla/5.0 (compatible; vibeward/0.2; +authorized security audit)';

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
