// Intent gate: deterministic rules over what the USER asks an AI coding agent.
// The dangerous prompts of vibe-coders are the root cause of most holes
// ("disable RLS so it works", "use the service_role key in the frontend").
// This is intentionally NOT an LLM call — prompt-level guardrails that "ask the
// model nicely" are architecturally weak (see Meta's LlamaFirewall). Rules win.

export interface IntentFinding {
  id: string;
  risk: string;
  why: string;
  instead: string;
}

interface IntentRule {
  id: string;
  risk: string;
  patterns: RegExp[];
  why: string;
  instead: string;
}

const RULES: IntentRule[] = [
  {
    id: 'disable-rls',
    risk: 'Disabling Row-Level Security',
    patterns: [
      /\b(disable|turn\s*off|remove|drop|without)\b[^.]{0,30}\b(rls|row[-\s]?level\s+security)\b/i,
      /\b(desactiva|quita|sin|apaga)\b[^.]{0,30}\b(rls|seguridad a nivel de fila)\b/i,
    ],
    why: 'Turning off RLS makes every row in the table readable (and often writable) by anyone with the public anon key. This is the #1 cause of vibe-coded data leaks.',
    instead:
      'Keep RLS on and add an owner-scoped policy: `CREATE POLICY ... USING (auth.uid() = user_id)`. If a query fails, fix the policy — do not disable the protection.',
  },
  {
    id: 'service-role-client',
    risk: 'Putting the service_role key in the client',
    patterns: [
      /service[-_\s]?role[^.]{0,40}\b(client|frontend|front[-\s]?end|browser|react|next|vue)\b/i,
      /\b(client|frontend|browser)\b[^.]{0,40}service[-_\s]?role/i,
      /service[-_\s]?(role|key)[^.]{0,30}\b(expose|public)\b/i,
    ],
    why: 'The service_role key bypasses ALL Row-Level Security. In client code, anyone can extract it and read, modify or delete any table. It is the most dangerous key you have.',
    instead:
      'Use the anon key + RLS in the client. Do privileged work on the server (an Edge Function or backend) where the service_role key never reaches the browser.',
  },
  {
    id: 'make-public',
    risk: 'Making data or a bucket public to debug',
    patterns: [
      /\bmake\b[^.]{0,25}\b(it|the\s+\w+|table|bucket|data|api)\b[^.]{0,15}\bpublic\b/i,
      /\ballow\s+public\s+(access|read|write)\b/i,
      /\b(haz|hacer|pon)\b[^.]{0,20}\bp[úu]blic/i,
    ],
    why: 'Making a table or storage bucket public to "just debug" exposes real user data to the whole internet, and it almost never gets turned back off.',
    instead:
      'Debug with an authenticated test user and proper policies. Never open access to everyone, even temporarily.',
  },
  {
    id: 'remove-auth',
    risk: 'Removing or skipping authentication',
    patterns: [
      /\b(remove|disable|skip|bypass|turn\s*off|comment\s*out)\b[^.]{0,25}\b(auth|authentication|login|sign[-\s]?in)\b/i,
      /\b(quita|elimina|desactiva|sáltate|omite)\b[^.]{0,25}\b(login|auth|autenticaci|inicio de sesi)/i,
    ],
    why: 'Removing the auth check to move faster leaves sensitive routes and data open to anyone. Missing authorization is one of the most common breaches in AI-generated apps.',
    instead:
      'Keep auth on and check it on the SERVER for every protected route (`auth.uid()` / session validation), not just by hiding UI in the browser.',
  },
  {
    id: 'cors-wildcard',
    risk: 'Allowing all origins (CORS *)',
    patterns: [
      /\ballow\s+all\s+origins?\b/i,
      /cors[^.]{0,25}(\*|origin\s*[:=]\s*(true|['"]\*['"]))/i,
      /access-control-allow-origin[^.]{0,10}\*/i,
    ],
    why: 'CORS `*` lets any website call your API with the visitor’s credentials, enabling data theft from other sites.',
    instead:
      'Whitelist your exact domains: `cors({ origin: ["https://yourapp.com"] })`. Never use `*` on an authenticated API.',
  },
  {
    id: 'hardcode-secret',
    risk: 'Hardcoding a secret / API key',
    patterns: [
      /\bhard[-\s]?code\b[^.]{0,30}\b(key|secret|token|password|credential)\b/i,
      /\bput\b[^.]{0,20}\b(api\s*key|secret|token)\b[^.]{0,20}\b(in\s+the\s+code|directly|inline)\b/i,
    ],
    why: 'A hardcoded secret ends up in your repo and your build, where anyone with access can read it — and it stays in git history even after you remove it.',
    instead:
      'Read it from a server-side environment variable. Keep secrets out of the repo (git-ignore `.env`) and out of any client bundle.',
  },
  {
    id: 'disable-security',
    risk: 'Disabling a security control to make it work',
    patterns: [
      /\b(disable|turn\s*off|bypass|ignore|skip)\b[^.]{0,25}\b(security|csrf|validation|policy|policies|check|verification)\b/i,
      /\b(desactiva|ignora|sáltate|omite)\b[^.]{0,25}\b(seguridad|validaci|csrf|pol[íi]tica|verificaci)/i,
    ],
    why: 'Turning off a security control to fix an error hides the real bug and ships the hole to production, where it becomes an attacker’s entry point.',
    instead:
      'Find why the control rejects the request and fix that. A control that blocks you is usually catching a real problem.',
  },
  {
    id: 'commit-env',
    risk: 'Committing or exposing the .env file',
    patterns: [
      /\b(commit|push|add|include)\b[^.]{0,20}\.env\b/i,
      /\b(log|print|expose|return)\b[^.]{0,20}\b(api\s*key|secret|token|env)\b/i,
    ],
    why: 'Committing `.env` (or logging secrets) leaks every credential in it to your repo, your logs, or your users.',
    instead:
      'Git-ignore `.env`, keep a `.env.example` with placeholder values, and never log secret values.',
  },
];

/** Runs the intent rules over a user's prompt and returns matched risks. */
export function scanIntent(prompt: string): IntentFinding[] {
  const out: IntentFinding[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (seen.has(rule.id)) continue;
    if (rule.patterns.some((p) => p.test(prompt))) {
      seen.add(rule.id);
      out.push({ id: rule.id, risk: rule.risk, why: rule.why, instead: rule.instead });
    }
  }
  return out;
}
