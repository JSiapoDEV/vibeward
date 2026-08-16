import type { Lang } from '../core/i18n.js';
import type { Severity } from '../core/types.js';

/**
 * Every word of the report scaffolding, in each language vibeward writes reports in.
 *
 * A dictionary rather than two report builders: the structure of the document is the part
 * that must not drift between languages, and duplicating `buildReport` guarantees that it
 * eventually does. `Record<Lang, ReportStrings>` also makes an untranslated string a
 * compile error rather than a mixed-language paragraph someone notices in a client's inbox.
 *
 * The prose of the findings themselves is not here — it lives next to the check that emits
 * it, in the finding's `es` overlay, because that is where the counts and the interpolation
 * are.
 */
export interface ReportStrings {
  title: (hasWeb: boolean) => string;
  application: string;
  date: string;
  scope: (hasWeb: boolean, active: boolean) => string;

  executiveSummary: string;
  severityTableHead: string;
  sev: Record<Severity, string>;
  sevHeading: Record<Severity, string>;
  webSev: Record<Severity, string>;
  verdict: Record<'critical' | 'high' | 'medium' | 'clean', string>;
  criticalCallout: (n: number) => string;
  webAside: (n: number) => string;
  suppressionBanner: (n: number, config: string) => string;

  dbTitle: string;
  dbHowEnumerated: (n: number) => string;
  dbHowCommon: (n: number) => string;
  dbExposedIntro: (how: string, n: number) => string;
  dbTableHead: string;
  dbWriteYes: string;
  dbWriteNo: string;
  dbPiiNote: (n: number) => string;
  dbWritableNote: (n: number) => string;
  dbHowToClose: string;
  dbNoneExposed: (how: string) => string;

  detailedFindings: string;
  noFindings: string;
  fClassification: string;
  fWhere: string;
  fEvidence: string;
  fExploit: string;
  fImpact: string;
  fWhy: string;
  fReferences: string;
  fPages: string;
  fChecklist: (n: number) => string;

  webTitle: string;
  webBlurb: string;
  fingerprint: (score: number, total: number) => string;
  stackDetected: string;
  stackOn: string;
  checksPassed: (passed: number, total: number) => string;
  suppressedInline: (n: number, config: string) => string;
  webTableHead: string;
  statusOk: string;
  statusFail: string;
  statusNotApplicable: string;
  statusNotEvaluated: string;
  statusSuppressed: string;
  suppressedTitle: (n: number) => string;
  suppressedBlurb: (config: string) => string;
  suppressedTableHead: string;
  webFindingsTitle: string;
  noBrowser: string;

  coverageTitle: string;
  coverageBlurb: string;
  verifiedAutomatically: string;
  playwrightNote: string;
  nextStepsTitle: string;
  nextStepsCritical: string;
  nextStepsNormal: string;
  initHint: string;
  footer: (version: string) => string;
}

