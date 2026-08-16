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

const SPREADSHEET = /exceljs|\bxlsx\b|sheetjs|csv-stringify|papaparse|json2csv/i;
const SHEET_WRITE =
  /\.addRow\s*\(|\.addRows\s*\(|aoa_to_sheet|json_to_sheet|writeBuffer|stringify\s*\(/;
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
        'Aquí se ejecuta un create/update/delete, pero no se encontró ninguna guarda de autorización (requireUser/getServerSession/auth…) en el fichero.',
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

/** A spreadsheet/CSV export that writes user data without neutralizing formula prefixes. */
export function checkExportFormulaInjection(path: string, content: string): Finding | null {
  if (!SPREADSHEET.test(content) || !SHEET_WRITE.test(content)) return null;
  if (FORMULA_SANITIZED.test(content)) return null;
  return {
    id: `formula_injection_${path.replace(/[^A-Za-z0-9]/g, '_')}`,
    es: {
      label: 'La exportación a hoja de cálculo/CSV puede permitir inyección de fórmulas',
      evidence:
        'Se escriben campos controlados por el usuario en una hoja de cálculo o CSV sin sanear el prefijo de fórmula.',
      exploit:
        'Un usuario guarda `=HYPERLINK(...)` o `=cmd|...` en un campo de texto; cuando alguien abre el fichero exportado, la hoja de cálculo lo ejecuta como fórmula (exfiltración de datos / DDE).',
      why: 'Antepón una comilla simple a cualquier valor de celda que empiece por `= + - @` (o por tabulador o retorno de carro) antes de escribirlo.',
    },
    label: 'Spreadsheet/CSV export may allow formula injection',
    severity: 'medium',
    check: 16,
    cwe: 'CWE-1236',
    source: path,
    evidence:
      'User-controlled fields are written to a spreadsheet/CSV with no formula-prefix sanitization.',
    exploit:
      'A user stores `=HYPERLINK(...)` / `=cmd|...` in a text field; when someone opens the exported file, the spreadsheet runs it as a formula (data exfiltration / DDE).',
    why: 'Prefix any cell value starting with `= + - @` (or a tab/CR) with a single quote before writing it.',
    references: [
      'https://cwe.mitre.org/data/definitions/1236.html',
      'https://owasp.org/www-community/attacks/CSV_Injection',
    ],
  };
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
