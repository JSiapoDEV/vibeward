// Intent gate: deterministic rules over what the USER asks an AI coding agent.
// The dangerous prompts of vibe-coders are the root cause of most holes
// ("disable RLS so it works", "use the service_role key in the frontend").
// This is intentionally NOT an LLM call — prompt-level guardrails that "ask the
// model nicely" are architecturally weak (see Meta's LlamaFirewall). Rules win.
//
// Precision is the whole game. A rule that fires on "remove the login button from the
// navbar" is noise the agent has to ignore, and under `guard --block` it costs the user
// the prompt they just typed. So every rule carries vetoes, and the benign corpus in
// test/intent-test.ts is the real specification.
//
// Rules are DECLARED here as verb-role + target, and COMPILED per language from
// checks/lexicon.ts. Adding Portuguese meant adding a verb table, not eight new regexes.

import {
  LANGS,
  LEXICONS,
  UNIVERSAL_EXCLUDES,
  UNIVERSAL_TARGETS as T,
  group,
  stems,
  type Lang,
  type Lexicon,
  type VerbTable,
} from './lexicon.js';

export interface IntentFinding {
  id: string;
  risk: string;
  why: string;
  instead: string;
}

/**
 * How many characters may sit between a verb and its object. The gaps are `[^\n]` and not
 * `[^.]`: a clause is already bounded by its sentence (see `clauses`), so the only thing a
 * dot-excluding gap still did was let a filename disarm a rule — `put the service_role key
 * from supabase.config.ts in the frontend` walked past a gap that could not cross a dot.
 */
const WINDOW = 30;

/** Unicode-aware left boundary. `\b` is defined on ASCII `\w` and fails before a `.`. */
const NOT_WORD = '(?<![\\p{L}\\p{N}_])';

interface VerbTarget {
  verb: keyof VerbTable;
  /** Regex source for the object, possibly language-specific. */
  target: (lex: Lexicon) => string;
  /** Also match object-before-verb. Spanish and Portuguese reorder far more than English. */
  bidirectional?: boolean;
}

interface RuleSpec {
  id: string;
  risk: string;
  why: string;
  instead: string;
  /** Compiled once per enabled language. */
  verbTargets?: VerbTarget[];
  /** Identifier-only: no verb, no language. */
  raw?: RegExp[];
  /** Veto when the sentence is about the interface rather than a control. */
  vetoOnUi?: boolean;
  /** Extra vetoes, language-independent. */
  exclude?: RegExp[];
}

