// Single source of truth for the version string. Keep in sync with package.json.
export const VERSION = '0.6.2';

/**
 * The day this version was released, ISO. Bumped with VERSION, on the same line of the
 * release checklist — a test fails if it is ever in the future.
 *
 * This exists so a copy can tell the user it is old without asking anybody. The hook could
 * have run `npx vibeward@latest` and always been current, but that trades the guard's
 * availability for its freshness: with the registry unreachable it hangs and then produces
 * nothing, which means no guard at all, silently, exactly when the network is flaky. A
 * pinned copy that knows its own age is the better half of that trade — and it needs no
 * network, so "nothing about you is ever uploaded" stays literally true.
 */
export const RELEASED = '2026-08-18';

/** Past this, a copy is old enough that the lexicon has likely moved on without it. */
const STALE_AFTER_DAYS = 60;

const DAY = 24 * 60 * 60 * 1000;

/**
 * How many days old this build is, or null when RELEASED is unparseable. `now` is a
 * parameter so this is testable without waiting two months.
 */
export function ageInDays(now: Date = new Date(), released: string = RELEASED): number | null {
  const then = Date.parse(`${released}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / DAY);
}

/**
 * One line telling the user their copy has drifted, or null while it is current. Says how
 * old it is rather than claiming a newer version exists, because with no network it cannot
 * know that — and a nudge that overstates what it checked is a nudge people learn to ignore.
 */
export function stalenessNotice(now: Date = new Date()): string | null {
  const days = ageInDays(now);
  if (days === null || days < STALE_AFTER_DAYS) return null;
  const months = Math.floor(days / 30);
  const age = months >= 2 ? `${months} months` : `${days} days`;
  // The command has to be the one that actually updates the thing complaining. The hook is a
  // version pinned into a settings.json, so nothing a package manager does reaches it — only
  // re-running `init`, which rewrites the pin in place.
  return `This vibeward is ${age} old (v${VERSION}, released ${RELEASED}). The guard's rules only cover phrasings that existed then — update with \`npx vibeward@latest init\`.`;
}