const EN: ReportStrings = {
  title: (hasWeb) => (hasWeb ? 'Audit Report' : 'Security Audit Report'),
  application: 'Application',
  date: 'Date',
  scope: (hasWeb, active) =>
    `${active ? 'Automated, non-destructive' : 'Automated, read-only'} analysis of the public frontend and data API${
      hasWeb ? ', plus website quality and AI visibility' : ''
    }. Does not include manual penetration testing or server-side code review.`,

  executiveSummary: 'Executive summary',
  severityTableHead: '| Severity | Findings |\n|---|---|',
  sev: { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '⚪ Low' },
  sevHeading: { critical: '🔴 CRITICAL', high: '🟠 HIGH', medium: '🟡 MEDIUM', low: '⚪ LOW' },
  webSev: {
    critical: '🔴 High impact',
    high: '🔴 High impact',
    medium: '🟡 Medium impact',
    low: '⚪ Low impact',
  },
  verdict: {
    critical: 'NOT PRODUCTION-READY — critical issues expose data or credentials.',
    high: 'NEEDS URGENT ATTENTION before staying in production.',
    medium: 'ACCEPTABLE with recommended improvements.',
    clean: 'No critical findings in the automated scope.',
  },
  criticalCallout: (n) =>
    `**${n} critical issue(s)** detected. A critical issue means that, right now, an unauthorized person could read private user data or use credentials that cost you money. Fix these before anything else.`,
  webAside: (n) =>
    `Separately, **${n} website quality issue(s)** were found — see the section below. They do not affect the security verdict.`,
  suppressionBanner: (n, config) =>
    `> ⚠️ **This report was produced with ${n} suppression(s) in effect**, declared in \`${config}\`. Each one is listed with its reason in the website section. Security findings can never be suppressed.`,

  dbTitle: 'Database exposure',
  dbHowEnumerated: (n) => `${n} table(s) enumerated live from the data API (plus common names)`,
  dbHowCommon: (n) => `${n} common table names`,
  dbExposedIntro: (how, n) =>
    `Access to **${how}** was probed using only the public key. **${n} table(s) returned data** — Row Level Security is missing or misconfigured and any visitor can read their contents.`,
  dbTableHead: '| Table | Total rows | Sensitive columns exposed | Writable |\n|---|---|---|---|',
  dbWriteYes: '🔴 yes',
  dbWriteNo: 'no',
  dbPiiNote: (n) =>
    `> ⚠️ **${n} of those tables contain personal data** (emails, phones, names or others). This is an active data leak.`,
  dbWritableNote: (n) =>
    `> 🔴 **${n} table(s) also accept unauthenticated writes** — anyone can tamper with the data, not just read it.`,
  dbHowToClose:
    '**What this takes to close:** enable RLS on every table (`ALTER TABLE x ENABLE ROW LEVEL SECURITY;`) and write policies that filter by `auth.uid()`, not `true`. Treat the data as already read: rotate any credential that was reachable, and decide whether this needs disclosing.',
  dbNoneExposed: (how) =>
    `${how} were probed with the public key. None returned data: **RLS appears active** on the probed tables. Note: this does not prove every table is protected, only the ones reached.`,

  detailedFindings: 'Detailed findings',
  noFindings:
    'No exposed secrets or missing headers were detected in the automated analysis. A manual server-side review is still recommended.',
  fClassification: 'Classification',
  fWhere: 'Where',
  fEvidence: 'Evidence',
  fExploit: "How it's exploited",
  fImpact: 'Impact',
  fWhy: 'Why it matters',
  fReferences: 'References',
  fPages: 'Pages',
  fChecklist: (n) => `_Checklist item ${n}._`,

  webTitle: 'Website quality & AI visibility',
  webBlurb:
    '> These findings **do not** affect the security verdict or the exit code. They cover how this site is read by search engines, social platforms and AI assistants.',
  fingerprint: (score, total) => `**Vibe-coded fingerprint: ${score}/${total}**`,
  stackDetected: 'Stack detected',
  stackOn: ' on ',
  checksPassed: (passed, total) => `**${passed} of ${total} checks passed.**`,
  suppressedInline: (n, config) => ` **${n} suppressed by \`${config}\`** — listed below.`,
  webTableHead: '| Check | Status | Impact | Note |\n|---|---|---|---|',
  statusOk: '✅ ok',
  statusFail: '❌',
  statusNotApplicable: '⚪ not applicable',
  statusNotEvaluated: '⚪ not evaluated',
  statusSuppressed: '⊘ suppressed',
  suppressedTitle: (n) => `Suppressed by configuration (${n})`,
  suppressedBlurb: (config) =>
    `These checks **failed** and were silenced in \`${config}\`. They are listed here so the report cannot be made to look cleaner than the site is.`,
  suppressedTableHead: '| Check | Impact | Declared reason |\n|---|---|---|',
  webFindingsTitle: 'Website findings in detail',
  noBrowser: 'no browser available',

  coverageTitle: 'Coverage',
  coverageBlurb:
    'This automated analysis covers what is verifiable from the outside. Items that require server access (authorization, input validation, rate limiting, backups) are covered by the manual part of the audit.',
  verifiedAutomatically: 'Verified automatically',
  playwrightNote:
    '> Browser console errors were **not** inspected: Playwright is not installed. Install it (`npm i -D playwright && npx playwright install chromium`) and re-run to include runtime errors.',
  nextStepsTitle: 'Recommended next steps',
  nextStepsCritical:
    '1. **Today:** rotate every exposed credential listed above.\n2. **Today:** enable RLS on the exposed tables.\n3. **This week:** move any sensitive logic from the browser to the server.\n4. Re-scan to confirm the criticals are closed.',
  nextStepsNormal:
    '1. Address findings in order of severity.\n2. Complement with a manual server-side review.',
  initHint:
    'For the website section, `npx vibeward@latest init` installs a skill that reads these findings, applies the fixes it can, and re-scans to verify.',
  footer: (version) =>
    `_Generated with vibeward v${version} — an automated, non-destructive analysis performed from the outside._`,
};

