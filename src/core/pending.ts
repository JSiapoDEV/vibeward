// What is left after the scan: the work vibeward hands on, written the same way every time.
//
// vibeward answers what fixed rules can answer and says so. Some questions are not of that
// kind — whether the HTML this component renders can carry a visitor's text, whether this
// route checks that the record belongs to the caller — and a rule that pretended to settle
// them would either miss most of them or fire on every file. So instead of a verdict, those
// become pending items: a fixed task, the files it is about, and why it matters. Whoever
// reads the report does the judging — the agent in a local session, the builder's own AI
// (Lovable, Bolt, v0) through the prompt, or the person.
//
// Three kinds, and the difference matters to the reader:
//   · review    — a question about code vibeward found but cannot judge.
//   · platform  — the builder's own AI scan, which covers the same ground with its credits.
//   · unchecked — an area this run did not look at, and how to cover it.
//
// Nothing here calls a model and nothing here reads the network. The items are a pure
// function of what the scan saw, so the same repository always yields the same list.

import type { CoverageEntry } from './coverage.js';
import { coverage, coverageText, type CoverageLine, type Lang } from './i18n.js';
import { isWeb, type Finding, type Severity } from './types.js';

export type PendingKind = 'review' | 'platform' | 'unchecked';

export interface PendingItem {
  /** Stable, never translated: an agent or a CI step keys off it. */
  id: string;
  kind: PendingKind;
  /** The task, as an instruction. */
  task: CoverageLine;
  /** Why it is worth the time. */
  why: CoverageLine;
  /** The files it is about, capped; empty for platform and unchecked items. */
  files: string[];
}

/** The AI app builders whose own security scan a pending item can point at. */
export type Builder = 'lovable' | 'bolt' | 'v0' | 'replit';

/** How many files to name per item. Past this, a list is a scroll, not a lead. */
const MAX_FILES = 8;

// ---------------------------------------------------------------------------
// What the folder scan collects
// ---------------------------------------------------------------------------

/** Signals gathered file by file during a folder scan. */
export interface ReviewSignals {
  builder: Builder | null;
  /** Files that write HTML from a value: `dangerouslySetInnerHTML`, `v-html`, `innerHTML =`… */
  htmlSinks: Set<string>;
  /** Server code that answers a request: route handlers, server actions, Edge Functions. */
  serverEntry: Set<string>;
  /** Server code that fetches a URL built from something other than a literal. */
  dynamicFetch: Set<string>;
}

export function emptySignals(): ReviewSignals {
  return { builder: null, htmlSinks: new Set(), serverEntry: new Set(), dynamicFetch: new Set() };
}

/** Tests, fixtures and stories, where a sink or a fetch is the point of the file. */
const NOT_APP_CODE =
  /(^|[\\/])(test|tests|__tests__|__mocks__|spec|fixtures?|e2e|cypress|playwright|stories)[\\/]|\.(test|spec|stories)\.[jt]sx?$/i;

