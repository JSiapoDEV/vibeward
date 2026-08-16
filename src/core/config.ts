// `vibeward.json` — what the owner declares about their own site.
//
// Read from LOCAL DISK ONLY. It is never fetched from the site being scanned: a config the
// scanned host could serve would let anyone silence their own audit by uploading a file.
//
// Two mechanisms, deliberately different, because the report has to tell them apart:
//   · not applicable — the check does not apply to this kind of site. Never evaluated.
//   · suppressed     — evaluated, failed, and silenced on purpose, with a written reason.
// Collapsing them would let "we never looked" read as "we looked and it was fine".
import { existsSync, readFileSync } from 'node:fs';
import { coverage } from './i18n.js';
import type { CoverageLine } from './i18n.js';
import { isAbsolute, join, resolve } from 'node:path';
import { WEB_CHECKS } from '../checks/web.js';
import { isWeb } from './types.js';
import type { Finding, SuppressedFinding, VibewardConfig } from './types.js';

export const CONFIG_FILENAME = 'vibeward.json';

const SCHEMA_VERSION = 1;

/** Only website checks can be silenced. A security verdict nobody can negotiate is the product. */
function suppressibleIds(): Set<string> {
  return new Set(WEB_CHECKS.map((c) => c.id));
}

/** Checks that stop making sense once the site declares what it is. */
const BY_SITE_TYPE: Record<string, { ids: string[]; reason: string; reasonEs: string }> = {
  website: { ids: [], reason: '', reasonEs: '' },
  app: {
    ids: ['web_missing_llms_txt', 'web_missing_structured_data', 'web_missing_sitemap'],
    reason: 'declared as a web app, not a content site',
    reasonEs: 'declarado como aplicación web, no como sitio de contenido',
  },
  internal: {
    ids: [
      'web_missing_llms_txt',
      'web_missing_structured_data',
      'web_missing_sitemap',
      'web_missing_canonical',
      'web_missing_og',
      'web_missing_meta_description',
      'web_duplicate_titles',
      'web_empty_html',
      'web_robots_blocks_ai',
    ],
    reason: 'declared as an internal tool — not meant to be found',
    reasonEs: 'declarado como herramienta interna — no está pensado para que lo encuentren',
  },
};

export interface ConfigLoad {
  config: VibewardConfig;
  /** Where it came from, or null when no file was found. */
  path: string | null;
  warnings: string[];
}

export const EMPTY_CONFIG: ConfigLoad = { config: {}, path: null, warnings: [] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Validates the raw file into a config plus the list of what was rejected and why. Nothing
 * here throws and nothing is silently dropped: a typo in an id would otherwise look exactly
 * like a working suppression, and the owner would believe a check is off when it is not.
 */
export function parseConfig(raw: string): { config: VibewardConfig; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      config: {},
      warnings: [`not valid JSON (${err instanceof Error ? err.message : String(err)}) — ignored`],
    };
  }

  const root = asRecord(parsed);
  if (!root) return { config: {}, warnings: ['expected a JSON object — ignored'] };

  const config: VibewardConfig = {};

  if (root.schemaVersion !== undefined) {
    if (root.schemaVersion !== SCHEMA_VERSION) {
      warnings.push(`schemaVersion ${String(root.schemaVersion)} is not ${SCHEMA_VERSION}`);
    }
    config.schemaVersion = SCHEMA_VERSION;
  }

  const intent = asRecord(root.intent);
  if (root.intent !== undefined && !intent) warnings.push('"intent" must be an object — ignored');
  if (intent) {
    config.intent = {};
    const ai = intent.aiCrawlers;
    if (ai !== undefined) {
      if (ai === 'open' || ai === 'blocked') config.intent.aiCrawlers = ai;
      else warnings.push(`intent.aiCrawlers "${String(ai)}" must be "open" or "blocked" — ignored`);
    }
    const type = intent.siteType;
    if (type !== undefined) {
      if (typeof type === 'string' && type in BY_SITE_TYPE) {
        config.intent.siteType = type as 'website' | 'app' | 'internal';
      } else {
        warnings.push(
          `intent.siteType "${String(type)}" must be one of ${Object.keys(BY_SITE_TYPE).join(', ')} — ignored`,
        );
      }
    }
  }

  if (root.suppress !== undefined) {
    if (!Array.isArray(root.suppress)) {
      warnings.push('"suppress" must be an array — ignored');
    } else {
      const allowed = suppressibleIds();
      const kept = [];
      for (const entry of root.suppress) {
        const item = asRecord(entry);
        const id = typeof item?.id === 'string' ? item.id : null;
        const reason = typeof item?.reason === 'string' ? item.reason.trim() : '';
        if (!id) {
          warnings.push('a suppress entry has no "id" — ignored');
          continue;
        }
        if (!reason) {
          warnings.push(`suppress "${id}" has no "reason" — ignored (a reason is required)`);
          continue;
        }
        if (!allowed.has(id)) {
          // Either a typo or an attempt to silence a security finding. Both must be loud.
          warnings.push(
            `suppress "${id}" ignored — only website checks can be suppressed, never security ones`,
          );
          continue;
        }
        kept.push({ id, reason });
      }
      if (kept.length > 0) config.suppress = kept;
    }
  }

  for (const key of Object.keys(root)) {
    if (!['schemaVersion', 'intent', 'suppress'].includes(key)) {
      warnings.push(`unknown key "${key}" — ignored`);
    }
  }

  return { config, warnings };
}