const ES: ReportStrings = {
  title: (hasWeb) => (hasWeb ? 'Informe de auditoría' : 'Informe de auditoría de seguridad'),
  application: 'Aplicación',
  date: 'Fecha',
  scope: (hasWeb, active) =>
    `Análisis automatizado y ${active ? 'no destructivo' : 'de solo lectura'} del frontend público y de la API de datos${
      hasWeb ? ', más la calidad del sitio y su visibilidad ante las IA' : ''
    }. No incluye pruebas de intrusión manuales ni revisión del código de servidor.`,

  executiveSummary: 'Resumen ejecutivo',
  severityTableHead: '| Severidad | Hallazgos |\n|---|---|',
  sev: { critical: '🔴 Crítico', high: '🟠 Alto', medium: '🟡 Medio', low: '⚪ Bajo' },
  sevHeading: { critical: '🔴 CRÍTICO', high: '🟠 ALTO', medium: '🟡 MEDIO', low: '⚪ BAJO' },
  webSev: {
    critical: '🔴 Impacto alto',
    high: '🔴 Impacto alto',
    medium: '🟡 Impacto medio',
    low: '⚪ Impacto bajo',
  },
  verdict: {
    critical: 'NO APTO PARA PRODUCCIÓN — hay fallos críticos que exponen datos o credenciales.',
    high: 'REQUIERE ATENCIÓN URGENTE antes de seguir en producción.',
    medium: 'ACEPTABLE con mejoras recomendadas.',
    clean: 'Sin hallazgos críticos dentro del alcance automatizado.',
  },
  criticalCallout: (n) =>
    `Se detectaron **${n} problema(s) crítico(s)**. Un problema crítico significa que, ahora mismo, una persona no autorizada podría leer datos privados de tus usuarios o usar credenciales que te cuestan dinero. Arréglalos antes que nada.`,
  webAside: (n) =>
    `Aparte, se encontraron **${n} problema(s) de calidad del sitio** — están en la sección de abajo. No afectan al veredicto de seguridad.`,
  suppressionBanner: (n, config) =>
    `> ⚠️ **Este informe se generó con ${n} supresión(es) activas**, declaradas en \`${config}\`. Cada una aparece con su motivo en la sección del sitio web. Los hallazgos de seguridad nunca se pueden suprimir.`,

  dbTitle: 'Exposición de la base de datos',
  dbHowEnumerated: (n) =>
    `${n} tabla(s) enumeradas en vivo desde la API de datos (más nombres comunes)`,
  dbHowCommon: (n) => `${n} nombres de tabla comunes`,
  dbExposedIntro: (how, n) =>
    `Se probó el acceso a **${how}** usando solo la clave pública. **${n} tabla(s) devolvieron datos** — falta Row Level Security o está mal configurada, y cualquier visitante puede leer su contenido.`,
  dbTableHead:
    '| Tabla | Filas totales | Columnas sensibles expuestas | Escribible |\n|---|---|---|---|',
  dbWriteYes: '🔴 sí',
  dbWriteNo: 'no',
  dbPiiNote: (n) =>
    `> ⚠️ **${n} de esas tablas contienen datos personales** (correos, teléfonos, nombres u otros). Esto es una fuga de datos activa.`,
  dbWritableNote: (n) =>
    `> 🔴 **${n} tabla(s) además aceptan escrituras sin autenticar** — cualquiera puede alterar los datos, no solo leerlos.`,
  dbHowToClose:
    '**Lo que hace falta para cerrarlo:** activa RLS en todas las tablas (`ALTER TABLE x ENABLE ROW LEVEL SECURITY;`) y escribe políticas que filtren por `auth.uid()`, no por `true`. Da los datos por leídos: rota cualquier credencial que estuviera al alcance y decide si esto hay que notificarlo.',
  dbNoneExposed: (how) =>
    `Se probaron ${how} con la clave pública. Ninguna devolvió datos: **RLS parece activa** en las tablas probadas. Ojo: esto no demuestra que todas las tablas estén protegidas, solo las que se alcanzaron.`,

  detailedFindings: 'Hallazgos detallados',
  noFindings:
    'El análisis automatizado no detectó secretos expuestos ni cabeceras ausentes. Aun así, se recomienda una revisión manual del lado del servidor.',
  fClassification: 'Clasificación',
  fWhere: 'Dónde',
  fEvidence: 'Evidencia',
  fExploit: 'Cómo se explota',
  fImpact: 'Impacto',
  fWhy: 'Por qué importa',
  fReferences: 'Referencias',
  fPages: 'Páginas',
  fChecklist: (n) => `_Punto ${n} de la checklist._`,

  webTitle: 'Calidad del sitio y visibilidad ante las IA',
  webBlurb:
    '> Estos hallazgos **no** afectan al veredicto de seguridad ni al código de salida. Tratan de cómo leen este sitio los buscadores, las redes sociales y los asistentes de IA.',
  fingerprint: (score, total) => `**Huella de vibe-coding: ${score}/${total}**`,
  stackDetected: 'Stack detectado',
  stackOn: ' sobre ',
  checksPassed: (passed, total) => `**${passed} de ${total} comprobaciones superadas.**`,
  suppressedInline: (n, config) => ` **${n} suprimidas por \`${config}\`** — listadas abajo.`,
  webTableHead: '| Comprobación | Estado | Impacto | Nota |\n|---|---|---|---|',
  statusOk: '✅ ok',
  statusFail: '❌',
  statusNotApplicable: '⚪ no aplica',
  statusNotEvaluated: '⚪ no evaluada',
  statusSuppressed: '⊘ suprimida',
  suppressedTitle: (n) => `Suprimidas por configuración (${n})`,
  suppressedBlurb: (config) =>
    `Estas comprobaciones **fallaron** y se silenciaron en \`${config}\`. Se listan aquí para que el informe no pueda parecer más limpio de lo que está el sitio.`,
  suppressedTableHead: '| Comprobación | Impacto | Motivo declarado |\n|---|---|---|',
  webFindingsTitle: 'Hallazgos del sitio en detalle',
  noBrowser: 'no hay navegador disponible',

  coverageTitle: 'Alcance verificado',
  coverageBlurb:
    'Este análisis automatizado cubre lo que se puede verificar desde fuera. Lo que exige acceso al servidor (autorización, validación de entradas, límites de tasa, copias de seguridad) corresponde a la parte manual de la auditoría.',
  verifiedAutomatically: 'Verificado automáticamente',
  playwrightNote:
    '> Los errores de consola del navegador **no** se inspeccionaron: Playwright no está instalado. Instálalo (`npm i -D playwright && npx playwright install chromium`) y vuelve a ejecutar para incluir los errores en tiempo de ejecución.',
  nextStepsTitle: 'Siguientes pasos recomendados',
  nextStepsCritical:
    '1. **Hoy:** rota todas las credenciales expuestas que aparecen arriba.\n2. **Hoy:** activa RLS en las tablas expuestas.\n3. **Esta semana:** saca del navegador cualquier lógica sensible y llévala al servidor.\n4. Vuelve a escanear para confirmar que los críticos están cerrados.',
  nextStepsNormal:
    '1. Atiende los hallazgos por orden de severidad.\n2. Complétalo con una revisión manual del lado del servidor.',
  initHint:
    'Para la sección del sitio web, `npx vibeward@latest init` instala una skill que lee estos hallazgos, aplica los arreglos que puede y vuelve a escanear para verificarlo.',
  footer: (version) =>
    `_Generado con vibeward v${version} — análisis automatizado y no destructivo realizado desde fuera._`,
};

export const REPORT: Record<Lang, ReportStrings> = { en: EN, es: ES };
