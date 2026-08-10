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
}

const CWE_798 = 'https://cwe.mitre.org/data/definitions/798.html';
const BUNDLE_EXPLOIT =
  'The key ships in the client JavaScript, so anyone can open the page source, copy it, and call the provider as you — no authentication needed.';

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
    label: 'Stripe secret / restricted key',
    severity: 'critical',
    check: 2,
    cwe: 'CWE-798',
    regex: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/g,
    exploit:
      'With this key an attacker can create charges, issue refunds to their own cards and read your customer and payment records via the Stripe API.',
    why: 'A leaked Stripe secret key can drain money and expose payment data. It must never leave the server. Rotate it immediately.',
    references: [CWE_798, 'https://stripe.com/docs/keys'],
  },
  {
    id: 'openai_key',
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
  };
}

interface RawMatch {
  pat: SecretPattern;
  raw: string;
  index: number;
  extra: Record<string, string>;
}

function* matchSecrets(text: string): Generator<RawMatch> {
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
