import { fetchHop } from '../http/client.js';
import type { Finding } from '../core/types.js';

/**
 * How many redirects to follow by hand before giving up. Three covers the shapes that occur
 * in practice — `http://host` → `http://www.host` → `https://www.host` is two — without
 * turning a single check into a crawl.
 */
const MAX_HOPS = 3;

/** Where the plain-HTTP request ended up. */
export type PlainVerdict =
  | { kind: 'upgraded' } // reached HTTPS, which is the whole point
  | { kind: 'served'; status: number; hops: string[] } // the site answers over plain HTTP
  | { kind: 'unavailable' }; // nothing listens, or it refuses — nothing to report

/**
 * Exported for the tests, which point it at a local HTTP server: this loop is where a false
 * positive would come from, and the only way to exercise it is to control both ends.
 */
export async function followPlainHttp(start: string): Promise<PlainVerdict> {
  const hops: string[] = [];
  let url = start;

  for (let i = 0; i < MAX_HOPS; i++) {
    const hop = await fetchHop(url);

    // Port 80 refused, reset, or timed out. A site with no plain-HTTP listener at all is the
    // safest shape there is, and reporting it as a finding would be exactly backwards.
    if (hop.status === 0) return { kind: 'unavailable' };

    if (hop.status >= 300 && hop.status < 400 && hop.location) {
      hops.push(`${hop.status} → ${hop.location}`);
      if (hop.location.startsWith('https://')) return { kind: 'upgraded' };
      url = hop.location; // still plain: keep following, it may upgrade on the next hop
      continue;
    }

    // A 4xx/5xx over plain HTTP is not the page. The site is not readable over HTTP, which
    // is what this check is asking about, so there is nothing to report.
    if (hop.status >= 400) return { kind: 'unavailable' };

    return { kind: 'served', status: hop.status, hops };
  }

  // Still bouncing between plain-HTTP addresses after MAX_HOPS: it never upgraded.
  return { kind: 'served', status: 0, hops };
}

/**
 * Does the site answer plain `http://` with the page instead of a redirect to HTTPS?
 *
 * This is the check that makes the missing-HSTS finding mean something. Without it the
 * report can only say "the browser is not told to remember HTTPS", which reads as
 * theoretical; with it the report can say "and here is the plaintext copy it will happily
 * fall back to". They are the same defect at two different levels of proof, and only one of
 * them gets acted on.
 *
 * Returns null whenever the answer is "fine" or "cannot tell" — an inconclusive network
 * result must never become a finding.
 */
export async function checkPlainHttp(target: string): Promise<Finding | null> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  // Only an HTTPS target has a plain-HTTP counterpart worth asking about. A target the
  // operator typed as `http://` has already told us what it is.
  if (url.protocol !== 'https:') return null;
  // An explicit port makes the comparison ambiguous — `https://host:8443` has no obvious
  // plain-HTTP twin, and guessing port 80 would test a different service.
  if (url.port !== '') return null;

  const plain = new URL(url.toString());
  plain.protocol = 'http:';

  const verdict = await followPlainHttp(plain.toString());
  if (verdict.kind !== 'served') return null;

  const chain = verdict.hops.length ? ` (${verdict.hops.join(' → ')})` : '';
  const answered =
    verdict.status > 0
      ? `answered ${verdict.status} and served the page`
      : `kept redirecting between plain-HTTP addresses`;

  return {
    id: 'plain_http_no_redirect',
    label: 'The site is served over plain HTTP without redirecting to HTTPS',
    severity: 'medium',
    check: 22,
    cwe: 'CWE-319',
    source: plain.toString(),
    evidence: `${plain.toString()} ${answered}${chain} — no redirect to HTTPS.`,
    exploit:
      'Anyone sharing a network with the visitor — a café hotspot, a hotel, a compromised router — can read and rewrite the page in transit: inject a script, swap a payment link, or capture whatever is typed into a form. The padlock is never shown, so nothing warns the visitor.',
    why: 'A visitor who types the domain, follows an old link, or clicks a QR code arrives over plain HTTP, and the server hands them the site instead of sending them to HTTPS. Encryption that is available but not enforced is not enforced. One permanent redirect from `http://` to `https://` closes it — `Always Use HTTPS` on Cloudflare, a `redirects` rule on Netlify or Vercel, a `return 301 https://$host$request_uri;` server block on nginx — and the `Strict-Transport-Security` header then keeps returning browsers from ever trying plain HTTP again. The redirect comes first: HSTS only protects visitors who already made one successful HTTPS request.',
    references: [
      'https://cwe.mitre.org/data/definitions/319.html',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security',
    ],
    es: {
      label: 'El sitio se sirve por HTTP plano sin redirigir a HTTPS',
      evidence: `${plain.toString()} ${
        verdict.status > 0
          ? `respondió ${verdict.status} y sirvió la página`
          : `siguió redirigiendo entre direcciones HTTP planas`
      }${chain} — sin redirección a HTTPS.`,
      exploit:
        'Cualquiera que comparta red con el visitante — el wifi de una cafetería, un hotel, un router comprometido — puede leer y reescribir la página en tránsito: inyectar un script, cambiar un enlace de pago o capturar lo que se escriba en un formulario. El candado no aparece, así que nada avisa al visitante.',
      why: 'Quien escribe el dominio, sigue un enlace viejo o abre un QR llega por HTTP plano, y el servidor le entrega el sitio en vez de mandarlo a HTTPS. El cifrado que está disponible pero no se impone, no está impuesto. Se cierra con una redirección permanente de `http://` a `https://` — `Always Use HTTPS` en Cloudflare, una regla `redirects` en Netlify o Vercel, un `return 301 https://$host$request_uri;` en nginx — y a partir de ahí la cabecera `Strict-Transport-Security` evita que el navegador vuelva a intentarlo en claro. La redirección va primero: HSTS solo protege a quien ya hizo una petición HTTPS con éxito.',
    },
  };
}