const SPECS: RuleSpec[] = [
  {
    id: 'disable-rls',
    risk: 'Disabling Row-Level Security',
    verbTargets: [{ verb: 'weaken', target: () => T.rls, bidirectional: true }],
    raw: [new RegExp(`\\b${T.rls}\\b[^\n]{0,20}\\b(off|disabled|desactivad|desativad)`, 'i')],
    why: 'Turning off RLS makes every row in the table readable (and often writable) by anyone with the public anon key. This is the #1 cause of vibe-coded data leaks.',
    instead:
      'Keep RLS on and add an owner-scoped policy: `CREATE POLICY ... USING (auth.uid() = user_id)`. If a query fails, fix the policy — do not disable the protection.',
  },
  {
    id: 'service-role-client',
    risk: 'Putting a secret/service key in the client',
    // Pure identifiers on both sides: this rule already worked in Portuguese before
    // Portuguese existed, which is the observation the whole lexicon is built on.
    raw: [
      new RegExp(`${T.serviceKey}[^\n]{0,40}\\b${T.clientSide}\\b`, 'i'),
      new RegExp(`\\b${T.clientSide}\\b[^\n]{0,40}${T.serviceKey}`, 'i'),
    ],
    verbTargets: [{ verb: 'expose', target: () => T.serviceKey, bidirectional: true }],
    why: 'The service_role / sb_secret key bypasses ALL Row-Level Security. In client code, anyone can extract it and read, modify or delete any table. It is the most dangerous key you have.',
    instead:
      'Use the anon / publishable key + RLS in the client. Do privileged work on the server (an Edge Function or backend) where the secret key never reaches the browser.',
  },
  {
    id: 'make-public',
    risk: 'Making data or a bucket public to debug',
    // A datastore noun next to "public" in either order. `public` is an access modifier and
    // a repository setting, so the datastore noun is what makes this safe to fire on.
    raw: LANGS.flatMap((l) => {
      const lex = LEXICONS[l];
      const store = group(lex.datastores);
      const pub = stems(lex.publicWord);
      return [
        new RegExp(`\\b${store}\\b[^\n]{0,25}\\b${pub}`, 'iu'),
        new RegExp(`\\b${pub}[^\n]{0,25}\\b${store}\\b`, 'iu'),
      ];
    }),
    verbTargets: [
      {
        verb: 'allow',
        target: (lex) => `${stems(lex.publicWord)}|(anonymous|everyone|anyone|todos|qualquer)`,
        bidirectional: false,
      },
    ],
    exclude: [
      /\b(method|class|field|property|function|member|constructor|interface|variable|const|getter|setter|struct|enum|m[ée]todo|clase|classe|fun[çc][ãa]o|funci[óo]n)\b/i,
      /\b(repo|repository|reposit[óo]rio|gist|package|npm|site|website|landing|blog|docs?|documentaci[óo]n|documenta[çc][ãa]o|profile|perfil)\b/i,
    ],
    vetoOnUi: true,
    why: 'Making a table or storage bucket public to "just debug" exposes real user data to the whole internet, and it almost never gets turned back off.',
    instead:
      'Debug with an authenticated test user and proper policies. Never open access to everyone, even temporarily.',
  },
  {
    id: 'remove-auth',
    risk: 'Removing or skipping authentication',
    verbTargets: [{ verb: 'weaken', target: (lex) => group(lex.auth), bidirectional: false }],
    // By far the biggest false-positive source: touching login UI is not touching auth.
    vetoOnUi: true,
    why: 'Removing the auth check to move faster leaves sensitive routes and data open to anyone. Missing authorization is one of the most common breaches in AI-generated apps.',
    instead:
      'Keep auth on and check it on the SERVER for every protected route (`auth.uid()` / session validation), not just by hiding UI in the browser.',
  },
  {
    id: 'cors-wildcard',
    risk: 'Allowing all origins (CORS *)',
    raw: [
      // The `[^\n]{0,10}` gap carries the article Spanish and Portuguese put where English
      // puts nothing: "todas AS origens", "todos LOS orígenes", "all origins".
      /\b(allow|permit\p{L}*|libera\p{L}*)\s+(all|any|todos?|todas?|qualquer|cualquier)[^\n]{0,10}\b(origins?|or[íi]genes|origens)\b/iu,
      /cors[^\n]{0,25}(\*|origin\s*[:=]\s*(true|['"]\*['"]))/i,
      /access-control-allow-origin[^\n]{0,10}\*/i,
    ],
    why: 'CORS `*` lets any website call your API with the visitor’s credentials, enabling data theft from other sites.',
    instead:
      'Whitelist your exact domains: `cors({ origin: ["https://yourapp.com"] })`. Never use `*` on an authenticated API.',
  },
  {
    id: 'hardcode-secret',
    risk: 'Hardcoding a secret / API key',
    verbTargets: [{ verb: 'place', target: () => T.secret, bidirectional: false }],
    raw: [
      new RegExp(
        `\\b(put|write|escrib\\p{L}*|pon\\p{L}*|coloc\\p{L}*)\\b[^\n]{0,25}${T.secret}[^\n]{0,30}\\b(in\\s+the\\s+(code|source|bundle|component|repo)|directly|inline|en\\s+el\\s+c[óo]digo|no\\s+c[óo]digo|direto)\\b`,
        'iu',
      ),
    ],
    why: 'A hardcoded secret ends up in your repo and your build, where anyone with access can read it — and it stays in git history even after you remove it.',
    instead:
      'Read it from a server-side environment variable. Keep secrets out of the repo (git-ignore `.env`) and out of any client bundle.',
  },
  {
    id: 'disable-security',
    risk: 'Disabling a security control to make it work',
    // `check` and `validation` are deliberately absent: they are two of the most common
    // words in ordinary programming and cost more in noise than they ever caught.
    verbTargets: [{ verb: 'weaken', target: () => T.securityControl, bidirectional: false }],
    why: 'Turning off a security control to fix an error hides the real bug and ships the hole to production, where it becomes an attacker’s entry point.',
    instead:
      'Find why the control rejects the request and fix that. A control that blocks you is usually catching a real problem.',
  },
  {
    id: 'commit-env',
    risk: 'Committing or exposing the .env file',
    verbTargets: [
      { verb: 'ship', target: () => '\\.env\\b', bidirectional: false },
      { verb: 'emit', target: () => T.secret, bidirectional: false },
    ],
    // Logging a key's NAME is not a leak, and .env.example is meant to be committed
    // (that one lives in UNIVERSAL_EXCLUDES, since the filename is the same everywhere).
    exclude: [
      /\b(name|names|prefix|suffix|id|shape|type|length|last\s*4|placeholder|redact|mask|masked|nombre|nome|prefijo|prefixo)\b/i,
    ],
    why: 'Committing `.env` (or logging secrets) leaks every credential in it to your repo, your logs, or your users.',
    instead:
      'Git-ignore `.env`, keep a `.env.example` with placeholder values, and never log secret values.',
  },
];

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface CompiledRule {
  id: string;
  risk: string;
  why: string;
  instead: string;
  patterns: RegExp[];
  exclude: RegExp[];
  vetoOnUi: boolean;
}

function compile(langs: Lang[]): CompiledRule[] {
  return SPECS.map((spec) => {
    const patterns = [...(spec.raw ?? [])];
    for (const lang of langs) {
      const lex = LEXICONS[lang];
      for (const vt of spec.verbTargets ?? []) {
        const verb = stems(lex.verbs[vt.verb]);
        const target = vt.target(lex);
        // A unicode-aware "not preceded by a word character" instead of `\b`: the target can
        // be a filename like `\.env`, and `\b` before a literal dot never matches after a
        // space. That one character is why "commit the .env so it deploys" used to slip past.
        patterns.push(new RegExp(`\\b${verb}\\b[^\n]{0,${WINDOW}}${NOT_WORD}${target}`, 'iu'));
        if (vt.bidirectional) {
          patterns.push(new RegExp(`${NOT_WORD}${target}[^\n]{0,${WINDOW}}\\b${verb}`, 'iu'));
        }
      }
    }
    return {
      id: spec.id,
      risk: spec.risk,
      why: spec.why,
      instead: spec.instead,
      patterns,
      exclude: spec.exclude ?? [],
      vetoOnUi: spec.vetoOnUi ?? false,
    };
  });
}

/**
 * Negation adjacent to a risky verb, per language. The two-word window is the whole point:
 * a bare "no" anywhere in the prompt would let "no me importa, desactiva el RLS" through.
 * The gap matches words followed by whitespace only — the comma in "no me importa," breaks
 * the chain, which is exactly the distinction between refusing and not caring.
 */
function compileNegations(langs: Lang[]): RegExp[] {
  return langs.map((lang) => {
    const lex = LEXICONS[lang];
    const allVerbs = stems(Object.values(lex.verbs).flat());
    const neg = group(lex.negations);
    return new RegExp(`\\b${neg}\\b\\s+(?:[\\p{L}\\p{N}_'’-]+\\s+){0,2}${allVerbs}\\b`, 'iu');
  });
}

/** Talking ABOUT a control — explaining it, documenting it, testing it — is never an attack. */
const DISCUSSION: RegExp[] = [
  /\b(explain|document\w*|describe|why\s+(is|does|would|should)|what\s+(is|does)|how\s+(does|do)\s+I)\b/i,
  /\b(explica\w*|documenta\w*|describe|por\s+qu[ée]|qu[ée]\s+(es|significa)|c[óo]mo\s+(hago|puedo))\b/iu,
  /\b(explique|documente|descreva|por\s+que|o\s+que\s+[ée]|como\s+(fa[çc]o|posso))\b/iu,
  /\b(unit\s+test|test\s+that|write\s+a\s+test|add\s+a\s+test|prueba\s+unitaria|teste\s+unit[áa]rio)\b/iu,
  // Reporting what vibeward found is discussion. The bare product name is not: a keyword
  // that vetoes all eight rules on its own is a one-word bypass, and it used to disarm the
  // guard for exactly the prompts most likely to follow a finding — "vibeward says RLS is
  // off, just disable it then". So the name only excuses a clause when it sits next to a
  // verb of reporting.
  /\bvibeward\b[^\n]{0,40}\b(says?|said|report\w*|found|flags?|flagged|dice|dijo|reporta\w*|encontr[óo]|marc[óo]|diz|disse|achou|apontou)\b/i,
  /\b(says?|said|report\w*|found|flags?|flagged|dice|dijo|reporta\w*|encontr[óo]|diz|disse|achou)\b[^\n]{0,40}\bvibeward\b/i,
  // Moving a secret OUT of the client is the fix, not the hole. Without this, the single
  // most desirable prompt in the whole product ("move the service_role key out of the
  // client bundle") gets flagged as the thing it repairs.
  // `del?` and `d[oa]` carry the contraction Spanish and Portuguese make and English does
  // not: "fuera DEL cliente", "para fora DO cliente", "out of THE client".
  /\b(out\s+of|away\s+from|off\s+of|fuera\s+del?|lejos\s+del?|para\s+fora\s+d[oa]s?|longe\s+d[oa]s?)\s+(the\s+|el\s+|la\s+|o\s+|a\s+)?(client|frontend|front[-\s]?end|browser|bundle|repo|code|cliente|navegador|c[óo]digo)\b/iu,
];

const UI_NOUNS: RegExp[] = LANGS.map(
  (l) => new RegExp(`\\b${group(LEXICONS[l].uiNouns)}\\p{L}*\\b`, 'iu'),
);

const RULES = compile(LANGS);
const NEGATIONS = compileNegations(LANGS);

/**
 * Invisible characters: the soft hyphen, zero-width space/non-joiner/joiner, the
 * left-to-right and right-to-left marks, the word joiner, and the BOM. Written as escapes
 * on purpose — as literals this class is an empty-looking pair of brackets that the next
 * person to touch it cannot review.
 */
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

/**
 * Folds the prompt to one canonical encoding before any rule sees it. `ＲＬＳ` is three
 * fullwidth codepoints that no rule matches and every human reads as RLS, and a U+200B
 * between two letters is invisible in every editor. NFKC folds the first, the
 * strip removes the second.
 *
 * Deliberately light: this normalizes ENCODING, not spelling. Undoing `r.l.s` or
 * `d i s a b l e` would mean matching every target across arbitrary separators, and each of
 * the eight rules would start firing inside ordinary prose. The person on the other side of
 * this hook is being protected, not attacking their own guardrail — and the one place that
 * assumption does not hold is text the agent *received* rather than the user typed, which
 * needs a different event, not a stricter regex.
 */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Sentence-ish clauses, and the reason this function exists at all.
 *
 * Every veto used to be tested against the WHOLE prompt, so a single benign clause anywhere
 * in it disarmed all eight rules at once: "explain how sessions work. now disable RLS so the
 * query passes" was excused by the word `explain` and walked straight through. Same for a
 * stray `e2e`, a stray `not`, a stray `gitignore`. Rules and vetoes are both evaluated
 * inside one clause now, so a veto only ever excuses the sentence it appears in.
 *
 * Splitting only on a sentence ender FOLLOWED BY whitespace is the whole trick: a bare dot
 * would cut `.env`, `docker-compose.local.yml` and `v2.1` in half, and "commit the .env so
 * it deploys" — a case this suite has caught since v0.1 — would stop matching.
 */
const CLAUSE_BREAK = /[.!?;]+(?=\s|$)|[\n\r]+/;

function clauses(text: string): string[] {
  return text
    .split(CLAUSE_BREAK)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Runs the intent rules over a user's prompt and returns matched risks, at most one per
 * rule however many clauses it fires in — the agent needs the rule once, not a tally.
 */
export function scanIntent(prompt: string): IntentFinding[] {
  const found = new Map<string, IntentFinding>();

  for (const clause of clauses(normalize(prompt))) {
    if (DISCUSSION.some((p) => p.test(clause))) continue;
    if (NEGATIONS.some((p) => p.test(clause))) continue;
    if (UNIVERSAL_EXCLUDES.some((p) => p.test(clause))) continue;

    const hasUiNoun = UI_NOUNS.some((p) => p.test(clause));

    for (const rule of RULES) {
      if (found.has(rule.id)) continue;
      if (rule.vetoOnUi && hasUiNoun) continue;
      if (rule.exclude.some((p) => p.test(clause))) continue;
      if (rule.patterns.some((p) => p.test(clause))) {
        found.set(rule.id, { id: rule.id, risk: rule.risk, why: rule.why, instead: rule.instead });
      }
    }
  }
  return [...found.values()];
}
