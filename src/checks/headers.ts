import type { Finding, Severity } from '../core/types.js';

interface ExpectedHeader {
  header: string;
  label: string;
  severity: Severity;
  check: number;
  cwe: string;
  why: string;
  exploit: string;
  references: string[];
}

const EXPECTED: ExpectedHeader[] = [
  {
    header: 'content-security-policy',
    label: 'Content-Security-Policy',
    severity: 'medium',
    check: 22,
    cwe: 'CWE-693',
    exploit:
      'Without a CSP, an injected or third-party script can load and run from any origin, exfiltrating tokens or user data.',
    why: 'The main defense-in-depth against cross-site scripting is missing.',
    references: [
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP',
      'https://cwe.mitre.org/data/definitions/693.html',
    ],
  },
  {
    header: 'strict-transport-security',
    label: 'Strict-Transport-Security (HSTS)',
    severity: 'low',
    check: 22,
    cwe: 'CWE-319',
    exploit:
      'An on-path attacker can force a victim onto plain HTTP on the first request and intercept credentials or session cookies.',
    why: 'HTTPS is not pinned for future visits, so the browser is willing to try plain HTTP again next time. The header tells it never to, for a stated period — `Strict-Transport-Security: max-age=63072000; includeSubDomains` is the usual setting, and it belongs on the CDN or the server, not in the page.',
    references: [
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security',
    ],
  },
  {
    header: 'x-frame-options',
    label: 'X-Frame-Options',
    severity: 'low',
    check: 22,
    cwe: 'CWE-1021',
    exploit:
      'The app can be embedded in a hidden iframe on a malicious page to trick users into clicking actions (clickjacking).',
    why: 'No framing protection (also settable via CSP frame-ancestors).',
    references: ['https://cwe.mitre.org/data/definitions/1021.html'],
  },
  {
    header: 'x-content-type-options',
    label: 'X-Content-Type-Options',
    severity: 'low',
    check: 22,
    cwe: 'CWE-430',
    exploit:
      'The browser may MIME-sniff a response as a different type than declared, enabling some script-execution attacks.',
    why: 'Without `X-Content-Type-Options: nosniff` the browser is allowed to second-guess the declared Content-Type and treat a file as whatever its bytes look like. An uploaded image that happens to parse as script is the classic case. It is one header with one value and no trade-offs.',
    references: [
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options',
    ],
  },
];

const LEAKY_HEADERS = ['x-powered-by', 'server'];

export function checkHeaders(headers: Headers): Finding[] {
  const findings: Finding[] = [];

  for (const e of EXPECTED) {
    if (!headers.get(e.header)) {
      findings.push({
        id: `missing_header_${e.header}`,
        label: `Missing ${e.label} header`,
        severity: e.severity,
        check: e.check,
        cwe: e.cwe,
        evidence: 'Absent from the response',
        exploit: e.exploit,
        why: e.why,
        references: e.references,
      });
    }
  }

  for (const h of LEAKY_HEADERS) {
    const v = headers.get(h);
    if (v && !/^(cloudflare|vercel)$/i.test(v)) {
      findings.push({
        id: `leaky_header_${h}`,
        label: `${h} header reveals technology`,
        severity: 'low',
        check: 23,
        cwe: 'CWE-200',
        evidence: `${h}: ${v}`,
        exploit:
          'Revealing the framework/server and its version lets an attacker look up known CVEs for that exact stack.',
        why: 'Information disclosure — hide the header at your host or framework.',
        references: ['https://cwe.mitre.org/data/definitions/200.html'],
      });
    }
  }

  return findings;
}
