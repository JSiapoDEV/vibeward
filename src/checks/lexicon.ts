// The multilingual half of the intent gate.
//
// The observation this file is built on: the dangerous OBJECTS of a vibe-coding prompt are
// already language-independent. `RLS`, `service_role`, `CORS`, `.env`, `sb_secret`, `bucket`,
// `policy`, `token` are identifiers, not words — a Brazilian writes "desativa o RLS", a German
// "schalte RLS aus", and the object is `RLS` every time. Only the VERB changes.
//
// So instead of N complete rulesets (O(languages × rules), unauditable by anyone who does not
// speak all N), there is one shared target lexicon plus a small verb table per language
// (O(languages × verbs), ~40 entries a native speaker reviews in five minutes).
//
// Verbs are stored as STEMS: `desactiv` covers desactiva / desactivar / desactives /
// desactivado. Spanish and Portuguese conjugate far more than English does, and listing the
// forms by hand is exactly how the first Spanish pass ended up catching only the imperative.

export type Lang = 'en' | 'es' | 'pt';

export const LANGS: Lang[] = ['en', 'es', 'pt'];

/** The verb roles the rules ask for. Each language fills in the same six. */
export interface VerbTable {
  /** Take a control away: disable, turn off, remove, skip, bypass. */
  weaken: string[];
  /** Open something up: expose, publish, make public, leak. */
  expose: string[];
  /** Place a value somewhere it must not be: put, paste, hardcode, inline. */
  place: string[];
  /** Send it to a repo: commit, push, upload. */
  ship: string[];
  /** Write it to output: log, print. */
  emit: string[];
  /** Grant access: allow, permit, grant. */
  allow: string[];
}

export interface Lexicon {
  verbs: VerbTable;
  /**
   * Negation particles. Vetoed only when one sits within two words of a verb — a particle
   * anywhere in the prompt would hand a free pass to "no me importa, desactiva el RLS".
   */
  negations: string[];
  /**
   * Nouns that make the sentence about the interface, not about a control. "Remove the login
   * BUTTON" is styling work; this is the single biggest source of false positives, and it is
   * the part of the exclude lists that genuinely has to be translated.
   */
  uiNouns: string[];
  /** "public" and its translations, for the make-public rule. */
  publicWord: string[];
  /** Datastore nouns — the only things it is dangerous to make public. */
  datastores: string[];
  /** Authentication vocabulary. `auth` and `login` are loanwords almost everywhere. */
  auth: string[];
}

const EN: Lexicon = {
  verbs: {
    weaken: [
      'disabl',
      'turn\\s*off',
      'switch\\s*off',
      'remov',
      'delet',
      'skip',
      'skipp',
      'bypass',
      'get\\s+rid\\s+of',
      'comment\\s*out',
      'strip\\s+out',
      'drop',
    ],
    expose: ['expos', 'publish', 'leak', 'open\\s+up', 'ship'],
    place: ['hard[-\\s]?cod', 'paste', 'inlin', 'embed'],
    ship: ['commit', 'push', 'upload', 'check\\s+in'],
    emit: ['log', 'print', 'console\\.log', 'dump'],
    allow: ['allow', 'permit', 'grant', 'enabl'],
  },
  negations: ['never', 'not', "n'?t", 'avoid', 'without', 'instead\\s+of', 'rather\\s+than'],
  uiNouns: [
    'button',
    'banner',
    'screen',
    'page',
    'link',
    'form',
    'modal',
    'dialog',
    'navbar',
    'nav',
    'header',
    'footer',
    'sidebar',
    'icon',
    'label',
    'placeholder',
    'component',
    'animation',
    'spinner',
    'css',
    'styl',
    'copy',
    'text',
  ],
  publicWord: ['public'],
  // `data`, `api` and `endpoint` are deliberately absent: this list feeds a verb-less
  // co-occurrence rule, and "the data is public already" is an ordinary English sentence.
  // A generic request is still caught by the `allow public access` pattern.
  datastores: ['table', 'tables', 'bucket', 'buckets', 'storage', 'database', 'db', 'dataset'],
  auth: [
    'auth',
    'authentication',
    'authorization',
    'login',
    'sign[-\\s]?in',
    'session\\s*check',
    'protected\\s+route',
    'requireAuth',
    'auth\\s*wall',
    'auth\\s*(check|guard|middleware|requirement)',
  ],
};

const ES: Lexicon = {
  verbs: {
    weaken: [
      'desactiv',
      'desabilit',
      'deshabilit',
      'quita',
      'quitar',
      'quite$',
      'apag',
      'elimin',
      's[áa]ltate',
      'omit',
      'anul',
      'desconect',
      'coment',
    ],
    expose: ['expon', 'expong', 'public', 'filtr', 'abra', 'abrir'],
    place: [
      'pon$',
      'ponga',
      'poner',
      'pone$',
      'mete$',
      'meter',
      'pega',
      'pegar',
      'incrust',
      'hardcode',
    ],
    ship: ['sube', 'subir', 'commit', 'push'],
    emit: ['imprim', 'muestr', 'log', 'console\\.log'],
    allow: ['permit', 'habilit', 'otorg'],
  },
  // "sin" is deliberately absent: "sin RLS" describes a state, it does not negate a request.
  negations: [
    'no',
    'nunca',
    'jam[áa]s',
    'ning[úu]n',
    'ninguna',
    'evita',
    'evitar',
    'en\\s+vez\\s+de',
    'en\\s+lugar\\s+de',
  ],
  uiNouns: [
    'bot[óo]n',
    'botones',
    'pantalla',
    'p[áa]gina',
    'enlace',
    'formulario',
    'modal',
    'men[úu]',
    'cabecera',
    'pie\\s+de\\s+p[áa]gina',
    'barra',
    'icono',
    'etiqueta',
    'componente',
    'animaci[óo]n',
    'estilo',
    'texto',
    'vista',
  ],
  publicWord: ['p[úu]blic'],
  datastores: ['tabla', 'tablas', 'bucket', 'almacenamiento', 'base\\s+de\\s+datos'],
  auth: [
    'autenticaci[óo]n',
    'autorizaci[óo]n',
    'inicio\\s+de\\s+sesi[óo]n',
    'sesi[óo]n',
    'login',
    'auth',
    'ruta\\s+protegida',
  ],
};

