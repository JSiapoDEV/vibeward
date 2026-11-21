// The body of the one "vibeward: pending" issue, and what the Action does with it.
//
//   node issue.mjs <old-body.md> <summary.md> <OPEN|CLOSED|NONE> <new-body.md>
//
// Prints one word — create, edit, close, reopen or none — and writes the new body. The Action
// turns that word into a `gh` call; everything that decides lives here, where a test can run
// it, instead of inline in action.yml, where nothing did.
//
// Two rules, both learned from a real repository:
//
// - A tick holds only while the item has not grown. The file list sits on the line below the
//   item, so a tick keyed on the item's first line alone kept "review these HTML sinks" ticked
//   after a NEW file with innerHTML joined the list: a new risk filed as already reviewed.
//   Now a tick survives a file that leaves the list (it was fixed) and not one that joins it.
//
// - A closed issue is an answer. It closes when nothing is left unticked, and the owner may
//   close it by hand; either way, everything it listed has been seen. The Action used to look
//   for an OPEN issue only, so the next push opened a new one with every item unticked again —
//   and a folder scan always has items no one can make go away ("the database was not checked").
//   Now the closed issue stays closed, and is reopened — the same one — only for something new.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `- [ ] text` / `- [x] text` at the start of a line; the lines indented under it are its detail. */
export function parseItems(body) {
  const items = [];
  let current = null;
  // A body edited in the browser can come back with CRLF line endings.
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^- \[([ xX])\] (.*)$/.exec(line);
    if (m) {
      current = { checked: m[1] !== ' ', head: m[2], detail: [] };
      items.push(current);
    } else if (current && /^ {2}\S/.test(line)) {
      current.detail.push(line.trim());
    } else {
      current = null;
    }
  }
  return items;
}

/** The files an item names (in backticks on its detail lines), and whether the list was cut. */
function filesOf(item) {
  const text = item.detail.join('\n');
  return {
    files: [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    cut: /\b(?:and|y) \d+ (?:more|más)\b/.test(text),
  };
}

/** A tick carries over when the new item names nothing the old one did not. */
function stillCovered(oldItem, newItem) {
  const before = filesOf(oldItem);
  const after = filesOf(newItem);
  // A cut list hides files: nothing can be said about what is behind "and 12 more", so only
  // the very same lines keep the tick.
  if (before.cut || after.cut) return oldItem.detail.join('\n') === newItem.detail.join('\n');
  return after.files.every((f) => before.files.includes(f));
}

/**
 * @param {string} oldBody  the issue as it is now ('' when there is none)
 * @param {'OPEN'|'CLOSED'|'NONE'} state
 * @param {string} summary  the summary this run wrote, every item unticked
 * @returns {{ action: 'create'|'edit'|'close'|'reopen'|'none', body: string, open: number }}
 */
export function decide(oldBody, state, summary) {
  const before = new Map(parseItems(oldBody).map((item) => [item.head, item]));
  const lines = summary.split('\n');
  const items = parseItems(summary);
  let k = 0;
  const body = lines
    .map((line) => {
      if (!/^- \[ \] /.test(line)) return line;
      const item = items[k++];
      const old = before.get(item.head);
      const seen = old && (old.checked || state === 'CLOSED');
      return seen && stillCovered(old, item) ? `- [x] ${item.head}` : line;
    })
    .join('\n');
  const open = (body.match(/^- \[ \] /gm) || []).length;

  let action;
  if (state === 'NONE') action = open > 0 ? 'create' : 'none';
  else if (state === 'OPEN') action = open > 0 ? 'edit' : 'close';
  else action = open > 0 ? 'reopen' : 'none';
  return { action, body, open };
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

// Run as a script by the Action.
if (isMain) {
  const [oldPath, summaryPath, state, outPath] = process.argv.slice(2);
  const result = decide(
    readFileSync(oldPath, 'utf8'),
    state === 'OPEN' || state === 'CLOSED' ? state : 'NONE',
    readFileSync(summaryPath, 'utf8'),
  );
  writeFileSync(outPath, result.body);
  process.stdout.write(result.action);
}
