// Drives the interactive selectors with a fake TTY: no real terminal, no pty, no hanging
// test. Keys go in as raw bytes, the painted output is captured, and the terminal state is
// checked afterwards — leaving a user's shell in raw mode with a hidden cursor is the
// worst thing this module could do.
import { PassThrough } from 'node:stream';

let pass = 0;
let fail = 0;

// Writes through the captured stdout: while a fake TTY is installed, console.log is
// redirected into the paint buffer and results would vanish.
const out = process.stdout.write.bind(process.stdout);

function assert(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    out(`  ✓ ${name}\n`);
  } else {
    fail++;
    out(`  ✗ ${name}\n`);
  }
}

interface FakeStdin extends PassThrough {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

const realStdin = process.stdin;
const realWrite = process.stdout.write.bind(process.stdout);
const realIsTTY = process.stdout.isTTY;

let painted = '';
let rawModeCalls: boolean[] = [];

function installFakeTty(): FakeStdin {
  const fake: FakeStdin = new PassThrough();
  fake.isTTY = true;
  fake.setRawMode = (mode: boolean): void => {
    rawModeCalls.push(mode);
  };
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  process.stdout.isTTY = true;
  painted = '';
  rawModeCalls = [];
  process.stdout.write = ((chunk: string): boolean => {
    painted += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return fake;
}

function restore(): void {
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
  process.stdout.write = realWrite;
  process.stdout.isTTY = realIsTTY;
}

/** Feeds keystrokes once the prompt has painted, so nothing is typed into the void. */
function type(fake: FakeStdin, keys: string[]): void {
  let i = 0;
  const next = (): void => {
    if (i >= keys.length) return;
    fake.write(keys[i]!);
    i++;
    setTimeout(next, 5);
  };
  setTimeout(next, 5);
}

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const SPACE = ' ';
const ESC = '\x1b';

const { select, multiselect, isInteractive } = await import('../src/core/prompt.js');

console.log('\nInteractive prompt (fake TTY)');
{
  const fake = installFakeTty();
  assert(isInteractive(), 'isInteractive() is true when both ends are a TTY');
  type(fake, [DOWN, ENTER]);
  const picked = await select('Scope', [
    { value: 'project', label: 'This project' },
    { value: 'user', label: 'My user account' },
  ]);
  restore();
  assert(picked === 'user', 'select: down + enter picks the second option');
  assert(rawModeCalls[0] === true, 'select: raw mode is turned on');
  assert(rawModeCalls[rawModeCalls.length - 1] === false, 'select: raw mode is turned back OFF');
  assert(painted.includes('\x1b[?25h'), 'select: the cursor is restored on the way out');
}

{
  const fake = installFakeTty();
  type(fake, [ESC]);
  const picked = await select('Scope', [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ]);
  restore();
  assert(picked === null, 'select: esc cancels and resolves null instead of killing the process');
  assert(rawModeCalls[rawModeCalls.length - 1] === false, 'cancel still restores raw mode');
}

{
  const fake = installFakeTty();
  // The disabled row must be stepped over, not landed on.
  type(fake, [DOWN, SPACE, ENTER]);
  const picked = await multiselect('Targets', [
    { value: 'skill', label: 'Skill', selected: true },
    { value: 'cursor', label: 'Cursor', disabled: 'no file-based user rules' },
    { value: 'action', label: 'Action' },
  ]);
  restore();
  assert(
    picked !== null && picked.includes('skill') && picked.includes('action'),
    'multiselect: skips the disabled row and toggles the next selectable one',
  );
  assert(
    picked !== null && !picked.includes('cursor'),
    'multiselect: a disabled row can never end up selected',
  );
  assert(painted.includes('no file-based user rules'), 'multiselect: shows WHY a row is disabled');
}

{
  const fake = installFakeTty();
  type(fake, ['a', ENTER]);
  const picked = await multiselect('Targets', [
    { value: 'one', label: 'One' },
    { value: 'two', label: 'Two' },
    { value: 'three', label: 'Three', disabled: 'nope' },
  ]);
  restore();
  assert(
    picked !== null && picked.length === 2 && !picked.includes('three'),
    'multiselect: "a" selects every selectable row and no disabled one',
  );
}

{
  const fake = installFakeTty();
  type(fake, [UP, ENTER]);
  const picked = await select('Wrap', [
    { value: 'first', label: 'First' },
    { value: 'last', label: 'Last' },
  ]);
  restore();
  assert(picked === 'last', 'select: up from the first row wraps around to the last');
}

out(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n\n`);
process.exit(fail === 0 ? 0 : 1);
