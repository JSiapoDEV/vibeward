// Two things a browser is told by the page itself: how to keep a session cookie, and whether
// to load code over plain HTTP. Both come from the responses a visitor already receives, so
// both run in passive mode.
//
// Precision first, as everywhere in vibeward. A cookie is only judged when its name says it
// holds a session, because `_ga` without `Secure` is a footnote and a report full of
// footnotes hides the session cookie a script can read. Mixed content is only reported for
// what runs or submits — scripts, styles, frames, forms — never for an image, which a
// browser upgrades or shows with a warning and which carries no code.

import type { Finding } from '../core/types.js';

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/** Names that mean "this cookie is the login". */
const SESSION_NAME =
  /^(?:connect\.sid|PHPSESSID|JSESSIONID|ASP\.NET_SessionId|laravel_session|_session_id|sb-[\w-]+-auth-token(?:\.\d+)?)$|(?:^|[_.-])(?:sess(?:ion)?|sid|auth|jwt|access[_-]?token|refresh[_-]?token|id[_-]?token)(?:[_.-]|$)/i;

/**
 * Supabase's SSR helpers keep the session in `sb-<ref>-auth-token` and leave it readable by
 * scripts on purpose: the browser client reads it. Telling the owner to add HttpOnly would
 * break their login, so that one rule skips it. `Secure` still applies.
 */
const SCRIPT_READABLE_BY_DESIGN = /^sb-[\w-]+-auth-token(?:\.\d+)?$/i;

interface SetCookie {
  name: string;
  secure: boolean;
  httpOnly: boolean;
}

function parseSetCookie(raw: string): SetCookie | null {
  const [pair, ...attrs] = raw.split(';');
  const name = pair?.split('=')[0]?.trim();
  if (!name) return null;
  const flags = attrs.map((a) => a.trim().split('=')[0]!.toLowerCase());
  return { name, secure: flags.includes('secure'), httpOnly: flags.includes('httponly') };
}

/**
 * Session cookies on the main document's response that a script can read, or that would
 * travel over plain HTTP. Only the first, signed-out response is seen: cookies set after
 * login are outside a scan that never logs in, and the coverage line says so.
 */
