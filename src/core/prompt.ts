// Zero-dependency interactive selectors for `vibeward init`: raw-mode keypresses,
// in-place repaint, and a `finally` that always hands the terminal back.
import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import { C, write } from './terminal.js';

export interface Choice {
  value: string;
  label: string;
  /** Extra context printed dimmed after the label (a path, a strategy). */
  hint?: string;
  /** Why it cannot be picked. Present = drawn greyed out, with the reason, and skipped. */
  disabled?: string;
  /** Pre-checked in `multiselect`; `select` only uses it to place the cursor. */
  selected?: boolean;
}

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
/** Erase from the cursor to the end of the screen. */
const CLEAR_BELOW = '\x1b[0J';

const POINTER = '❯';

/** Both ends must be a terminal: we read raw keys from one and repaint the other. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** A piece of a line plus its color, so the row can be clipped by visible width. */
type Segment = [color: string, text: string];

/**
 * Joins segments, clipping to the terminal width. A line that wraps would occupy
 * two rows and desync the line count the repaint moves the cursor up by, leaving
 * a trail of stale blocks on screen.
 */
function renderRow(segments: Segment[], width: number): string {
  let out = '';
  let used = 0;
  for (const [color, text] of segments) {
    if (used >= width) break;
    const slice = text.slice(0, width - used);
    used += slice.length;
    out += color ? `${color}${slice}${C.reset}` : slice;
  }
  return out;
}

/** Next selectable index in `dir`, wrapping around and skipping disabled rows. */
function step(from: number, dir: 1 | -1, choices: Choice[]): number {
  const n = choices.length;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (!choices[i]!.disabled) return i;
  }
  return from;
}

function rowSegments(
  choice: Choice,
  state: { cursor: boolean; checked: boolean; multi: boolean; pad: number },
): Segment[] {
  const suffix = choice.disabled ?? choice.hint;
  const label = suffix ? choice.label.padEnd(state.pad) : choice.label;

  if (choice.disabled) return [[C.gray, `  ○ ${label}  ${choice.disabled}`]];

  const mark = state.multi ? (state.checked ? '◉' : '○') : state.cursor ? '●' : '○';
  const markColor = (state.multi ? state.checked : state.cursor) ? C.cyan : C.gray;
  const segments: Segment[] = [
    [C.cyan, state.cursor ? `${POINTER} ` : '  '],
    [markColor, `${mark} `],
    [state.cursor ? C.bold : '', label],
  ];
  if (choice.hint) segments.push([C.dim, `  ${choice.hint}`]);
  return segments;
}

/**
 * The shared driver. Resolves the picked indices, or null when the user cancels;
 * cancelling never kills the process — the caller decides what that means.
 */
async function prompt(title: string, choices: Choice[], multi: boolean): Promise<string[] | null> {
  if (!isInteractive()) {
    throw new Error(
      'prompt requires a TTY on both stdin and stdout. Call isInteractive() first and fall back to flags (--scope, --targets, --yes).',
    );
  }
  if (choices.length === 0) throw new Error('prompt requires at least one choice.');
  if (choices.every((c) => c.disabled)) throw new Error('prompt requires one selectable choice.');

  const stdin = process.stdin;
  const pad = Math.min(32, Math.max(...choices.map((c) => c.label.length)));

  let cursor = choices.findIndex((c) => !c.disabled && c.selected);
  if (cursor < 0) cursor = choices.findIndex((c) => !c.disabled);
  const checked = new Set<number>(
    multi ? choices.map((c, i) => (c.selected && !c.disabled ? i : -1)).filter((i) => i >= 0) : [],
  );

  const help = multi
    ? '↑/↓ move · space toggle · a all · enter confirm · esc cancel'
    : '↑/↓ move · enter confirm · esc cancel';

  let painted = 0;
  const paint = (): void => {
    const width = Math.max(20, (process.stdout.columns || 80) - 1);
    const lines = [
      renderRow(
        [
          [C.cyan, '? '],
          [C.bold, title],
        ],
        width,
      ),
      ...choices.map((c, i) =>
        renderRow(
          rowSegments(c, { cursor: i === cursor, checked: checked.has(i), multi, pad }),
          width,
        ),
      ),
      renderRow([[C.dim, `  ${help}`]], width),
    ];
    // Rewind over the previous block and wipe it, so the screen never scrolls.
    if (painted > 0) write(`\x1b[${painted}A${CLEAR_BELOW}`);
    write(`${lines.join('\n')}\n`);
    painted = lines.length;
  };

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  write(HIDE_CURSOR);

  try {
    const picked = await new Promise<number[] | null>((resolve) => {
      const onKey = (str: string | undefined, key: Key | undefined): void => {
        const name = key?.name;
        if ((key?.ctrl && name === 'c') || name === 'escape') return resolve(null);

        if (name === 'up' || name === 'k') cursor = step(cursor, -1, choices);
        else if (name === 'down' || name === 'j') cursor = step(cursor, 1, choices);
        else if (name === 'return' || name === 'enter') {
          if (multi) return resolve([...checked].sort((a, b) => a - b));
          return resolve([cursor]);
        } else if (multi && (name === 'space' || str === ' ')) {
          if (checked.has(cursor)) checked.delete(cursor);
          else checked.add(cursor);
        } else if (multi && name === 'a' && !key?.ctrl && !key?.meta) {
          const selectable = choices.map((c, i) => (c.disabled ? -1 : i)).filter((i) => i >= 0);
          const allOn = selectable.every((i) => checked.has(i));
          checked.clear();
          if (!allOn) for (const i of selectable) checked.add(i);
        } else return;

        paint();
      };
      stdin.on('keypress', onKey);
      paint();
    });

    // Drop the interactive block and leave a single line of scrollback behind.
    if (painted > 0) write(`\x1b[${painted}A${CLEAR_BELOW}`);
    painted = 0;
    if (picked === null) {
      write(`${C.gray}✗ ${title} — cancelled${C.reset}\n`);
      return null;
    }
    const labels = picked.map((i) => choices[i]!.label);
    const answer = labels.length > 0 ? labels.join(', ') : 'nothing selected';
    write(`${C.green}✓${C.reset} ${title} ${C.cyan}${answer}${C.reset}\n`);
    return picked.map((i) => choices[i]!.value);
  } finally {
    stdin.setRawMode(false);
    stdin.removeAllListeners('keypress');
    stdin.pause();
    write(SHOW_CURSOR);
  }
}

/** Single choice. Resolves null if the user cancels (Ctrl-C / Esc). */
export async function select(title: string, choices: Choice[]): Promise<string | null> {
  const picked = await prompt(title, choices, false);
  return picked === null ? null : (picked[0] ?? null);
}

/** Multiple choice. Resolves null if the user cancels (Ctrl-C / Esc). */
export async function multiselect(title: string, choices: Choice[]): Promise<string[] | null> {
  return prompt(title, choices, true);
}
