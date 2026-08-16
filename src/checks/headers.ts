import type { Finding, FindingES, Severity } from '../core/types.js';

interface ExpectedHeader {
  header: string;
  label: string;
  severity: Severity;
  check: number;
  cwe: string;
  why: string;
  exploit: string;
  references: string[];
  /** Spanish prose for `--lang es`. `label` is the header name, so it is composed below. */
  es: { label: string; why: string; exploit: string };
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
    es: {
      label: 'Content-Security-Policy',
      exploit:
        'Sin CSP, un script inyectado o de terceros puede cargarse y ejecutarse desde cualquier origen, y sacar de ahí tokens o datos de usuarios.',
      why: 'Falta la principal defensa en profundidad contra el cross-site scripting.',
    },
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
    es: {
      label: 'Strict-Transport-Security (HSTS)',
      exploit:
        'Un atacante en la ruta de red puede forzar a la víctima a HTTP plano en la primera petición e interceptar credenciales o cookies de sesión.',
      why: 'HTTPS no queda fijado para las visitas siguientes, así que el navegador está dispuesto a volver a probar HTTP plano la próxima vez. La cabecera le dice que no lo haga nunca durante un plazo declarado — `Strict-Transport-Security: max-age=63072000; includeSubDomains` es el valor habitual, y va en el CDN o en el servidor, no en la página.',
    },
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
    es: {
      label: 'X-Frame-Options',
      exploit:
        'La aplicación se puede incrustar en un iframe oculto dentro de una página maliciosa para que el usuario pulse acciones sin saberlo (clickjacking).',
      why: 'No hay protección contra el enmarcado (también se puede fijar con `frame-ancestors` en la CSP).',
    },
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
    es: {
      label: 'X-Content-Type-Options',
      exploit:
        'El navegador puede deducir por los bytes un tipo distinto del declarado (MIME sniffing), lo que habilita algunos ataques de ejecución de scripts.',
      why: 'Sin `X-Content-Type-Options: nosniff` el navegador puede desconfiar del Content-Type declarado y tratar un fichero como lo que parezcan sus bytes. El caso clásico es una imagen subida que además se interpreta como script. Es una cabecera con un valor y sin contrapartidas.',
    },
  },
];

const LEAKY_HEADERS = ['x-powered-by', 'server'];

export function checkHeaders(headers: Headers): Finding[] {
  const findings: Finding[] = [];

  for (const e of EXPECTED) {
    if (!headers.get(e.header)) {
      const es: FindingES = {
        label: `Falta la cabecera ${e.es.label}`,
        evidence: 'Ausente en la respuesta',
        exploit: e.es.exploit,
        why: e.es.why,
      };
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
        es,
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
        es: {
          label: `La cabecera ${h} revela la tecnología`,
          exploit:
            'Revelar el framework o el servidor y su versión permite a un atacante buscar CVEs conocidos de ese stack exacto.',
          why: 'Fuga de información — oculta la cabecera en tu hosting o en tu framework.',
        },
      });
    }
  }

  return findings;
}
