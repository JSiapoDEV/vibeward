// Finds the JavaScript assets referenced by a page, so their contents can be scanned.

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
