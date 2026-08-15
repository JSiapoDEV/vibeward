// The intent gate is judged on precision, not recall. A rule that fires on "remove the
// login button from the navbar" costs the user the prompt they just typed, and a guardrail
// that cries wolf is uninstalled within the hour. So the benign corpus is the real test
// suite here: every entry is a prompt a working developer types on an ordinary Tuesday,
// and every one of them must come back clean.
import { scanIntent } from '../src/checks/intent.js';

let pass = 0;
let fail = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

/** Ordinary prompts that must never fire a rule. Each one is a real-world trap. */
const BENIGN: [prompt: string, trap: string][] = [
  ['make the getUser method public in the UserService class', '`public` is an access modifier'],
  ['make this field public so the subclass can use it', '`public` on a field'],
  ['make the repo public on GitHub', 'repository visibility'],
  ['make the docs page public', 'a marketing page is not a datastore'],
  ['remove the login button from the navbar', 'login UI, not the auth check'],
  ['remove the auth page from the marketing site, we moved it', 'a route move'],
  ['skip the login screen in the Playwright e2e test using a storage state', 'test setup'],
  ['disable auth in docker-compose.local.yml for local dev only', 'local dev config'],
  ['comment out the sign-in banner for now', 'a banner'],
  ['skip validation for the optional middle_name field', '`validation` is not a control'],
  ['ignore the eslint check on this line', 'a linter is not security'],
  ['disable the type check in the generated file', 'tsc is not security'],
  ['bypass the cache check when the flag is set', '`check` is everywhere'],
  ['turn off the validation spinner animation', 'an animation'],
  ["skip the null check here, it's already guarded", 'a null check'],
  ['return the token from the /login endpoint so the SPA can store it', 'the correct auth flow'],
  ['log the api key name (not the value) for debugging', 'the name, not the secret'],
  ['print the token type and length for debugging', 'metadata, not the secret'],
  ['add .env to gitignore', 'the opposite of committing it'],
  ['we should commit .env.example so people know the shape', '.env.example is meant to ship'],
  ['drop the rls_test table from the fixtures', 'a fixture table named after RLS'],
  ['write a test that a user without RLS policy gets zero rows', 'a test asserting RLS works'],
  ['explain why disabling RLS is dangerous', 'a question about the risk'],
  ['document that we must never disable RLS', 'documentation of the rule itself'],
  ['add a CORS config that does NOT allow all origins', 'negation next to the verb'],
  ['hardcode the key of the map in the config object', 'a map key, not a secret'],
  ['use a stable key for each item in the list', 'a React key'],
  ['remove the check for empty arrays', 'an array check'],
  ['how do I disable auth for a single public route without breaking the rest?', 'a question'],
  ['why does Supabase require RLS on every table?', 'a question'],
  ['the vibeward report says RLS is off — what does that mean?', 'discussing a finding'],
  ['refactor the auth middleware to use the new session helper', 'keeping auth, refactoring it'],
  ['add rate limiting to the login endpoint', 'adding a control'],
  ['set the storage bucket to private', 'the safe direction'],
  ['move the service_role key out of the client bundle', 'the fix, not the hole'],
];

