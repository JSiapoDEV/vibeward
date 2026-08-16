import type { Finding, Severity, SupabaseConfig } from '../core/types.js';

interface SecretPattern {
  id: string;
  label: string;
  severity: Severity;
  check: number;
  cwe: string;
  regex: RegExp;
  why: string;
  exploit: string;
  references: string[];
  /** Returns extra evidence fields, or null to discard the match (e.g. an anon JWT). */
  validate?: (match: string) => Record<string, string> | null;
  /**
   * Spanish prose for `--lang es`. Required rather than optional: a new pattern that ships
   * without a translation should fail to compile, not fail silently in a client's report.
   * Evidence is masked key material, so it is never translated.
   */
  es: { label: string; why: string; exploit: string };
}

const CWE_798 = 'https://cwe.mitre.org/data/definitions/798.html';
const BUNDLE_EXPLOIT =
  'The key ships in the client JavaScript, so anyone can open the page source, copy it, and call the provider as you — no authentication needed.';
const BUNDLE_EXPLOIT_ES =
  'La clave viaja en el JavaScript del cliente, así que cualquiera puede abrir el código de la página, copiarla y llamar al proveedor haciéndose pasar por ti — sin autenticarse.';

/** A Supabase JWT encodes its role in the base64url payload. service_role bypasses RLS. */
function decodeJwtRole(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role?: string;
    };
    return json.role ?? null;
  } catch {
    return null;
  }
}

