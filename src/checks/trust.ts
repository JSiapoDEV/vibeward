// Lovable's Trust center, read and set beside what this scan found.
//
// A Lovable app can publish `/.well-known/trust.json`: the security checks Lovable verified on
// the live deployment, "for software to read". vibeward is software, and a reader of this
// report is exactly the person who will be shown that page by the app's owner. So the scan
// reads it, and says where the two agree and where they do not.
//
// The useful part is the contrast, not the echo. Lovable's checks are about how the app is
// served — HTTPS, HSTS, dependencies — and only list what passed; a missing check is no claim,
// not a failure. A Supabase table anyone can read passes every one of them. When this scan read
// such a table, the report has to say so next to the trust page, or the trust page reads as
// the answer to a question it never asked.
//
// One GET to a public path on the target, the same request any procurement tool makes, so it
// runs in passive mode too. The shape below is the one Lovable served in November 2026
// (`version: 2`, `claims.controls[].id`); anything else is ignored rather than guessed at.

import { coverage, type CoverageLine } from '../core/i18n.js';
import type { Finding } from '../core/types.js';
import type { RlsResult } from './supabase.js';

export interface TrustCenter {
  /** The page for people, which is what an owner shares. */
  pageUrl: string;
  /** Ids of the checks Lovable says pass, as published. */
  controls: string[];
  checkedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The document, or null when it is not one Lovable would serve. */
export function parseTrustCenter(
  raw: string,
  origin: string,
  now = Date.now(),
): TrustCenter | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(doc);
  const claims = asRecord(root?.claims);
  if (!root || !claims || typeof root.version !== 'number' || !Array.isArray(claims.controls)) {
    return null;
  }
  // Only what the platform generated. An app can serve any JSON it likes from its own code;
  // Lovable marks its own document, and a hand-written one is not a trust center.
  if (asRecord(root.verification)?.platform_generated !== true) return null;

  const controls = claims.controls
    .map((c) => asRecord(c)?.id)
    .filter((id): id is string => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id));
  const expiresAt = typeof claims.expires_at === 'string' ? claims.expires_at : null;
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  return {
    pageUrl: `${origin}/.well-known/trust.html`,
    controls,
    checkedAt: typeof claims.checked_at === 'string' ? claims.checked_at : null,
    expiresAt,
    expired: Number.isFinite(expiry) && expiry < now,
  };
}

/** Each published check vibeward also measures, and the findings that would contradict it. */
const OVERLAP: { control: RegExp; findings: RegExp; en: string; es: string }[] = [
  {
    control: /^https_redirect$/,
    findings: /^plain_http_no_redirect$/,
    en: 'HTTP → HTTPS redirect',
    es: 'la redirección de HTTP a HTTPS',
  },
  {
    control: /^hsts$/,
    findings: /^missing_header_strict-transport-security$/,
    en: 'HSTS',
    es: 'HSTS',
  },
  {
    control: /^content_type_options$/,
    findings: /^missing_header_x-content-type-options$/,
    en: 'X-Content-Type-Options',
    es: 'X-Content-Type-Options',
  },
  {
    control: /^mixed_content$/,
    findings: /^(?:mixed_content_active|insecure_form_action)$/,
    en: 'no insecure resources',
    es: 'que no haya recursos inseguros',
  },
  {
    control: /cookie/,
    findings: /^cookie_session_/,
    en: 'secure cookies',
    es: 'las cookies seguras',
  },
  {
    control: /^(?:csp|content_security_policy)$/,
    findings: /^missing_header_content-security-policy$/,
    en: 'Content-Security-Policy',
    es: 'Content-Security-Policy',
  },
];

/** Anything Lovable publishes about the database. Its ids for that were not public yet. */
const DATABASE_CONTROL = /rls|row_level|database|db_access/i;

/**
 * Where this scan and the trust page meet, as plain sentences for the report. Never a finding:
 * a disagreement is about evidence, and the evidence — the readable table, the missing header —
 * is already a finding of its own with its own severity.
 */
export function contrastTrustCenter(
  tc: TrustCenter,
  findings: Finding[],
  rls: RlsResult | null,
): CoverageLine[] {
  const lines: CoverageLine[] = [];
  if (tc.expired) {
    lines.push(
      coverage(
        `The document expired at ${tc.expiresAt}: its checks are stale, which by Lovable's own definition is not the same as failed.`,
        `El documento venció el ${tc.expiresAt}: sus comprobaciones están desactualizadas, que según la propia Lovable no es lo mismo que fallidas.`,
      ),
    );
  }

  for (const o of OVERLAP) {
    if (!tc.controls.some((c) => o.control.test(c))) continue;
    if (!findings.some((f) => o.findings.test(f.id))) continue;
    lines.push(
      coverage(
        `Lovable lists ${o.en} as passing; this scan found otherwise (see the findings). Lovable checks the first page; this scan may have read others, or the app changed since.`,
        `Lovable da por cumplido ${o.es}; este escaneo encontró lo contrario (mira los hallazgos). Lovable revisa la primera página; este escaneo pudo leer otras, o la app cambió desde entonces.`,
      ),
    );
  }

  const readable = rls?.exposedCount ?? 0;
  const dbClaim = tc.controls.some((c) => DATABASE_CONTROL.test(c));
  if (readable > 0 && dbClaim) {
    lines.push(
      coverage(
        `Lovable lists a database protection as passing, and this scan still read rows from ${readable} table(s) without signing in. Row-level security being on is not the same as nobody reading the data: a policy that is always true passes that check and lets everyone in.`,
        `Lovable da por cumplida una protección de la base de datos, y aun así este escaneo leyó filas de ${readable} tabla(s) sin iniciar sesión. Que la seguridad por filas esté activada no es lo mismo que nadie lea los datos: una política que siempre es verdadera pasa esa comprobación y deja entrar a cualquiera.`,
      ),
    );
  } else if (readable > 0) {
    lines.push(
      coverage(
        `The trust page makes no claim about the database — an omitted check is no claim, not a pass — and this scan read rows from ${readable} table(s) without signing in.`,
        `La página de confianza no afirma nada sobre la base de datos (un control omitido no es una afirmación, ni un aprobado), y este escaneo leyó filas de ${readable} tabla(s) sin iniciar sesión.`,
      ),
    );
  }

  if (lines.length === 0) {
    lines.push(
      coverage(
        `Nothing in this scan contradicts the ${tc.controls.length} check(s) it lists. They cover how the app is served — HTTPS, headers, dependencies — not who can read its data.`,
        `Nada en este escaneo contradice los ${tc.controls.length} control(es) que publica. Cubren cómo se sirve la app (HTTPS, cabeceras, dependencias), no quién puede leer sus datos.`,
      ),
    );
  }
  return lines;
}