/** Requests that must be caught. Losing one of these is the whole point of the tool. */
const RISKY: [prompt: string, id: string][] = [
  ['disable RLS so the query works', 'disable-rls'],
  ['just turn off row level security for now', 'disable-rls'],
  ['turn RLS off on the profiles table', 'disable-rls'],
  ['desactiva el RLS para que funcione', 'disable-rls'],
  ['use the service_role key in the frontend', 'service-role-client'],
  ['put the service role key in the react app so it can read everything', 'service-role-client'],
  ["expose the service_role key, it's easier", 'service-role-client'],
  ['make the bucket public so I can see the images', 'make-public'],
  ['set the users table public to debug', 'make-public'],
  ['allow public read access to the storage bucket', 'make-public'],
  ['haz público el bucket de imágenes', 'make-public'],
  ['remove the auth check from the dashboard route', 'remove-auth'],
  ['bypass authentication on the admin endpoint', 'remove-auth'],
  ['skip the auth middleware so I can test faster', 'remove-auth'],
  ['quita la autenticación del endpoint', 'remove-auth'],
  ['allow all origins in cors', 'cors-wildcard'],
  ['set access-control-allow-origin to *', 'cors-wildcard'],
  ['put the api key directly in the code', 'hardcode-secret'],
  ['hardcode the api key in the component', 'hardcode-secret'],
  ['disable csrf protection so the form submits', 'disable-security'],
  ['turn off rate limiting on the api', 'disable-security'],
  ['commit the .env so it deploys', 'commit-env'],
  ["log the secret to check if it's loaded", 'commit-env'],
];

/**
 * Spanish and Portuguese get the same treatment as English, benign corpus first. A language
 * that only detects the imperative and has no exclusions is worse than no language at all:
 * the gap is invisible, and "quita el botón de login" fires while "desactives el RLS" walks.
 */
const BENIGN_ES: [prompt: string, trap: string][] = [
  ['quita el botón de login del header', 'login UI'],
  ['elimina la animación del spinner', 'an animation'],
  ['haz público el repositorio', 'repo visibility'],
  ['el método debe ser público en la clase', '`público` as an access modifier'],
  ['no desactives el RLS, arregla la policy', 'negation next to the verb'],
  ['por ningún motivo desactives el RLS', 'negation, subjunctive form'],
  ['explica por qué desactivar el RLS es peligroso', 'a question about the risk'],
  ['añade .env al gitignore', 'the opposite of committing it'],
  ['imprime el nombre de la api key, no el valor', 'the name, not the secret'],
  ['devuelve el token desde /login para que el SPA lo guarde', 'the correct auth flow'],
  ['quita la validación del campo opcional', '`validación` is not a control'],
  ['ignora el eslint en esta línea', 'a linter is not security'],
  ['mueve la service_role key fuera del cliente', 'the fix, not the hole'],
  ['pon el bucket en privado', 'the safe direction'],
  ['refactoriza el middleware de auth para usar el nuevo helper', 'keeping auth'],
];

const BENIGN_PT: [prompt: string, trap: string][] = [
  ['remove o botão de login da navbar', 'login UI'],
  ['remova a animação do spinner', 'an animation'],
  ['torna o repositório público', 'repo visibility'],
  ['não desative o RLS, corrija a policy', 'negation next to the verb'],
  ['explique por que desativar o RLS é perigoso', 'a question about the risk'],
  ['adicione .env ao gitignore', 'the opposite of committing it'],
  ['imprima o nome da api key, não o valor', 'the name, not the secret'],
  ['retorne o token do /login para o SPA guardar', 'the correct auth flow'],
  ['ignore o eslint nesta linha', 'a linter is not security'],
  ['mova a service_role key para fora do cliente', 'the fix, not the hole'],
  ['deixe o bucket privado', 'the safe direction'],
];

const RISKY_ES: [prompt: string, id: string][] = [
  ['desactiva el RLS para que funcione', 'disable-rls'],
  ['apaga el row level security de la tabla', 'disable-rls'],
  ['deshabilita el RLS un momento', 'disable-rls'],
  ['pon la service_role key en el frontend', 'service-role-client'],
  ['haz público el bucket de imágenes', 'make-public'],
  ['quita la autenticación del endpoint', 'remove-auth'],
  ['sáltate la autenticación del admin', 'remove-auth'],
  ['sube el .env al repo', 'commit-env'],
  ['desactiva el csrf para que el formulario envíe', 'disable-security'],
  ['permite todos los orígenes en cors', 'cors-wildcard'],
];

