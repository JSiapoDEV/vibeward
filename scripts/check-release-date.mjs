// Refuses `npm publish` when RELEASED in src/core/version.ts is not this release's date.
//
// RELEASED is how a pinned copy knows its own age without a network call, and the staleness
// notice is computed from it. Left behind from the previous release, it makes every fresh
// install tell its user to update the version they just installed — v0.7.0 shipped exactly
// that, carrying v0.6.2's date. The test suite ties RELEASED to METHODOLOGY.md, but a release
// that forgets both dates passes it; this is the last check before the copy reaches anyone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A release commit can sit a few days before it is published; more than this is a forgotten date. */
const MAX_AGE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src', 'core', 'version.ts'), 'utf8');
const version = /export const VERSION = '([^']+)'/.exec(source)?.[1];
const released = /export const RELEASED = '([^']+)'/.exec(source)?.[1];

const then = Date.parse(`${released}T00:00:00Z`);
if (!version || Number.isNaN(then)) {
  console.error('check-release-date: could not read VERSION and RELEASED from src/core/version.ts');
  process.exit(1);
}

// Whole days, measured in UTC like ageInDays(). A day of slack forward covers a release dated
// in a timezone that is already tomorrow.
const age = Math.floor((Date.now() - then) / DAY);
if (age < -1 || age > MAX_AGE_DAYS) {
  const when = age < 0 ? `${-age} days in the future` : `${age} days ago`;
  console.error(
    `check-release-date: publishing v${version}, but RELEASED is ${released} (${when}).\n` +
      `Set RELEASED in src/core/version.ts and the date in METHODOLOGY.md to the release day.`,
  );
  process.exit(1);
}
console.log(`check-release-date: v${version} released ${released} — ok`);
