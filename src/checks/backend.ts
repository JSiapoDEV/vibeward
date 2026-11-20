import type { Finding } from '../core/types.js';

// Server-side checks for the "framework + ORM" archetype (Next.js/Prisma/Drizzle),
// where the real risk is authorization logic, not an exposed database. These are
// heuristics over source text — higher-signal than nothing, but framed as review items.

const NEXT_CONFIG = /(^|\/)next\.config\.(js|ts|mjs|cjs)$/;
const SERVER_ACTION = /["']use server["']/;
const ROUTE_HANDLER = /(^|\/)route\.(t|j)sx?$/;

const MUTATION =
  /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\b(insert|update|delete)\s+(into\s+)?["'`\w]/i;
const AUTH_GUARD =
  /require(User|Role|Auth|Admin|Session)|getServerSession|\bgetSession\b|\bauth\s*\(\)|currentUser|verifySession|\bgetUser\s*\(|assertAuth|checkAuth|authorize|isAuthenticated|ensureUser/i;

const FORMULA_SANITIZED = /formula|\\t|\bsanitiz|['"`]'\s*\+|replace\(\s*\/\^\[=/i;

/** Next.js config that ships no security headers → clickjacking + no XSS defense-in-depth. */
export function checkNextConfigHeaders(path: string, content: string): Finding | null {
  if (!NEXT_CONFIG.test(path)) return null;
  const hasHeaders =
    /headers\s*\(/.test(content) ||
    /(content-security-policy|x-frame-options|strict-transport-security)/i.test(content);
  if (hasHeaders) return null;
  return {
    id: 'nextjs_no_security_headers',
    es: {
      label: 'Next.js no envía cabeceras de seguridad',
      evidence: 'next.config no tiene `headers()` ni declara CSP/X-Frame-Options.',
      exploit:
        'Sin cabeceras de seguridad la app se puede enmarcar para clickjacking, no tiene CSP que amortigüe un XSS ni HSTS que fije HTTPS.',
      why: 'Añade un `headers()` asíncrono en next.config que devuelva CSP, HSTS, X-Frame-Options, X-Content-Type-Options y Referrer-Policy.',
    },
    label: 'Next.js ships no security headers',
    severity: 'medium',
    check: 22,
    cwe: 'CWE-693',
    source: path,
    evidence: 'next.config has no `headers()` and no CSP/X-Frame-Options declaration.',
    exploit:
      'With no security headers the app can be framed for clickjacking, has no CSP to blunt XSS, and no HSTS to pin HTTPS.',
    why: 'Add an async `headers()` in next.config returning CSP, HSTS, X-Frame-Options, X-Content-Type-Options and Referrer-Policy.',
    references: [
      'https://nextjs.org/docs/app/api-reference/config/next-config-js/headers',
      'https://cwe.mitre.org/data/definitions/693.html',
    ],
  };
}

/** A server action / route handler that mutates data without any detectable auth guard. */
export function checkServerActionAuth(path: string, content: string): Finding | null {
  const isServerSide = SERVER_ACTION.test(content) || ROUTE_HANDLER.test(path);
  if (!isServerSide) return null;
  if (!MUTATION.test(content)) return null;
  if (AUTH_GUARD.test(content)) return null;
  return {
    id: `unguarded_mutation_${path.replace(/[^A-Za-z0-9]/g, '_')}`,
    es: {
      label: 'Una server action o ruta modifica datos sin comprobación de autorización detectable',
      evidence:
        'Aquí se ejecuta un create/update/delete, pero no se encontró ninguna guarda de autorización (requireUser/getServerSession/auth…) en el archivo.',
      exploit:
        'Si la mutación es alcanzable sin una comprobación de autorización en el servidor, cualquier visitante puede dispararla — la comprobación en middleware o por cookie no basta (puede ser optimista o esquivable).',
      why: 'Toda server action y todo route handler que escriba datos tiene que verificar en el servidor la identidad y el rol de quien llama. Comprueba que este proteja la mutación (o que sea público a propósito).',
    },
    label: 'Server action / route mutates data without a detectable auth check',
    severity: 'high',
    check: 11,
    cwe: 'CWE-862',
    source: path,
    evidence:
      'A create/update/delete runs here, but no auth guard (requireUser/getServerSession/auth…) was found in the file.',
    exploit:
      'If the mutation is reachable without a server-side authorization check, any visitor can trigger it — the middleware/cookie check is not enough (it can be optimistic or bypassed).',
    why: 'Every server action and route handler that writes data must assert the caller’s identity and role on the server. Verify this one guards the mutation (or is intentionally public).',
    references: ['https://cwe.mitre.org/data/definitions/862.html'],
  };
}

/**
 * CSV writers: a library, or the hand-rolled escaper every project ends up writing — the one
 * that doubles quotes. That doubling is the signature: it is CSV quoting, and quoting is not
 * formula neutralisation.
 *
 * Spreadsheet libraries (exceljs, SheetJS) are not on this list. A string written to a cell is
 * stored as text there, never evaluated; it was flagged, and it sent people to fix the export
 * that was already safe.
 */
const CSV_LIBRARY = /csv-stringify|papaparse|\bunparse\s*\(|json2csv|fast-csv|@fast-csv/i;
const CSV_QUOTE_DOUBLING =
  /\.replace(?:All)?\(\s*(?:\/"\/g|['"`]"['"`])\s*,\s*(?:'""'|`""`|"\\"\\"")\s*\)/;

/** A CSV export that writes user text without neutralising formula prefixes. */
export function checkExportFormulaInjection(path: string, content: string): Finding | null {
  const writer = CSV_QUOTE_DOUBLING.exec(content) ?? CSV_LIBRARY.exec(content);
  if (!writer) return null;
  if (FORMULA_SANITIZED.test(content)) return null;
  const line = content.slice(0, writer.index).split('\n').length;
  // Said only where it applies: a CSV helper that has nothing to do with exceljs does not need
  // to hear that its .xlsx export is fine.
  const xlsx = /exceljs/i.test(content);
  const finding: Finding = {
    id: `formula_injection_${path.replace(/[^A-Za-z0-9]/g, '_')}`,
    es: {
      label: 'La exportación a CSV puede permitir inyección de fórmulas',
      evidence:
        'Las celdas se citan (comas y comillas) pero nada neutraliza una celda de texto que empieza por `=`, `+`, `-` o `@`.',
      exploit:
        'Alguien guarda `=HYPERLINK(...)` en un campo de texto; quien abra el CSV en Excel o Google Sheets ve una fórmula que se ejecuta. Si otra persona puede escribir datos que terminan en tu exportación, el ataque es contra ti.',
      why: 'Neutraliza solo las celdas de texto: si un texto empieza por `=`, `+`, `-`, `@`, tabulador o retorno de carro, antepón una comilla simple. Deja los números como números: anteponerla a un monto negativo lo convierte en texto.',
    },
    label: 'CSV export may allow formula injection',
    severity: 'medium',
    check: 16,
    cwe: 'CWE-1236',
    source: `${path}:${line}`,
    evidence:
      'Cells are quoted (commas and quotes) but nothing neutralises a text cell that starts with `=`, `+`, `-` or `@`.',
    exploit:
      'Someone stores `=HYPERLINK(...)` in a text field; whoever opens the CSV in Excel or Google Sheets gets a formula that runs. If another person can write data that ends up in your export, the attack is on you.',
    why: 'Neutralise text cells only: when a string starts with `=`, `+`, `-`, `@`, a tab or a carriage return, put a single quote in front. Leave numbers as numbers — prefixing a negative amount turns it into text.',
    references: [
      'https://cwe.mitre.org/data/definitions/1236.html',
      'https://owasp.org/www-community/attacks/CSV_Injection',
    ],
  };
  if (xlsx) {
    finding.why += ' The .xlsx written with exceljs in this file already stores text as text.';
    if (finding.es?.why) {
      finding.es.why +=
        ' El .xlsx que este archivo escribe con exceljs ya guarda el texto como texto.';
    }
  }
  return finding;
}

/** Runs every backend check against one source file. */
export function scanBackendFile(path: string, content: string): Finding[] {
  const out: Finding[] = [];
  const hdr = checkNextConfigHeaders(path, content);
  if (hdr) out.push(hdr);
  const auth = checkServerActionAuth(path, content);
  if (auth) out.push(auth);
  const fi = checkExportFormulaInjection(path, content);
  if (fi) out.push(fi);
  return out;
}