const PT: Lexicon = {
  verbs: {
    weaken: [
      'desativ',
      'desabilit',
      'remov',
      'tira',
      'tirar',
      'pula',
      'pule$',
      'pular',
      'desli[gq]',
      'ignor',
      'apag',
      'exclui',
      'excluir',
      'exclua',
      'coment',
      'burl',
    ],
    expose: ['exponha', 'expor', 'exp[õ]e$', 'public', 'vaz', 'abra', 'abrir'],
    place: ['coloc', 'p[õ]e$', 'ponha', 'incorpor', 'hardcode'],
    ship: ['suba$', 'sube$', 'subir', 'envia', 'enviar', 'envie$', 'commit', 'push'],
    emit: ['imprim', 'mostr', 'log', 'console\\.log'],
    allow: ['permit', 'habilit', 'conced'],
  },
  negations: [
    'n[ãa]o',
    'nunca',
    'jamais',
    'nenhum',
    'nenhuma',
    'evite',
    'evitar',
    'em\\s+vez\\s+de',
    'ao\\s+inv[ée]s\\s+de',
  ],
  uiNouns: [
    'bot[ãa]o',
    'bot[õo]es',
    'tela',
    'p[áa]gina',
    'link',
    'formul[áa]rio',
    'modal',
    'menu',
    'cabe[çc]alho',
    'rodap[ée]',
    'barra',
    '[íi]cone',
    'r[óo]tulo',
    'componente',
    'anima[çc][ãa]o',
    'estilo',
    'texto',
  ],
  publicWord: ['p[úu]blic'],
  datastores: ['tabela', 'tabelas', 'bucket', 'armazenamento', 'banco\\s+de\\s+dados'],
  auth: [
    'autentica[çc][ãa]o',
    'autoriza[çc][ãa]o',
    'login',
    'auth',
    'sess[ãa]o',
    'rota\\s+protegida',
  ],
};

export const LEXICONS: Record<Lang, Lexicon> = { en: EN, es: ES, pt: PT };

/**
 * Words that stay English in every language, so they never need a translation table:
 * tooling, test frameworks and file names. A Brazilian dev writes "ignora o eslint",
 * not "ignora o lintador".
 */
export const UNIVERSAL_EXCLUDES: RegExp[] = [
  // `build`, `ci` and `cd` are deliberately absent: "the build does not work" is an ordinary
  // English sentence, and a tooling list that swallows it stops being a tooling list.
  /\b(eslint|prettier|lint|tsc|type[-\s]?check|webpack|vite|babel)\b/i,
  /\b(e2e|end[-\s]to[-\s]end|playwright|cypress|vitest|jest|storybook|mock|fixture|snapshot|seed)\b/i,
  /\b(localhost|docker[-\s]?compose|\.env\.(example|sample|template|dist)|\.gitignore|gitignore)\b/i,
  /\brls[-_]?(test|fixture|demo|example|spec)\b/i,
];

/** Identifier-only patterns: no verb, no language, always dangerous. */
export const UNIVERSAL_TARGETS = {
  serviceKey: '(service[-_\\s]?role|service[-_\\s]?key|sb_secret|admin\\s*key|master\\s*key)',
  clientSide: '(client|frontend|front[-\\s]?end|browser|react|next|vue|svelte|cliente|navegador)',
  rls: '(rls|row[-\\s]?level\\s+security|seguridad\\s+a\\s+nivel\\s+de\\s+fila|seguran[çc]a\\s+a\\s+n[íi]vel\\s+de\\s+linha)',
  secret:
    '(api[-\\s]?key|secret|token|password|credential|credencial|contrase[ñn]a|senha|access[-\\s]?key|private[-\\s]?key|connection\\s+string)',
  securityControl:
    '(security|seguridad|seguran[çc]a|csrf|xss|sanitiz|rate[-\\s]?limit|l[íi]mite\\s+de\\s+peticiones|signature\\s+verification|certificate\\s+verification|ssl\\s+verification)',
} as const;

/** Escapes nothing — the tables are authored as regex fragments on purpose. */
export function group(items: string[]): string {
  return `(?:${items.join('|')})`;
}

/**
 * A verb stem plus whatever letters follow it. Unicode-aware: `\w` in JavaScript is ASCII,
 * so `desactiv\w*` stops dead at the first accent and `p[úu]blic\w*` never matches "público".
 *
 * An entry ending in `$` is an EXACT form and gets no suffix. This exists because all three
 * languages are compiled into one matcher, so a Portuguese stem is checked against English
 * prose: `pul` swallowed "pull request", `sub` swallowed "subscribe", `tir` swallowed
 * "tired", `envi` swallowed "envision". Short stems have to be pinned; long ones are safe.
 */
export function stems(items: string[]): string {
  const parts = items.map((i) => (i.endsWith('$') ? i.slice(0, -1) : `${i}[\\p{L}]*`));
  return `(?:${parts.join('|')})`;
}