const HTML_SINK =
  /dangerouslySetInnerHTML|\bv-html\s*=|\{@html\s|\bset:html\s*=|\.(?:innerHTML|outerHTML)\s*=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\(/;

/**
 * Paths whose file IS a request handler by convention: an Edge Function, a Next.js route
 * handler, a pages-router API route. A folder merely named `api/` or `server/` is not one of
 * these — a whole backend lives there, config and crons included, and listing all of it
 * turned a precise question into a directory listing.
 */
const SERVER_PATH =
  /(^|[\\/])supabase[\\/]functions[\\/][^\\/]+[\\/]index\.[jt]s$|(^|[\\/])app[\\/](?:.+[\\/])?route\.[jt]s$|(^|[\\/])pages[\\/]api[\\/].+\.[jt]s$/i;

/** A file that registers routes itself: Express, Fastify, Hono, Koa routers and the like. */
const ROUTE_REGISTRATION =
  /\b(?:app|router|server|fastify|api|routes?|hono|r)\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`]\/|\.route\s*\(\s*\{[^}]*\burl\s*:|\bcreateRoute\s*\(/;

/** A server action module, wherever it lives. */
const USE_SERVER = /^\s*['"]use server['"]/m;

/** Code that reads what the caller sent. */
const REQUEST_INPUT =
  /\breq(?:uest)?\.(?:json|text|formData)\s*\(|\breq\.(?:body|query|params)\b|\bsearchParams\b|\bgetQuery\s*\(|\bformData\.get\s*\(/;

/** `fetch(` whose first argument does not start with a fixed `https://…` string. */
const DYNAMIC_FETCH = /\b(?:fetch|axios(?:\.(?:get|post))?|got)\s*\(\s*(?!['"`]https?:\/\/)/;

/**
 * True when every React HTML sink in the file inserts a fixed string: a literal, or a constant
 * defined in the same file as one, with no `${…}` inside. That is the theme-before-paint script
 * every Next.js app with dark mode carries, and nothing a visitor types can reach it. Any sink
 * this cannot prove fixed — an expression, a prop, a DOM assignment — keeps the file listed.
 */
function onlyFixedHtml(content: string): boolean {
  if (
    /\bv-html\s*=|\{@html\s|\bset:html\s*=|\.(?:innerHTML|outerHTML)\s*=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\(/.test(
      content,
    )
  ) {
    return false;
  }
  const values = [
    ...content.matchAll(/dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*([^}]+?)\s*\}\}/g),
  ].map((m) => m[1]!.trim());
  if (values.length === 0) return false;
  const fixed = (v: string): boolean => {
    if (/^(['"])(?:(?!\1)[^\\]|\\.)*\1$/.test(v)) return true;
    if (/^`[^`]*`$/.test(v)) return !v.includes('${');
    if (/^[A-Za-z_$][\w$]*$/.test(v)) {
      const def = new RegExp(
        `\\b(?:const|let|var)\\s+${v.replace(/\$/g, '\\$')}\\s*=\\s*(\`[^\`]*\`|'[^'\\n]*'|"[^"\\n]*")`,
      ).exec(content);
      return Boolean(def && !def[1]!.includes('${'));
    }
    return false;
  };
  return values.every(fixed);
}

/** Which builder made this repository, from the files each one leaves behind. */
export function builderFromFile(relPath: string, content: string | null): Builder | null {
  const p = relPath.replace(/\\/g, '/');
  if (p === '.replit' || p === 'replit.nix') return 'replit';
  if (p.startsWith('.bolt/')) return 'bolt';
  if (p === 'package.json' && content) {
    if (/"lovable-tagger"\s*:/.test(content)) return 'lovable';
    // The name v0 gives every project it exports. A renamed project is not recognised, which
    // costs one pending item; a guess on anything vaguer would send a Bolt user to v0.
    if (/"name"\s*:\s*"my-v0-project"/.test(content)) return 'v0';
  }
  return null;
}

/** Records what one source file says about the review items. */
export function collectSignals(
  signals: ReviewSignals,
  relPath: string,
  content: string,
): ReviewSignals {
  if (NOT_APP_CODE.test(relPath)) return signals;
  if (HTML_SINK.test(content) && !onlyFixedHtml(content)) signals.htmlSinks.add(relPath);
  const server =
    SERVER_PATH.test(relPath) || USE_SERVER.test(content) || ROUTE_REGISTRATION.test(content);
  if (server) {
    signals.serverEntry.add(relPath);
    if (REQUEST_INPUT.test(content) && DYNAMIC_FETCH.test(content))
      signals.dynamicFetch.add(relPath);
  }
  return signals;
}

/** Which builder hosts this URL. v0 deploys to vercel.app like everyone else, so it is never guessed. */
export function builderFromHost(host: string): Builder | null {
  const h = host.toLowerCase();
  if (h === 'lovable.app' || h.endsWith('.lovable.app')) return 'lovable';
  if (h === 'bolt.host' || h.endsWith('.bolt.host')) return 'bolt';
  if (h.endsWith('.replit.app') || h.endsWith('.repl.co')) return 'replit';
  return null;
}

// ---------------------------------------------------------------------------
// Building the list
// ---------------------------------------------------------------------------

const PLATFORM: Record<Builder, { task: CoverageLine; why: CoverageLine }> = {
  lovable: {
    task: coverage(
      'In Lovable, open the Security view and run the **Deep scan**.',
      'En Lovable, abre la vista Security y corre el **Deep scan**.',
    ),
    why: coverage(
      "It reads your app's logic with AI — permissions, payments, login — on your Lovable credits. vibeward's rules and Lovable's quick scan both stop at what fixed rules can see.",
      'Revisa con IA la lógica de tu app — permisos, pagos, inicio de sesión — con tus créditos de Lovable. Las reglas de vibeward y el escaneo rápido de Lovable llegan solo hasta donde ve una regla fija.',
    ),
  },
  bolt: {
    task: coverage(
      'In Bolt, open **Publish → Run security audit**.',
      'En Bolt, abre **Publish → Run security audit**.',
    ),
    why: coverage(
      'It reviews the code and the database and does not spend tokens (paid plans). Asking for an audit in the chat does spend them.',
      'Revisa el código y la base de datos sin gastar tokens (planes de pago). Pedir la auditoría en el chat sí los gasta.',
    ),
  },
  v0: {
    task: coverage(
      'In v0, write **Run a security check** in the chat.',
      'En v0, escribe **Run a security check** en el chat.',
    ),
    why: coverage(
      "v0's security check reviews the generated code with AI, on your v0 credits.",
      'El chequeo de seguridad de v0 revisa con IA el código generado, con tus créditos de v0.',
    ),
  },
  replit: {
    task: coverage(
      'In Replit, open **Security** and select **Run security scan**.',
      'En Replit, abre **Security** y elige **Run security scan**.',
    ),
    why: coverage(
      "Replit's scan checks your dependencies against known vulnerabilities, which vibeward does not.",
      'El escaneo de Replit compara tus dependencias con vulnerabilidades conocidas, algo que vibeward no hace.',
    ),
  },
};

function capped(files: Set<string> | string[]): string[] {
  return [...files].sort().slice(0, MAX_FILES);
}

/** Review items from what a folder scan collected. */
function reviewItems(signals: ReviewSignals): PendingItem[] {
  const items: PendingItem[] = [];
  if (signals.htmlSinks.size > 0) {
    items.push({
      id: 'review_html_sinks',
      kind: 'review',
      task: coverage(
        'Check that nothing a user typed reaches these HTML sinks without being sanitised (DOMPurify or equivalent).',
        'Revisa que nada escrito por un usuario llegue a estos puntos que insertan HTML sin sanitizar (DOMPurify o equivalente).',
      ),
      why: coverage(
        'Text inserted as HTML runs as code in the next visitor’s browser (XSS): it can read their session and act as them.',
        'Un texto insertado como HTML se ejecuta como código en el navegador del siguiente visitante (XSS): puede leer su sesión y actuar en su nombre.',
      ),
      files: capped(signals.htmlSinks),
    });
  }
  if (signals.serverEntry.size > 0) {
    items.push({
      id: 'review_server_ownership',
      kind: 'review',
      task: coverage(
        'For each of these server entry points, check that it verifies who is calling and that the record they ask for is theirs — not only that they are signed in.',
        'En cada uno de estos puntos de entrada del servidor, revisa que verifique quién llama y que el registro que pide sea suyo, no solo que haya iniciado sesión.',
      ),
      why: coverage(
        'A signed-in user who changes an id in the request gets someone else’s data (IDOR). It is the most common flaw rules cannot see, because the check is about meaning, not syntax.',
        'Un usuario con sesión que cambia un id en la petición obtiene los datos de otro (IDOR). Es el fallo más común que una regla no ve, porque depende del significado, no de la sintaxis.',
      ),
      files: capped(signals.serverEntry),
    });
  }
  if (signals.dynamicFetch.size > 0) {
    items.push({
      id: 'review_server_fetch',
      kind: 'review',
      task: coverage(
        'These server files fetch a URL that is not fixed in the code, and they read the request. Check that the URL never comes from the caller, or is checked against an allowlist of hosts.',
        'Estos archivos del servidor piden una URL que no está fija en el código, y leen la petición. Revisa que la URL nunca venga de quien llama, o que se compare con una lista de dominios permitidos.',
      ),
      why: coverage(
        'A server that fetches whatever URL it is given can be pointed at internal addresses and cloud metadata (SSRF).',
        'Un servidor que pide cualquier URL que le pasen puede apuntarse a direcciones internas y a los metadatos de la nube (SSRF).',
      ),
      files: capped(signals.dynamicFetch),
    });
  }
  return items;
}

/** What this run did not look at, as tasks. The coverage text already says how to cover it. */
function uncheckedItems(scanned: CoverageEntry[], ignore: string[]): PendingItem[] {
  return (
    scanned
      // The website pass is quality, not security: its gaps belong in the coverage section, not
      // in a list of security work.
      .filter(
        (e) => e.status === 'not_evaluated' && !ignore.includes(e.id) && e.id !== 'website_quality',
      )
      .map((e) => ({
        id: `unchecked_${e.id}`,
        kind: 'unchecked' as const,
        task: e.detail,
        why: coverage(
          'Not checked is not the same as fine: nothing in this report speaks for this area.',
          'No revisado no es lo mismo que correcto: nada en este informe habla de esta área.',
        ),
        files: [],
      }))
  );
}

export function buildPending(input: {
  scanned: CoverageEntry[];
  signals?: ReviewSignals | null;
  builder?: Builder | null;
  /**
   * Gaps the report must still state but that are not worth a task here. A folder scan never
   * probes a live database, and says so on every run; on a repository with no Supabase in it
   * that is a true sentence and a pointless chore.
   */
  ignoreUnchecked?: string[];
  /** Database functions the public key can call, from a live probe. */
  rpcs?: string[];
}): PendingItem[] {
  const items: PendingItem[] = [];
  if (input.signals) items.push(...reviewItems(input.signals));
  if (input.rpcs && input.rpcs.length > 0) {
    items.push({
      id: 'review_public_rpcs',
      kind: 'review',
      task: coverage(
        `Anyone with the public key can call these ${input.rpcs.length} database function(s). For each one, check that it verifies who is calling and what it is allowed to touch — or revoke EXECUTE from \`anon\`.`,
        `Cualquiera con la clave pública puede llamar a estas ${input.rpcs.length} función(es) de la base de datos. En cada una, revisa que verifique quién llama y qué puede tocar, o quítale EXECUTE a \`anon\`.`,
      ),
      why: coverage(
        'A function runs with its own checks, not the table policies around it; one marked SECURITY DEFINER skips RLS entirely.',
        'Una función corre con sus propias comprobaciones, no con las políticas de las tablas; una marcada SECURITY DEFINER se salta la RLS por completo.',
      ),
      files: capped(input.rpcs.map((n) => `rpc/${n}`)),
    });
  }
  const builder = input.builder ?? input.signals?.builder ?? null;
  if (builder) {
    items.push({ id: `platform_${builder}`, kind: 'platform', ...PLATFORM[builder], files: [] });
  }
  items.push(...uncheckedItems(input.scanned, input.ignoreUnchecked ?? []));
  return items;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const TEXT = {
  en: {
    title: 'Pending — for you or your agent',
    blurb:
      'vibeward does not judge these: they need someone to read the code. Each one is a fixed task, the same on every run. Hand them to your agent, or paste the prompt below into your builder.',
    files: 'Files',
    kind: { review: 'Review', platform: 'Your builder', unchecked: 'Not checked' },
    promptTitle: 'Prompt for your builder (Lovable, Bolt, v0, Cursor…)',
    promptHead:
      'A security scanner (vibeward) checked my project. Do not change anything yet. First explain, in plain words, what you find for each point below and what you would change; I will confirm before you edit.',
    promptFix: 'Problems it found, to explain and propose a fix for:',
    promptReview: 'Things it could not judge, to review in the code:',
  },
  es: {
    title: 'Pendientes — para ti o tu agente',
    blurb:
      'vibeward no los juzga: hace falta alguien que lea el código. Cada uno es una tarea fija, igual en cada corrida. Pásaselos a tu agente, o pega el prompt de abajo en tu constructor.',
    files: 'Archivos',
    kind: { review: 'Revisar', platform: 'Tu constructor', unchecked: 'No revisado' },
    promptTitle: 'Prompt para tu constructor (Lovable, Bolt, v0, Cursor…)',
    promptHead:
      'Un escáner de seguridad (vibeward) revisó mi proyecto. No cambies nada todavía. Primero explica, en palabras simples, qué encuentras en cada punto de abajo y qué cambiarías; yo confirmo antes de que edites.',
    promptFix: 'Problemas que encontró, para explicar y proponer cómo corregirlos:',
    promptReview: 'Cosas que no pudo juzgar, para revisar en el código:',
  },
};

const PROMPT_SEVERITIES: Severity[] = ['critical', 'high', 'medium'];
/** Findings named in the prompt. A builder handed forty items fixes the first three. */
const PROMPT_FINDINGS = 10;

/**
 * The text a person pastes into their builder's chat. It is the "no terminal" version of
 * handing the pending list to an agent: the builder's AI does the judging, on their credits.
 * It asks for an explanation before any edit, because a builder told "fix these" rewrites
 * policies it does not understand — which is how the open policy got there.
 */
export function builderPrompt(
  findings: Finding[],
  items: PendingItem[],
  lang: Lang,
): string | null {
  const t = TEXT[lang];
  const fixes = findings
    .filter((f) => PROMPT_SEVERITIES.includes(f.severity) && !isWeb(f))
    .slice(0, PROMPT_FINDINGS);
  const reviews = items.filter((i) => i.kind === 'review');
  if (fixes.length === 0 && reviews.length === 0) return null;

  const lines = [t.promptHead, ''];
  if (fixes.length > 0) {
    lines.push(t.promptFix);
    fixes.forEach((f, i) => lines.push(`${i + 1}. ${f.label}${f.source ? ` (${f.source})` : ''}`));
    lines.push('');
  }
  if (reviews.length > 0) {
    lines.push(t.promptReview);
    reviews.forEach((r, i) => {
      const files = r.files.length > 0 ? ` ${t.files}: ${r.files.join(', ')}` : '';
      lines.push(`${i + 1}. ${coverageText(r.task, lang)}${files}`);
    });
  }
  return lines.join('\n').trim();
}

/** The report section. Empty string when there is nothing pending. */
export function pendingMarkdown(findings: Finding[], items: PendingItem[], lang: Lang): string {
  if (items.length === 0) return '';
  const t = TEXT[lang];
  let md = `## ${t.title}\n\n${t.blurb}\n\n`;
  for (const item of items) {
    md += `- [ ] **${t.kind[item.kind]}** — ${coverageText(item.task, lang)}\n`;
    md += `  ${coverageText(item.why, lang)}\n`;
    if (item.files.length > 0) {
      md += `  ${t.files}: ${item.files.map((f) => `\`${f}\``).join(', ')}\n`;
    }
  }
  const prompt = builderPrompt(findings, items, lang);
  if (prompt) md += `\n### ${t.promptTitle}\n\n\`\`\`text\n${prompt}\n\`\`\`\n`;
  return `${md}\n`;
}
