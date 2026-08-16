// The three detectors, behind one shape. Each takes whatever the host handed us for that
// moment and returns Risks; none of them knows which host it is running under.
//
// The `action` detector is the only one that writes no new rules: it reuses the same
// functions the folder scan uses, pointed at the file that has not been written yet instead
// of the repo that already was. `scanSource(text, relPath)` and `analyzeMigrations([{path,
// content}])` were already the right shape for this — the whole change is *when* they run.

import { scanIntent } from '../checks/intent.js';
import { scanInjection } from '../checks/injection.js';
import { scanSource } from '../checks/secrets.js';
import { analyzeMigrations } from '../checks/migrations.js';
import type { Finding } from '../core/types.js';
import type { Risk } from './verdict.js';

/** Files whose contents are worth scanning for a pending write. */
const SQL_FILE = /\.sql$/i;

/** Never worth scanning: vibeward's own machinery and vendored code. */
const NOT_SOURCE = /(^|[\\/])(\.git[\\/]|node_modules[\\/]|dist[\\/]|build[\\/]|\.next[\\/])/i;

/** A real `.env`, where a secret belongs. */
const ENV_FILE = /(^|[\\/])\.env(\.[\w-]+)?$/i;

/** A sample env file, which is committed and must therefore hold no real value. */
const ENV_SAMPLE = /(^|[\\/])\.env\.(example|sample|template|dist|defaults)$/i;

/**
 * Env var names that a bundler inlines into the browser bundle. This is the whole reason
 * `.env` cannot simply be skipped.
 *
 * `.env` is the correct home for a secret, so flagging every key in it would fire on the fix
 * rather than the problem — but the actual leak shape in a vibe-coded app is a service key
 * given a public prefix, because the app "did not work" until the browser could see it.
 * `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=…` is a correct-looking line in a correct-looking
 * file, and it ships the key to every visitor. Skipping `.env` wholesale made that invisible.
 */
const PUBLIC_PREFIX =
  /^\s*(?:export\s+)?(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|GATSBY_|NUXT_PUBLIC_|VUE_APP_)/im;

/** The line a finding sits on, so an env key can be judged by its own name. */
function lineOf(text: string, source: string | undefined): string {
  const n = Number(source?.match(/:(\d+)$/)?.[1]);
  return Number.isFinite(n) ? (text.split('\n')[n - 1] ?? '') : '';
}

/** Test and fixture paths, where a fake key is the point. */
const FIXTURE =
  /(^|[\\/])(test|tests|__tests__|__mocks__|spec|fixtures?|examples?|e2e|cypress|playwright)[\\/]|\.(test|spec|fixture|stories)\.[jt]sx?$/i;

/**
 * Client-side paths. Used only to sharpen the message, never to decide: a service key is a
 * finding wherever it is written, but "this file ships to the browser" is the sentence that
 * makes someone act.
 */
const CLIENT_PATH =
  /(^|[\\/])(src|app|components|pages|client|public|static|assets)[\\/]|\.(jsx|tsx|vue|svelte)$/i;

/**
 * What to do instead, keyed on what the finding actually is.
 *
 * An earlier version had two branches — RLS and everything-else — so a `USING (true)` policy,
 * a `SECURITY DEFINER` function and a `GRANT … TO anon` all came back advising the reader to
 * rotate a key. There is no key involved in any of them, and advice that does not match the
 * finding is worse than none: it is the sentence that teaches someone the tool does not know
 * what it is looking at.
 */
