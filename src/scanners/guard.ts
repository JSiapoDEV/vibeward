import { scanIntent } from '../checks/intent.js';
import { C, readStdin } from '../core/terminal.js';

/** Claude Code / Cursor hook: gate a risky user request before the agent acts on it. */
export async function runGuard(warnOnly: boolean): Promise<never> {
  const raw = await readStdin();
  let prompt = raw;
  try {
    const parsed = JSON.parse(raw) as { prompt?: string };
    if (typeof parsed.prompt === 'string') prompt = parsed.prompt;
  } catch {
    // treat stdin as a raw prompt
  }

  const risks = scanIntent(prompt);
  if (risks.length === 0) process.exit(0);

  const lines = [`${C.yellow}${C.bold}⚠  vibeward blocked a risky request${C.reset}`, ''];
  for (const r of risks) {
    lines.push(`${C.red}✗ ${r.risk}${C.reset}`);
    lines.push(`  ${C.dim}why:${C.reset} ${r.why}`);
    lines.push(`  ${C.green}do this instead:${C.reset} ${r.instead}`);
    lines.push('');
  }
  const msg = lines.join('\n');

  if (warnOnly) {
    console.log(msg);
    process.exit(0);
  }
  // exit 2 blocks the prompt in a Claude Code UserPromptSubmit hook (stderr is shown)
  console.error(msg);
  process.exit(2);
}