export function checkCookies(headers: Headers, pageUrl: string): Finding[] {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const sessions = raw
    .map(parseSetCookie)
    .filter((c): c is SetCookie => c !== null && SESSION_NAME.test(c.name));
  if (sessions.length === 0) return [];

  const findings: Finding[] = [];
  const https = pageUrl.startsWith('https://');
  const names = (list: SetCookie[]) => list.map((c) => `\`${c.name}\``).join(', ');

  const insecure = https ? sessions.filter((c) => !c.secure) : [];
  if (insecure.length > 0) {
    findings.push({
      id: 'cookie_session_not_secure',
      label: `Session cookie sent without the Secure flag: ${names(insecure)}`,
      severity: 'medium',
      check: 22,
      cwe: 'CWE-614',
      source: pageUrl,
      evidence: `Set-Cookie without Secure: ${insecure.map((c) => c.name).join(', ')}`,
      exploit:
        'The browser also sends this cookie over plain HTTP. One visit to an http:// link on an open network — before HSTS has been seen — hands the session to whoever is on the path.',
      why: 'Add `Secure` to the session cookie so the browser only ever sends it over HTTPS.',
      references: [
        'https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#restrict_access_to_cookies',
        'https://cwe.mitre.org/data/definitions/614.html',
      ],
      es: {
        label: `Cookie de sesión enviada sin el atributo Secure: ${names(insecure)}`,
        evidence: `Set-Cookie sin Secure: ${insecure.map((c) => c.name).join(', ')}`,
        exploit:
          'El navegador también envía esta cookie por HTTP plano. Una sola visita a un enlace http:// en una red abierta, antes de haber visto HSTS, le entrega la sesión a quien esté en el camino.',
        why: 'Agrega `Secure` a la cookie de sesión para que el navegador solo la envíe por HTTPS.',
      },
    });
  }

  const readable = sessions.filter((c) => !c.httpOnly && !SCRIPT_READABLE_BY_DESIGN.test(c.name));
  if (readable.length > 0) {
    findings.push({
      id: 'cookie_session_script_readable',
      label: `Session cookie readable by page scripts (no HttpOnly): ${names(readable)}`,
      severity: 'medium',
      check: 22,
      cwe: 'CWE-1004',
      source: pageUrl,
      evidence: `Set-Cookie without HttpOnly: ${readable.map((c) => c.name).join(', ')}`,
      exploit:
        'Any script on the page can read the session with `document.cookie`. One XSS — or one compromised third-party script — and the session leaves the browser and can be replayed elsewhere.',
      why: 'Set `HttpOnly` on the session cookie. The server still receives it; scripts stop seeing it.',
      references: [
        'https://owasp.org/www-community/HttpOnly',
        'https://cwe.mitre.org/data/definitions/1004.html',
      ],
      es: {
        label: `Cookie de sesión legible por los scripts de la página (sin HttpOnly): ${names(readable)}`,
        evidence: `Set-Cookie sin HttpOnly: ${readable.map((c) => c.name).join(', ')}`,
        exploit:
          'Cualquier script de la página puede leer la sesión con `document.cookie`. Con un XSS, o un script de terceros comprometido, la sesión sale del navegador y se puede reutilizar en otro lado.',
        why: 'Pon `HttpOnly` en la cookie de sesión. El servidor la sigue recibiendo; los scripts dejan de verla.',
      },
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Mixed content
// ---------------------------------------------------------------------------

/** Opening tags whose URL attribute loads something that runs, or sends something. */
const ACTIVE: { tag: string; attr: string; rel?: RegExp }[] = [
  { tag: 'script', attr: 'src' },
  { tag: 'iframe', attr: 'src' },
  { tag: 'frame', attr: 'src' },
  { tag: 'object', attr: 'data' },
  { tag: 'embed', attr: 'src' },
  { tag: 'link', attr: 'href', rel: /\b(?:stylesheet|preload|modulepreload|import)\b/i },
];

/** Loopback is a developer leftover that fails on its own; it is not an exposure. */
const LOOPBACK = /^http:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?:[:/]|$)/i;

function attrOf(tag: string, name: string): string | null {
  // Whitespace before the name, so `data-src` is not read as `src`.
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function insecure(url: string | null): url is string {
  return url !== null && /^http:\/\//i.test(url.trim()) && !LOOPBACK.test(url.trim());
}

/** What one HTTPS page loads or submits over plain HTTP. Empty on an http:// page. */
export function checkMixedContent(html: string, pageUrl: string): Finding[] {
  if (!pageUrl.startsWith('https://')) return [];
  const doc = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const findings: Finding[] = [];

  const loads: string[] = [];
  for (const spec of ACTIVE) {
    for (const tag of doc.match(new RegExp(`<${spec.tag}\\b[^>]*>`, 'gi')) ?? []) {
      if (spec.rel && !spec.rel.test(attrOf(tag, 'rel') ?? '')) continue;
      const url = attrOf(tag, spec.attr);
      if (insecure(url)) loads.push(url.trim());
    }
  }
  if (loads.length > 0) {
    const list = [...new Set(loads)].slice(0, 5);
    findings.push({
      id: 'mixed_content_active',
      label: `HTTPS page loads ${loads.length} script(s), style(s) or frame(s) over plain HTTP`,
      severity: 'low',
      check: 22,
      cwe: 'CWE-319',
      source: pageUrl,
      evidence: list.join(', '),
      exploit:
        'Current browsers refuse to load these, so the page is quietly missing whatever they provide. A browser that does load one runs code that anyone on the network path could have replaced.',
      why: 'Change each address to `https://`, or serve the file from your own origin.',
      references: [
        'https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content',
        'https://cwe.mitre.org/data/definitions/319.html',
      ],
      es: {
        label: `Página HTTPS que carga ${loads.length} script(s), estilo(s) o frame(s) por HTTP plano`,
        exploit:
          'Los navegadores actuales se niegan a cargarlos, así que a la página le falta en silencio lo que aportan. Un navegador que sí cargue uno ejecuta código que cualquiera en el camino de red pudo cambiar.',
        why: 'Cambia cada dirección a `https://`, o sirve el archivo desde tu propio dominio.',
      },
    });
  }

  const forms = (doc.match(/<form\b[^>]*>[\s\S]*?(?:<\/form>|$)/gi) ?? []).filter((f) =>
    insecure(attrOf(f.slice(0, f.indexOf('>') + 1), 'action')),
  );
  if (forms.length > 0) {
    const password = forms.some((f) => /<input\b[^>]*\stype\s*=\s*["']?password/i.test(f));
    const action = attrOf(forms[0]!.slice(0, forms[0]!.indexOf('>') + 1), 'action') ?? '';
    findings.push({
      id: 'insecure_form_action',
      label: password
        ? 'A login form on an HTTPS page submits the password over plain HTTP'
        : 'A form on an HTTPS page submits over plain HTTP',
      severity: password ? 'high' : 'medium',
      check: 22,
      cwe: 'CWE-319',
      source: pageUrl,
      evidence: action.trim(),
      exploit:
        'The page is encrypted but what the visitor types is not: the form sends it in clear text, readable and changeable by anyone on the network path. Browsers warn, and most people click through.',
      why: 'Point the form at an `https://` address, or at a relative path on your own site.',
      references: [
        'https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content',
        'https://cwe.mitre.org/data/definitions/319.html',
      ],
      es: {
        label: password
          ? 'Un formulario de inicio de sesión en una página HTTPS envía la contraseña por HTTP plano'
          : 'Un formulario en una página HTTPS envía los datos por HTTP plano',
        exploit:
          'La página está cifrada pero lo que escribe el visitante no: el formulario lo envía en texto plano, y cualquiera en el camino de red lo puede leer y cambiar. El navegador avisa, y la mayoría sigue igual.',
        why: 'Apunta el formulario a una dirección `https://`, o a una ruta relativa de tu propio sitio.',
      },
    });
  }
  return findings;
}