function insteadFor(f: Finding): string {
  if (f.id.startsWith('rls_turned_off_') || f.id.startsWith('rls_disabled_')) {
    return 'Leave RLS on and write a policy that matches the rows the query needs, such as `USING (auth.uid() = user_id)`. A query returning nothing is the protection working, not a bug in it.';
  }
  if (f.id.startsWith('policy_dropped_')) {
    return 'Check what policies remain on that table before applying this. A table with RLS on and no policy denies everyone, and the usual next step is to disable RLS rather than to write the policy back.';
  }
  if (f.id === 'permissive_policy') {
    return 'Replace `USING (true)` with the condition that actually describes who may see the row — `auth.uid() = user_id` for owner-scoped data. A policy that is always true is the same as no policy.';
  }
  if (f.id === 'security_definer') {
    return 'Run the function as the caller unless it genuinely needs to escalate, and if it does, pin `search_path` and validate every argument. SECURITY DEFINER runs with the owner rights and bypasses the caller policies.';
  }
  if (f.id.startsWith('grant_') || f.id.includes('anon')) {
    return 'Grant to `authenticated` rather than `anon` or `public`, and let RLS decide the rows. Anyone with the publishable key holds the anon role.';
  }
  return 'Read the value from a server-side environment variable and keep it out of anything the client downloads. If this key has already been committed or deployed, it has to be rotated — deleting the line does not un-leak it.';
}

function fromFinding(f: Finding, filePath: string): Risk {
  // Only said about a file that really is bundled. SQL migrations and server-only modules can
  // sit under `src/` too, and telling someone their migration ships to the browser is a claim
  // that is simply false.
  const clientSide = CLIENT_PATH.test(filePath) && !/\.sql$/i.test(filePath);
  return {
    id: f.id,
    risk: f.label,
    why: [f.why, f.impact, clientSide ? 'This path is bundled and served to the browser.' : '']
      .filter(Boolean)
      .join(' '),
    instead: insteadFor(f),
    quote: f.evidence,
    source: f.source ?? filePath,
  };
}

/** A prompt the user submitted. */
export function scanPromptMoment(prompt: string): Risk[] {
  return scanIntent(prompt).map((r) => ({
    id: r.id,
    risk: r.risk,
    why: r.why,
    instead: r.instead,
  }));
}

export interface PendingWrite {
  filePath: string;
  content: string;
}

/**
 * A file the agent is about to write. Only the pending content is examined — never the file
 * on disk, which may be the very thing being replaced.
 */
export function scanWriteMoment({ filePath, content }: PendingWrite): Risk[] {
  if (!filePath || !content) return [];
  if (NOT_SOURCE.test(filePath)) return [];

  const risks: Risk[] = [];
  const isEnv = ENV_FILE.test(filePath) && !ENV_SAMPLE.test(filePath);
  const isSample = ENV_SAMPLE.test(filePath);

  if (!FIXTURE.test(filePath)) {
    for (const f of scanSource(content, filePath)) {
      const line = lineOf(content, f.source);
      // In a real `.env`, only a key the bundler will publish is a finding — the rest are
      // secrets sitting exactly where they belong.
      if (isEnv && !PUBLIC_PREFIX.test(line)) continue;
      // In `.env.example`, a placeholder is the point. Only a value that survives the
      // placeholder filter AND looks live is worth raising, and the pattern set already
      // rejects `your_key_here`-shaped values — so what is left is a real key in a file that
      // gets committed. Keep it, but say which problem it is.
      if (isSample) {
        risks.push({
          ...fromFinding(f, filePath),
          risk: `${f.label} — in a sample file that gets committed`,
          instead:
            'Sample env files are committed, so every value in one is public. Replace it with an obvious placeholder. If this value is real, it is already exposed and has to be rotated.',
        });
        continue;
      }
      risks.push(fromFinding(f, filePath));
    }
  }

  if (SQL_FILE.test(filePath) || /\b(alter|create)\s+table\b/i.test(content)) {
    // `supabaseContext: false` on purpose: a single pending file is not enough evidence that
    // the project uses the RLS model at all, and "this new table has no RLS" on a Prisma app
    // whose database sits behind a server is a false accusation. The rules that matter here —
    // RLS switched off, a policy dropped, `USING (true)`, SECURITY DEFINER — do not depend on
    // that flag and fire regardless.
    const path = SQL_FILE.test(filePath) ? filePath : `${filePath} (inline SQL)`;
    for (const f of analyzeMigrations([{ path, content }])) {
      if (f.id.startsWith('rls_disabled_')) continue;
      risks.push(fromFinding(f, filePath));
    }
  }

  return dedupe(risks);
}