/**
 * Finds and reads the config: `--config` if given, otherwise `vibeward.json` beside the
 * scanned folder, otherwise in the working directory. Missing is not an error — the file
 * is optional and most scans never have one.
 */
export function loadConfig(explicit: string | undefined, near?: string): ConfigLoad {
  const candidates: string[] = [];
  if (explicit) candidates.push(isAbsolute(explicit) ? explicit : resolve(explicit));
  else {
    if (near) candidates.push(join(resolve(near), CONFIG_FILENAME));
    candidates.push(join(process.cwd(), CONFIG_FILENAME));
  }

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      return {
        config: {},
        path,
        warnings: [`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
    const { config, warnings } = parseConfig(raw);
    return { config, path, warnings };
  }

  if (explicit) {
    return { config: {}, path: null, warnings: [`--config ${explicit} not found — ignored`] };
  }
  return EMPTY_CONFIG;
}

/**
 * Checks that do not apply to this site, mapped to the reason shown in the report. These are
 * never evaluated, so the report says "not applicable" and not "ok".
 */
export function notApplicableChecks(config: VibewardConfig): Map<string, CoverageLine> {
  const out = new Map<string, CoverageLine>();
  const intent = config.intent ?? {};

  const byType = BY_SITE_TYPE[intent.siteType ?? 'website'];
  if (byType) for (const id of byType.ids) out.set(id, coverage(byType.reason, byType.reasonEs));

  if (intent.aiCrawlers === 'blocked') {
    const onPurpose = coverage(
      'AI crawlers are blocked on purpose (intent.aiCrawlers)',
      'los rastreadores de IA se bloquean a propósito (intent.aiCrawlers)',
    );
    out.set('web_robots_blocks_ai', onPurpose);
    out.set('web_missing_llms_txt', onPurpose);
  } else {
    // The inverted check only means anything against a declared intention to block.
    out.set(
      'web_ai_block_incomplete',
      coverage(
        'no declared intent to block AI crawlers',
        'no se declaró intención de bloquear rastreadores de IA',
      ),
    );
  }

  return out;
}

/**
 * Splits findings into the ones that stand and the ones the owner silenced. Security
 * findings are never touched here — `parseConfig` already refuses to suppress them, and
 * this second check means a future config key cannot quietly gain that power.
 */
export function applySuppressions(
  findings: Finding[],
  config: VibewardConfig,
): { kept: Finding[]; suppressed: SuppressedFinding[] } {
  const rules = new Map((config.suppress ?? []).map((s) => [s.id, s.reason]));
  if (rules.size === 0) return { kept: findings, suppressed: [] };

  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const finding of findings) {
    const reason = isWeb(finding) ? rules.get(finding.id) : undefined;
    if (reason) suppressed.push({ finding, reason });
    else kept.push(finding);
  }
  return { kept, suppressed };
}
