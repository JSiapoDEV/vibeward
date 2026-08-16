import type { Finding } from './types.js';

/**
 * The languages a report can be written in.
 *
 * The CLI itself stays in English — its audience is whoever ran the command, and they just
 * typed an English flag. The report is the opposite: it is read by the site's owner, their
 * client, or an assistant summarising it for them, and handing a Spanish-speaking owner an
 * English list of what is wrong with their site is where a finding stops being acted on.
 */
export type Lang = 'en' | 'es';

export const LANGS: Lang[] = ['en', 'es'];

export function isLang(value: string | undefined): value is Lang {
  return value === 'en' || value === 'es';
}

/**
 * A finding with its prose in `lang`, and the translation overlay removed.
 *
 * Field by field rather than wholesale: a finding that has a Spanish `why` but no Spanish
 * `evidence` keeps the English evidence, which is usually a URL and a count anyway. The
 * overlay is dropped on the way out so nothing downstream — the markdown, the JSON payload,
 * the SARIF file — ever ships two copies of the same sentence.
 */
export function localize(finding: Finding, lang: Lang): Finding {
  const { es, ...rest } = finding;
  if (lang === 'en' || !es) return rest;
  return {
    ...rest,
    label: es.label ?? rest.label,
    ...(es.evidence !== undefined || rest.evidence !== undefined
      ? { evidence: es.evidence ?? rest.evidence }
      : {}),
    ...(es.exploit !== undefined || rest.exploit !== undefined
      ? { exploit: es.exploit ?? rest.exploit }
      : {}),
    ...(es.impact !== undefined || rest.impact !== undefined
      ? { impact: es.impact ?? rest.impact }
      : {}),
    why: es.why ?? rest.why,
  };
}

/** The shape `localizeFingerprint` needs, declared here so core does not import a check. */
interface Localizable {
  signals: string[];
  signalsEs?: string[];
}

/**
 * The vibe-coded fingerprint with its signal list in `lang`, and the other language dropped.
 *
 * Same contract as `localize`: pick one, ship one. The signals are the only translatable
 * part — the score, the host and the detected framework are measurements, not prose.
 */
export function localizeFingerprint<T extends Localizable>(fingerprint: T, lang: Lang): T {
  const { signalsEs, ...rest } = fingerprint;
  return { ...rest, signals: lang === 'es' && signalsEs ? signalsEs : rest.signals } as T;
}

/**
 * A line in the report's "what was actually checked" list, in both languages.
 *
 * These are written where the scan happens, because that is the only place that knows how
 * many bundles were read or how many tables were probed. Carrying both languages beats a
 * key-and-parameters indirection: the sentence and its counts stay in one place, and a new
 * scanner step cannot forget the translation without failing to compile.
 */
export interface CoverageLine {
  en: string;
  es: string;
}

export function coverage(en: string, es: string): CoverageLine {
  return { en, es };
}

export function coverageText(line: CoverageLine, lang: Lang): string {
  return lang === 'es' ? line.es : line.en;
}