/**
 * A shell command the agent is about to run. Deliberately narrow: the interesting commands
 * are the ones that change a security posture or move a secret, and everything else an agent
 * runs all day (`npm`, `git status`, `ls`) must stay silent or the gate becomes noise.
 */
const COMMAND_RULES: { id: string; pattern: RegExp; risk: string; why: string; instead: string }[] =
  [
    {
      id: 'cmd-disable-rls',
      pattern: /disable\s+row\s+level\s+security/i,
      risk: 'This command switches off Row Level Security',
      why: 'With RLS off, every policy on the table stops applying and the whole table becomes readable — usually writable too — through the public API with the anon key that ships in the browser.',
      instead:
        'Leave RLS on and fix the policy instead. A query that returns nothing is the protection working.',
    },
    {
      id: 'cmd-commit-env',
      // Two fixes over the obvious version. The path is bounded to the same argument list —
      // `[^\n]` let it run across `&&`, `;` and `#`, so `git add .gitignore && git commit -m
      // "ignore .env"` matched the remediation itself. And the blanket forms are matched
      // wherever they appear rather than only at end of line, because `git add . && git
      // commit -m wip` is how the file actually gets staged.
      pattern:
        /\bgit\s+add\b[^\n&;|#]{0,60}(?<![\w.])\.env\b(?!\.(?:example|sample|template|dist))|\bgit\s+add\s+(?:-A\b|--all\b|\.(?=\s|$))/i,
      risk: 'This command may stage a file that holds credentials',
      why: 'Once `.env` is committed, every credential in it is in the repository history, and it stays there after the file is deleted. A blanket `git add .` stages whatever is untracked, including a `.env` nobody remembered to ignore.',
      instead:
        'Add `.env` to `.gitignore` and stage files by name. If it has already been committed, the credentials in it have to be rotated.',
    },
    {
      id: 'cmd-skip-verification',
      pattern:
        /--no-verify\b|--insecure\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0\b|curl[^\n]{0,40}\s-k\b/i,
      risk: 'This command turns off a verification step',
      why: 'Skipping hook, certificate or TLS verification removes a check that exists to catch exactly the kind of mistake being made right now, and the flag usually outlives the reason it was added.',
      instead:
        'Fix what the check is complaining about. If it has to be skipped once, do it interactively rather than writing the flag into a script.',
    },
    {
      id: 'cmd-secret-to-network',
      pattern:
        /\b(?:curl|wget|nc|http)\b[^\n]{0,120}\$\{?(?:[A-Z_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z_]*)\}?/,
      risk: 'This command sends a credential over the network',
      why: 'The command interpolates a secret from the environment into a request. Whatever is on the other end receives it in full, and it will be in the shell history either way.',
      instead:
        'Do not put secrets in a command line. If a service needs it, let the SDK read it from the environment on the server side.',
    },
  ];

export function scanCommandMoment(command: string): Risk[] {
  if (!command) return [];
  const risks: Risk[] = [];
  for (const rule of COMMAND_RULES) {
    const m = command.match(rule.pattern);
    if (!m) continue;
    risks.push({
      id: rule.id,
      risk: rule.risk,
      why: rule.why,
      instead: rule.instead,
      quote: m[0].slice(0, 200),
      source: 'shell command',
    });
  }
  return risks;
}

/** Content the agent read: a file, a page, an MCP result. */
export function scanContentMoment(text: string, source: string): Risk[] {
  return scanInjection(text, source).map((r) => ({
    id: r.id,
    risk: r.risk,
    why: r.why,
    instead: r.instead,
    quote: r.quote,
    source: r.source,
  }));
}

function dedupe(risks: Risk[]): Risk[] {
  const seen = new Map<string, Risk>();
  for (const r of risks) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}
