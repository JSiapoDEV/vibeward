import type { Finding } from '../core/types.js';
import { fetchText } from '../http/client.js';

/** `//# sourceMappingURL=app.js.map` (or the older `//@` form) at the end of a bundle. */
const SOURCE_MAP_REF = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/;

/**
 * Resolves the absolute `.map` URL a bundle points to, or null when there is no
 * external reference (no comment, or an inline `data:` map). Pure — no network.
 */
export function resolveSourceMapUrl(jsBody: string, jsUrl: string): string | null {
  const m = jsBody.match(SOURCE_MAP_REF);
  if (!m) return null;
  const ref = m[1]!;
  if (ref.startsWith('data:')) return null; // inline map, not a separately served file
  try {
    return new URL(ref, jsUrl).href;
  } catch {
    return null;
  }
}

/**
 * Builds the finding from a fetched map body, or null when the body does not look
 * like a real source map. Pure — no network. A served `.map` hands attackers the
 * original, unminified source: component names, comments, inline config and any
 * value the bundler kept in code.
 */
export function sourceMapFinding(mapUrl: string, mapBody: string): Finding | null {
  if (!/"mappings"\s*:/.test(mapBody) && !/"sources"\s*:/.test(mapBody)) return null;

  const hasSource = /"sourcesContent"\s*:\s*\[/.test(mapBody);
  const fileName = mapUrl.split('/').pop() ?? 'bundle.js.map';

  return {
    id: `sourcemap_exposed_${fileName.replace(/[^A-Za-z0-9]/g, '_')}`,
    es: {
      label: 'Source map expuesto — el código fuente original se puede descargar',
      evidence: `${mapUrl} se sirve públicamente${hasSource ? ' e incrusta el fuente original completo (sourcesContent)' : ''}.`,
      exploit: `Cualquiera abre ${mapUrl} y reconstruye el fuente sin minificar — nombres de componentes, comentarios, configuración en línea y cualquier valor hardcodeado que el bundler dejara dentro.`,
      impact:
        'El código fuente original es legible por cualquiera, lo que convierte una caja negra en un libro abierto: cualquier otra debilidad pasa a ser mucho más fácil de encontrar, y los secretos que quedaran en el código se entregan directamente.',
      why: 'Las builds de producción no deberían publicar source maps. Desactiva su emisión en producción, o elimina los ficheros `.map` de la salida desplegada.',
    },
    label: 'Source map exposed — original source code is downloadable',
    severity: 'medium',
    check: 23,
    cwe: 'CWE-540',
    source: mapUrl,
    evidence: `${mapUrl} is served publicly${hasSource ? ' and embeds the full original source (sourcesContent)' : ''}.`,
    exploit: `Anyone opens ${mapUrl} and reconstructs the unminified source — component names, comments, inline configuration and any hard-coded value the bundler left in.`,
    impact:
      'The original source code is readable by anyone, which turns a black box into an open book: every other weakness becomes far easier to find, and secrets left in code are handed over directly.',
    why: 'Production builds should not ship source maps to the public. Disable source-map emission for prod, or strip the `.map` files from the deployed output.',
    references: [
      'https://cwe.mitre.org/data/definitions/540.html',
      'https://webpack.js.org/configuration/devtool/',
    ],
  };
}

/**
 * Full black-box check: parse the bundle's source-map reference, fetch it, and
 * flag it only when the map is actually reachable and valid — so a stray comment
 * pointing at a missing file is never reported as a leak.
 */
export async function checkSourceMap(jsUrl: string, jsBody: string): Promise<Finding | null> {
  const mapUrl = resolveSourceMapUrl(jsBody, jsUrl);
  if (!mapUrl) return null;

  const res = await fetchText(mapUrl, 8000);
  if (!res.ok || !res.body) return null;

  return sourceMapFinding(mapUrl, res.body);
}
