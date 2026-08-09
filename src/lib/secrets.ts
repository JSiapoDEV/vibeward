import type { Finding, Severity, SupabaseConfig } from './types.js';

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

function buildFinding(
  pat: SecretPattern,
  raw: string,
  extra: Record<string, string>,
  source: string,
): Finding {
  const evidence =
    extra.snippet ?? extra.key ?? (extra.role ? `JWT role=${extra.role}` : mask(raw));
  return {
    id: pat.id,
    label: pat.label,
    severity: pat.severity,
    check: pat.check,
    cwe: pat.cwe,
    source,
    evidence,
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

/** Extracts the public Supabase project URL and anon key so RLS can be probed later. */
export function extractSupabaseConfig(text: string): SupabaseConfig | null {
  const urlMatch = text.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/);
  if (!urlMatch) return null;

  const projectUrl = `https://${urlMatch[1]}.supabase.co`;
  let anonKey: string | null = null;
  const jwtRe = new RegExp(JWT_RE.source, 'g');
  let jm: RegExpExecArray | null;
  while ((jm = jwtRe.exec(text)) !== null) {
    if (decodeJwtRole(jm[0]) === 'anon') {
      anonKey = jm[0];
      break;
    }
  }
  return { projectUrl, anonKey };
}