const RISKY_PT: [prompt: string, id: string][] = [
  ['desativa o RLS pra funcionar', 'disable-rls'],
  ['desliga o row level security da tabela', 'disable-rls'],
  ['coloque a service_role key no frontend', 'service-role-client'],
  ['deixe o bucket público para eu ver as imagens', 'make-public'],
  ['remova a autenticação do endpoint', 'remove-auth'],
  ['pule a autenticação do admin', 'remove-auth'],
  ['suba o .env pro repositório', 'commit-env'],
  ['desative o csrf para o formulário enviar', 'disable-security'],
  ['permita todas as origens no cors', 'cors-wildcard'],
];

/**
 * All three languages compile into one matcher, so every Portuguese stem is also checked
 * against English prose. These are the collisions that actually happened while building it:
 * `pul` ate "pull request", `sub` ate "subscribe", `tir` ate "tired", `envi` ate "envision".
 * They are the reason lexicon.ts supports pinned exact forms, and this suite is what stops
 * the next short stem from quietly reintroducing one.
 */
const CROSS_LANGUAGE: string[] = [
  'pull the latest auth changes from main',
  'open a pull request that adds auth to the endpoint',
  'port the auth middleware to the new framework',
  'the portal needs auth on every page',
  'add a color column to the users table',
  'exclude the auth header from the public request',
  'the collection needs auth before it loads data',
  'subscribe the user to the .env watcher',
  'submit the form to the auth endpoint',
  'envision a public dashboard for the data',
  'the tired auth flow needs a rewrite',
  'show the token count in the data table',
  'mostly the data is public already',
];

/**
 * The negation veto has to sit NEXT TO the risky verb. A bare "not" anywhere in the
 * prompt would hand out a free pass to anyone who says "I don't care, disable RLS".
 */
const NOT_A_FREE_PASS: string[] = [
  "I don't care, disable RLS",
  "I don't like writing policies so just disable RLS",
  'no me importa, desactiva el RLS',
  'não me importo, desativa o RLS',
  'the build does not work, turn off RLS',
];

let fp = 0;
let total = 0;

function benignSuite(label: string, corpus: [string, string][]): void {
  console.log(`\nIntent gate — benign prompts, ${label} (precision)\n`);
  for (const [prompt, trap] of corpus) {
    const hits = scanIntent(prompt);
    total++;
    if (hits.length > 0) fp++;
    assert(hits.length === 0, `${trap} — "${prompt.slice(0, 52)}"`);
  }
}

function riskySuite(label: string, corpus: [string, string][]): void {
  console.log(`\nIntent gate — risky prompts, ${label} (recall)\n`);
  for (const [prompt, id] of corpus) {
    const hits = scanIntent(prompt).map((h) => h.id);
    assert(hits.includes(id), `${id} — "${prompt.slice(0, 52)}"`);
  }
}

benignSuite('English', BENIGN);
benignSuite('Spanish', BENIGN_ES);
benignSuite('Portuguese', BENIGN_PT);
riskySuite('English', RISKY);
riskySuite('Spanish', RISKY_ES);
riskySuite('Portuguese', RISKY_PT);

console.log('\nIntent gate — a Portuguese stem must not eat an English word\n');
for (const prompt of CROSS_LANGUAGE) {
  const hits = scanIntent(prompt);
  total++;
  if (hits.length > 0) fp++;
  assert(hits.length === 0, `no collision — "${prompt.slice(0, 52)}"`);
}

console.log('\nIntent gate — negation cannot be used as a bypass\n');
for (const prompt of NOT_A_FREE_PASS) {
  assert(scanIntent(prompt).length > 0, `still caught — "${prompt.slice(0, 52)}"`);
}

console.log(`\nFalse positives: ${fp}/${total} across en + es + pt`);
console.log(
  fail === 0 ? `\n✅  ${pass} passed, 0 failed\n` : `\n❌  ${pass} passed, ${fail} failed\n`,
);
if (fail > 0) process.exit(1);
