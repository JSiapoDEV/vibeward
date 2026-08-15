import { scanIntent, type IntentFinding } from '../checks/intent.js';
import { C, readStdin } from '../core/terminal.js';
import { stalenessNotice } from '../core/version.js';

/**
 * Two ways to answer a risky prompt, and the default matters more than it looks.
 *
 * `context` (default) — exit 0 and print to stdout. UserPromptSubmit is the one event
 * where stdout is fed back into the model's context, so the rule reaches the agent that
 * is about to act: it reads why the request is dangerous and what to do instead, and
 * corrects itself. The user's prompt survives. A false positive costs one ignored note.
 *
 * `block` — exit 2. Claude Code blocks the prompt AND ERASES IT. That is the right
 * answer for a handful of unambiguous requests, and the wrong one for everything else:
 * a user who loses a paragraph they just typed uninstalls the hook, and then the
 * guardrail protects nobody. Opt in with `--block`.
 */
export type GuardMode = 'context' | 'block';

/** Written for the model, not for a terminal: no color, no box drawing, just the rule. */
function contextNote(risks: IntentFinding[]): string {
  const lines = [
    '<vibeward-security-guardrail>',
    'The user just asked for something that vibeward flags as a known cause of data leaks',
    'in AI-generated apps. This is a deterministic rule match, not a certainty — if it does',
    'not actually apply to what the user meant, ignore it and carry on.',
    '',
    'If it does apply: do not do it the way it was asked. Do the safe alternative instead,',
    'and tell the user in one line why you changed the approach.',
    '',
  ];
  for (const r of risks) {
    lines.push(`RISK: ${r.risk}`);
    lines.push(`WHY: ${r.why}`);
    lines.push(`DO INSTEAD: ${r.instead}`);
    lines.push('');
  }
  // Only ever rides along with a real match. Appending it to every prompt would put a
  // maintenance notice into the context of thousands of unrelated conversations, which is
  // how a useful nudge turns into noise the model learns to skip.
  const stale = stalenessNotice();
  if (stale) {
    lines.push(`ALSO TELL THE USER, ONCE, IN ONE LINE: ${stale}`);
    lines.push('');
  }
  lines.push('</vibeward-security-guardrail>');
  return lines.join('\n');
}

/** The human-facing block message. Colors collapse to plain when stdout is not a TTY. */
function blockMessage(risks: IntentFinding[]): string {
  const lines = [`${C.yellow}${C.bold}⚠  vibeward blocked a risky request${C.reset}`, ''];
  for (const r of risks) {
    lines.push(`${C.red}✗ ${r.risk}${C.reset}`);
    lines.push(`  ${C.dim}why:${C.reset} ${r.why}`);
    lines.push(`  ${C.green}do this instead:${C.reset} ${r.instead}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Claude Code / Cursor hook: gate a risky user request before the agent acts on it. */
export async function runGuard(mode: GuardMode): Promise<never> {
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

  if (mode === 'block') {
    // exit 2 blocks the prompt in a UserPromptSubmit hook; the message is stderr.
    const stale = stalenessNotice();
    console.error(blockMessage(risks) + (stale ? `${C.dim}${stale}${C.reset}\n` : ''));
    process.exit(2);
  }

  // exit 0 + stdout: the note lands in the agent's context instead of erasing the prompt.
  console.log(contextNote(risks));
  process.exit(0);
}