function mask(s: string): string {
  if (s.length <= 12) return `${s.slice(0, 3)}…`;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
// New-format Supabase keys (2025+): sb_publishable_ is public; sb_secret_ bypasses RLS.
const SB_PUBLISHABLE_RE = /\bsb_publishable_[A-Za-z0-9_-]{20,}\b/;
const SB_SECRET_RE = /\bsb_secret_[A-Za-z0-9_-]{20,}\b/;

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'supabase_service_role',
    es: {
      label: 'Clave service_role de Supabase en el cliente',
      exploit:
        'La clave service_role está en el bundle del cliente. Cualquiera puede extraerla y atacar la API REST/GraphQL de Supabase con privilegios totales, saltándose todas las políticas RLS — leer, modificar o borrar cualquier tabla.',
      why: 'Es la exposición más peligrosa que existe. Da acceso total a la base de datos a cualquiera que vea la página, sin importar tus reglas de seguridad. Rótala hoy.',
    },
    label: 'Supabase service_role key in the client',
    severity: 'critical',
    check: 6,
    cwe: 'CWE-798',
    regex: new RegExp(JWT_RE.source, 'g'),
    validate: (match) =>
      decodeJwtRole(match) === 'service_role' ? { role: 'service_role' } : null,
    exploit:
      'The service_role key is in the client bundle. Anyone can extract it and hit the Supabase REST/GraphQL API with full privileges, bypassing every RLS policy — read, modify or delete any table.',
    why: 'This is the single most dangerous exposure possible. It grants total database access to anyone who views the page, regardless of your security rules. Rotate it today.',
    references: [
      CWE_798,
      'https://supabase.com/docs/guides/api/api-keys',
      'https://nvd.nist.gov/vuln/detail/CVE-2025-48757',
    ],
  },
  {
    id: 'supabase_secret_key',
    es: {
      label: 'Clave secreta de Supabase (sb_secret_) en el cliente',
      exploit:
        'sb_secret_ es la clave de servicio en el formato nuevo: se salta todas las políticas RLS. Quien lea el bundle obtiene lectura, escritura y borrado totales sobre la base de datos por la API REST/GraphQL.',
      why: 'La exposición más peligrosa posible: acceso total a la base de datos al margen de tus políticas. Rótala ya y mantenla solo en el servidor.',
    },
    label: 'Supabase secret key (sb_secret_) in the client',
    severity: 'critical',
    check: 6,
    cwe: 'CWE-798',
    regex: new RegExp(SB_SECRET_RE.source, 'g'),
    exploit:
      'sb_secret_ is the new-format service key: it bypasses every RLS policy. Anyone who reads the bundle gets full read/write/delete on the database through the REST/GraphQL API.',
    why: 'The most dangerous exposure possible — total database access regardless of your policies. Rotate it now and keep it server-side only.',
    references: [
      CWE_798,
      'https://supabase.com/docs/guides/api/api-keys',
      'https://nvd.nist.gov/vuln/detail/CVE-2025-48757',
    ],
  },
  {
    id: 'stripe_secret',
    es: {
      label: 'Clave secreta o restringida de Stripe en producción',
      exploit:
        'Con esta clave un atacante puede crear cobros, emitir reembolsos a sus propias tarjetas y leer tus registros de clientes y de pagos por la API de Stripe.',
      why: 'Una clave secreta de Stripe filtrada puede vaciar dinero y exponer datos de pago. No debe salir nunca del servidor. Rótala de inmediato.',
    },
    label: 'Stripe live secret / restricted key',
    severity: 'critical',
    check: 2,
    cwe: 'CWE-798',
    // Live only. Test mode is the rule below, because it is a different problem: one moves
    // real money and the other cannot, and announcing both as "critical — can drain money"
    // is simply wrong about one of them. Found scanning a real site that shipped both, where
    // the test key was described in the same words as the live one beside it.
    regex: /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
    exploit:
      'With this key an attacker can create charges, issue refunds to their own cards and read your customer and payment records via the Stripe API.',
    why: 'A leaked Stripe secret key can drain money and expose payment data. It must never leave the server. Rotate it immediately.',
    references: [CWE_798, 'https://stripe.com/docs/keys'],
  },
  {
    id: 'stripe_test_secret',
    es: {
      label: 'Clave secreta de Stripe en modo de prueba',
      exploit:
        'Quien la lea puede usar la API de Stripe en modo de prueba de tu cuenta: leer los clientes, los pagos y los productos de prueba, y crear cobros falsos que ensucian tus datos.',
      why: 'Una clave de test no mueve dinero real, así que esto no es una emergencia. Sí son dos cosas: los datos de prueba de tu cuenta quedan legibles, y sobre todo el patrón — una clave secreta llegó al bundle del navegador, y el mismo camino de despliegue es el que lleva la de producción. Sácala del cliente y comprueba que la `sk_live_` no viajó por la misma ruta.',
    },
    label: 'Stripe test secret / restricted key',
    severity: 'medium',
    check: 2,
    cwe: 'CWE-798',
    regex: /\b(sk|rk)_test_[A-Za-z0-9]{20,}\b/g,
    exploit:
      'Anyone reading the bundle can drive your Stripe account in test mode: read test customers, payments and products, and create fake charges that pollute your data.',
    why: 'A test key moves no real money, so this is not an emergency. It is two things: your test-mode data is readable, and — the part that matters — a secret key reached the browser bundle at all. The same deploy path carries the live one. Move it server-side and check that the `sk_live_` key did not travel the same way.',
    references: [CWE_798, 'https://stripe.com/docs/keys'],
  },
  {
    id: 'openai_key',
    es: {
      label: 'Clave de API de OpenAI',
      exploit:
        'Cualquiera puede usar esta clave para ejecutar modelos en tu cuenta hasta agotar tu cuota o tu límite de facturación.',
      why: 'Las claves de OpenAI filtradas han generado facturas de miles de dólares. Revócala y genera una nueva.',
    },
    label: 'OpenAI API key',
    severity: 'critical',
    check: 2,
    cwe: 'CWE-798',
    regex: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g,
    validate: (match) => (match.startsWith('sk_') ? null : { key: mask(match) }),
    exploit:
      'Anyone can use this key to run models on your account until your quota or billing limit is hit.',
    why: 'Leaked OpenAI keys have run up bills of thousands of dollars. Revoke and regenerate.',
    references: [CWE_798],
  },
  {
    id: 'anthropic_key',
    es: {
      label: 'Clave de API de Anthropic',
      exploit: 'Cualquiera puede gastar contra tu cuenta de Anthropic usando esta clave.',
      why: 'Gasto no autorizado contra tu cuenta. Revócala en la consola.',
    },
    label: 'Anthropic API key',
    severity: 'critical',
    check: 2,
    cwe: 'CWE-798',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    exploit: 'Anyone can spend against your Anthropic account using this key.',
    why: 'Unauthorized spend against your account. Revoke it in the console.',
    references: [CWE_798],
  },
  {
    id: 'google_api_key',
    es: {
      label: 'Clave de API de Google',
      exploit:
        'Sin restricciones de dominio o IP, cualquiera puede llamar a las APIs de Google habilitadas (Maps, Gemini, etc.) a tu costa.',
      why: 'Restringe la clave por referrer y por API en la consola de Google Cloud, o rótala.',
    },
    label: 'Google API key',
    severity: 'high',
    check: 2,
    cwe: 'CWE-798',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    exploit:
      'Without domain/IP restrictions, anyone can call the enabled Google APIs (Maps, Gemini, etc.) at your cost.',
    why: 'Restrict the key by referrer and API in Google Cloud Console, or rotate it.',
    references: [CWE_798, 'https://cloud.google.com/docs/authentication/api-keys'],
  },
  {
    id: 'aws_access_key',
    es: {
      label: 'Access Key ID de AWS',
      exploit:
        'Junto con su secreto, da acceso programático a tu cuenta de AWS — datos, cómputo y facturación.',
      why: 'Desactiva la clave en IAM de inmediato y rota cualquier secreto emparejado.',
    },
    label: 'AWS Access Key ID',
    severity: 'critical',
    check: 2,
    cwe: 'CWE-798',
    regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    exploit:
      'Combined with its secret, this grants programmatic access to your AWS account — data, compute and billing.',
    why: 'Disable the key in IAM immediately and rotate any paired secret.',
    references: [CWE_798],
  },
  {
    id: 'github_token',
    es: {
      label: 'Token de GitHub',
      exploit:
        'Este token da acceso por API a tus repositorios, posiblemente privados, con el alcance con el que se emitió.',
      why: 'Revócalo en Settings → Developer settings.',
    },
    label: 'GitHub token',
    severity: 'critical',
    check: 2,
    cwe: 'CWE-798',
    regex: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    exploit:
      'This token grants API access to your repositories, potentially private ones, at the scope it was issued with.',
    why: 'Revoke it in Settings → Developer settings.',
    references: [CWE_798],
  },
  {
    id: 'slack_token',
    es: {
      label: 'Token de Slack',
      exploit:
        'Un token de Slack puede leer y publicar mensajes, listar usuarios y canales, y extraer datos del workspace según el alcance concedido.',
      why: 'Revócalo en los ajustes de la app de Slack y rótalo.',
    },
    label: 'Slack token',
    severity: 'high',
    check: 2,
    cwe: 'CWE-798',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    exploit:
      'A Slack token can read and post messages, list users and channels, and exfiltrate workspace data at its granted scope.',
    why: 'Revoke it in the Slack app settings and rotate.',
    references: [CWE_798],
  },
  {
    id: 'db_connection_string',
    es: {
      label: 'Cadena de conexión a base de datos con credenciales',
      exploit:
        'Una cadena de conexión completa lleva dentro el host, el usuario y la contraseña de la base de datos — quien la lea puede conectarse directamente y leer o modificar la base entera.',
      why: 'Muévela a una variable de entorno del servidor y rota la credencial. No debe llegar nunca al cliente ni al repositorio.',
    },
    label: 'Database connection string with credentials',
    severity: 'critical',
    check: 1,
    cwe: 'CWE-798',
    regex:
      /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s:'"]+:[^\s@'"]+@[^\s/'"]+/gi,
    validate: (match) =>
      /:(your|password|pass|user)@/i.test(match) ? null : { snippet: mask(match) },
    exploit:
      'A full connection string embeds the database host, user and password — anyone reading it can connect directly and read or modify the entire database.',
    why: 'Move it to a server-side environment variable and rotate the credential. It must never reach the client or the repo.',
    references: [CWE_798],
  },
  {
    id: 'resend_key',
    es: {
      label: 'Clave de API de Resend',
      exploit:
        'Cualquiera puede enviar correo desde tu dominio verificado — phishing o spam a tu costa.',
      why: 'Rótala.',
    },
    label: 'Resend API key',
    severity: 'high',
    check: 2,
    cwe: 'CWE-798',
    regex: /\bre_[A-Za-z0-9_]{20,}\b/g,
    exploit: 'Anyone can send email from your verified domain — phishing or spam at your cost.',
    why: 'Rotate it.',
    references: [CWE_798],
  },
  {
    id: 'sendgrid_key',
    es: {
      label: 'Clave de API de SendGrid',
      exploit: 'Se puede enviar correo no autorizado desde tu cuenta de SendGrid.',
      why: 'Rótala.',
    },
    label: 'SendGrid API key',
    severity: 'high',
    check: 2,
    cwe: 'CWE-798',
    regex: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    exploit: 'Unauthorized email can be sent from your SendGrid account.',
    why: 'Rotate it.',
    references: [CWE_798],
  },
  {
    id: 'twilio_sid',
    es: {
      label: 'Account SID de Twilio',
      exploit:
        'Junto con su auth token, permite enviar SMS y hacer llamadas a tu costa. Confirma que el auth token no esté también expuesto.',
      why: 'Rota las credenciales y confirma que el auth token no esté también en el bundle.',
    },
    label: 'Twilio Account SID',
    severity: 'high',
    check: 2,
    cwe: 'CWE-798',
    regex: /\bAC[a-f0-9]{32}\b/g,
    exploit:
      'With its paired auth token, this can send SMS and place calls at your cost. Confirm the auth token is not also exposed.',
    why: 'Rotate credentials and confirm the auth token is not in the bundle too.',
    references: [CWE_798],
  },
  {
    id: 'private_key_block',
    es: {
      label: 'Bloque de clave privada (PEM)',
      exploit:
        'Una clave privada en el código del cliente se puede usar para suplantar tu servicio, descifrar tráfico o firmar en tu nombre.',
      why: 'Cualquier clave privada expuesta debe darse por comprometida y sustituirse.',
    },
    label: 'Private key block (PEM)',
    severity: 'critical',
    check: 3,
    cwe: 'CWE-321',
    regex: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    exploit:
      'A private key in client code can be used to impersonate your service, decrypt traffic or sign as you.',
    why: 'Any exposed private key must be treated as compromised and replaced.',
    references: ['https://cwe.mitre.org/data/definitions/321.html'],
  },
  {
    id: 'generic_secret_assign',
    es: {
      label: 'Asignación sospechosa de un secreto',
      exploit:
        'Si esto es un secreto real, cualquiera que lea el bundle puede usarlo directamente.',
      why: 'Revísalo: si es real, muévelo a una variable de entorno del servidor y rótalo. Un valor que tiene que llegar al navegador (por ejemplo una clave publicable) está bien — confirma que este no sea uno secreto.',
    },
    label: 'Suspicious secret assignment',
    severity: 'medium',
    check: 1,
    cwe: 'CWE-798',
    regex:
      /\b(api[_-]?key|secret[_-]?key|secret|password|passwd|token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*["'`][A-Za-z0-9_\-./+=]{16,}["'`]/gi,
    validate: (match) => {
      if (
        /your[_-]?|example|placeholder|xxxx|<.*>|\.\.\.|changeme|dummy|test[_-]?key/i.test(match)
      ) {
        return null;
      }
      // `apikey: "<anon key>"` is how every Supabase client is configured, and that key is
      // public by design. Asking someone to review a value this can prove is fine is noise,
      // and on the stack this tool exists for it was noise twice per app.
      const literal = /["'`]([^"'`]+)["'`]\s*$/.exec(match)?.[1];
      if (literal && isPublicByDesign(literal)) return null;
      return { snippet: mask(match) };
    },
    exploit: 'If this is a live secret, anyone reading the bundle can use it directly.',
    why: 'Review it: if real, move it to a server-side environment variable and rotate it. A value that must reach the browser (e.g. a publishable key) is fine — confirm this is not a secret one.',
    references: [CWE_798],
  },
];

function evidenceOf(raw: string, extra: Record<string, string>): string {
  return extra.snippet ?? extra.key ?? (extra.role ? `JWT role=${extra.role}` : mask(raw));
}

function buildFinding(
  pat: SecretPattern,
  raw: string,
  extra: Record<string, string>,
  source: string,
): Finding {
  return {
    id: pat.id,
    label: pat.label,
    severity: pat.severity,
    check: pat.check,
    cwe: pat.cwe,
    source,
    evidence: evidenceOf(raw, extra),
    exploit: pat.id === 'generic_secret_assign' ? pat.exploit : `${BUNDLE_EXPLOIT} ${pat.exploit}`,
    why: pat.why,
    references: pat.references,
    es: {
      label: pat.es.label,
      exploit:
        pat.id === 'generic_secret_assign'
          ? pat.es.exploit
          : `${BUNDLE_EXPLOIT_ES} ${pat.es.exploit}`,
      why: pat.es.why,
    },
  };
}

interface RawMatch {
  pat: SecretPattern;
  raw: string;
  index: number;
  extra: Record<string, string>;
}

/**
 * A static bearer token shipped to the browser.
 *
 * This needs its own pass because it cannot be found by matching a value. The token has no
 * vendor prefix and no recognisable shape — it is just hex — and after minification the
 * variable holding it is a single letter, so `generic_secret_assign` (which keys on names
 * like `api_key = "…"`) has nothing to grab either. Found in the wild as:
 *
 *     B="a852d372df4711967c81aa1c3b5629dfa12af8693eb67cd1"
 *     … fetch("/api/week", { headers: { Authorization: "Bearer ".concat(B) } })
 *
 * So the signal is the USE, not the value: a literal that ends up behind `Bearer`. A token
 * the client obtains — from a login, from storage, from an env var — is an identifier with no
 * literal assignment, and never matches.
 */
const BEARER_PATTERN: SecretPattern = {
  id: 'hardcoded_bearer',
  es: {
    label: 'Token bearer hardcodeado en el código del cliente',
    exploit:
      'El token está en un fichero que el sitio sirve a todo el mundo, así que todos los visitantes tienen la misma credencial. Cualquiera que abra la pestaña de red puede reutilizarlo contra las rutas de API que autoriza.',
    why: 'Un token bearer compilado en el bundle es un secreto compartido que se le entrega a cada visitante, y no se puede revocar para uno sin revocarlo para todos. Que dé acceso a algo depende de lo que haga el servidor con él — pero un token estático en código de cliente no es autenticación, y si es la única comprobación, la API es pública de hecho.',
  },
  label: 'Hardcoded bearer token in client code',
  severity: 'high',
  check: 1,
  cwe: 'CWE-798',
  // Never executed: this pass finds its own matches. Present so the shape stays uniform.
  regex: /(?!)/g,
  exploit:
    'The token is in a file the site serves to everyone, so every visitor holds the same credential. Anyone who opens the network tab can replay it against the API routes it authorises.',
  why: 'A bearer token compiled into the bundle is a shared secret handed to every visitor, and it cannot be revoked for one person without revoking it for all. Whether that grants access to anything depends on what the server does with it — but a static token in client code is not authentication, and if it is the only check, the API is effectively public.',
  references: [CWE_798, 'https://cwe.mitre.org/data/definitions/798.html'],
};

/** Obvious documentation stand-ins, so a README example is never reported as a live key. */
const PLACEHOLDER =
  /^(?:your|my|example|sample|test|demo|dummy|fake|changeme|replace|insert|token|abc|xxx)|(?:here|placeholder|token|key)$|\.\.\.|<|\$\{/i;

/** A JWT: three base64url segments, the first one a `{"alg"…` header. */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Enough variety to be a generated credential rather than a word or a repeated character. */
function looksGenerated(value: string): boolean {
  if (value.length < 20 || PLACEHOLDER.test(value)) return false;
  if (new Set(value).size < 8) return false;
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  // A dotted value is only credential-shaped when it is a JWT. The charset here has to allow
  // dots for that case, and allowing them let a namespaced library string through: a real
  // scan reported `Authorization: Bearer i18next.…` off a translation bundle, at high
  // severity, on somebody's production site. A token is one opaque run or it is a JWT.
  if (value.includes('.') && !JWT_SHAPE.test(value)) return false;
  return true;
}

/**
 * Credentials that are supposed to be in the browser, and are supposed to travel as a bearer
 * token. Reporting one is not a small inaccuracy: it is the single most common shape in the
 * exact ecosystem this tool exists for, so it would fire on almost every Supabase app anyone
 * pointed it at — and a scanner that cries about the documented, correct design is a scanner
 * people stop reading. Found by scanning real Lovable apps: two of eight shipped an anon JWT
 * behind `Authorization: Bearer`, exactly as Supabase's own client does.
 *
 * `service_role` is deliberately not here. That one bypasses RLS and is a critical finding of
 * its own, caught by `supabase_service_role`.
 */
function isPublicByDesign(value: string): boolean {
  if (/^sb_publishable_/.test(value)) return true;
  const role = decodeJwtRole(value);
  return role === 'anon' || role === 'authenticated';
}

function* matchBearerTokens(text: string): Generator<RawMatch> {
  const found = new Map<string, number>();

  // 1. The literal sitting inside the header string itself.
  const inline = /["'`]\s*Bearer\s+([A-Za-z0-9._~+/=-]{20,})\s*["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(text)) !== null) {
    const value = m[1]!;
    if (looksGenerated(value) && !isPublicByDesign(value) && !found.has(value)) {
      found.set(value, m.index);
    }
  }

  // 2. Minified: `"Bearer ".concat(B)`, `` `Bearer ${B}` `` or `"Bearer "+B`, with the literal
  //    assigned to B somewhere else in the file.
  const indirect = /["'`]Bearer\s*["'`]?\s*(?:\.concat\(|\+\s*|\$\{)\s*([A-Za-z_$][\w$]*)/g;
  while ((m = indirect.exec(text)) !== null) {
    const ident = m[1]!;
    const assign = new RegExp(`\\b${ident}\\s*[=:]\\s*["'\`]([A-Za-z0-9._~+/=-]{20,})["'\`]`, 'g');
    let a: RegExpExecArray | null;

    // Every candidate first, then a decision — never "report each one as it turns up".
    // A minified file reuses `B` for a dozen unrelated things, so taking each assignment on
    // sight reported whatever string happened to share the name: a real scan produced
    // `Authorization: Bearer i18n…` from a translation bundle. When more than one distinct
    // credential-shaped literal answers to the identifier, which one reaches the header is
    // unknowable from a regex, and the tie goes to saying nothing.
    const candidates = new Map<string, number>();
    while ((a = assign.exec(text)) !== null) {
      const value = a[1]!;
      if (looksGenerated(value) && !isPublicByDesign(value)) candidates.set(value, a.index);
    }
    if (candidates.size !== 1) continue;

    const [value, index] = [...candidates][0]!;
    if (!found.has(value)) found.set(value, index);
  }

  for (const [value, index] of found) {
    yield {
      pat: BEARER_PATTERN,
      raw: value,
      index,
      extra: { key: mask(value), snippet: `Authorization: Bearer ${mask(value)}` },
    };
  }
}

function* matchSecrets(text: string): Generator<RawMatch> {
  yield* matchBearerTokens(text);
  const seen = new Set<string>();
  for (const pat of SECRET_PATTERNS) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(text)) !== null) {
      const raw = m[0];
      let extra: Record<string, string> = {};
      if (pat.validate) {
        const v = pat.validate(raw);
        if (!v) continue;
        extra = v;
      }
      const key = `${pat.id}:${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      yield { pat, raw, index: m.index, extra };
    }
  }
}

/**
 * Secrets across a set of crawled pages, deduped against what an earlier pass already found.
 *
 * Exists because the URL scanner used to run the secret scanner on the home page and the
 * external bundles only — a crawled secondary page was mined for meta tags and nothing else.
 * On a site whose marketing lives on `/` and whose actual application lives on `app.html`,
 * that meant the code was never scanned. Dedup is by id+evidence, so the same key appearing
 * on several pages is reported once rather than once per page.
 */
export function scanCrawledPages(
  pages: { url: string; html: string }[],
  skipUrls: Iterable<string>,
  alreadyFound: Finding[],
): Finding[] {
  const skip = new Set(skipUrls);
  const seen = new Set(alreadyFound.map((f) => `${f.id}:${f.evidence ?? ''}`));
  const out: Finding[] = [];
  for (const page of pages) {
    if (skip.has(page.url)) continue;
    for (const f of scanText(page.html, page.url)) {
      const key = `${f.id}:${f.evidence ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/** Scans a fetched bundle; source is the bundle URL. */
export function scanText(text: string, sourceUrl: string): Finding[] {
  const out: Finding[] = [];
  for (const { pat, raw, extra } of matchSecrets(text)) {
    out.push(buildFinding(pat, raw, extra, sourceUrl));
  }
  return out;
}

/** Scans a local source file; source is `relPath:line` for exact context. */
export function scanSource(text: string, relPath: string): Finding[] {
  const out: Finding[] = [];
  for (const { pat, raw, index, extra } of matchSecrets(text)) {
    const line = text.slice(0, index).split('\n').length;
    out.push(buildFinding(pat, raw, extra, `${relPath}:${line}`));
  }
  return out;
}

/**
 * Scans data returned by an open API (e.g. a readable table row) for live third-party
 * secrets users pasted into content — the Moltbook pattern (OpenAI keys inside DMs).
 * The framing differs from a bundle leak: the secret is in world-readable data.
 */
export function scanReturnedData(text: string, source: string): Finding[] {
  const out: Finding[] = [];
  for (const { pat, raw, extra } of matchSecrets(text)) {
    if (pat.id === 'generic_secret_assign') continue; // too noisy against arbitrary row JSON
    out.push({
      id: `data_${pat.id}`,
      label: `${pat.label.replace(/ in the client$/, '')} exposed in readable data`,
      severity: pat.severity,
      check: pat.check,
      cwe: pat.cwe,
      source,
      evidence: evidenceOf(raw, extra),
      exploit: `A live secret sits in a database row readable without authentication. ${pat.exploit}`,
      why: 'World-readable user content contains a real third-party secret, so the breach extends to that provider. Redact secrets server-side and rotate the exposed one.',
      references: pat.references,
      es: {
        label: `${pat.es.label.replace(/ en el cliente$/, '')} expuesto en datos legibles`,
        exploit: `Hay un secreto real en una fila de base de datos legible sin autenticación. ${pat.es.exploit}`,
        why: 'Contenido de usuario legible por todo el mundo contiene un secreto real de un tercero, así que la brecha se extiende a ese proveedor. Redacta los secretos en el servidor y rota el que quedó expuesto.',
      },
    });
  }
  return out;
}

/** Extracts the public Supabase project URL and a probe key (anon JWT / publishable / secret). */
export function extractSupabaseConfig(text: string): SupabaseConfig | null {
  const urlMatch = text.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/);
  if (!urlMatch) return null;
  const projectUrl = `https://${urlMatch[1]}.supabase.co`;

  // Prefer an anon JWT; fall back to the new-format publishable key; then secret.
  const jwtRe = new RegExp(JWT_RE.source, 'g');
  let jm: RegExpExecArray | null;
  while ((jm = jwtRe.exec(text)) !== null) {
    if (decodeJwtRole(jm[0]) === 'anon') {
      return { projectUrl, anonKey: jm[0], keyKind: 'anon-jwt' };
    }
  }
  const pub = text.match(SB_PUBLISHABLE_RE);
  if (pub) return { projectUrl, anonKey: pub[0], keyKind: 'publishable' };
  const sec = text.match(SB_SECRET_RE);
  if (sec) return { projectUrl, anonKey: sec[0], keyKind: 'secret' };
  return { projectUrl, anonKey: null };
}
