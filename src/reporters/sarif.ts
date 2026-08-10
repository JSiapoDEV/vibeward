import type { Finding, Severity } from '../core/types.js';

// Minimal SARIF 2.1.0 so findings show up in GitHub code scanning (Security tab).

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
};

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number };
  };
}

function locationOf(source: string | undefined): SarifLocation | null {
  if (!source) return null;
  const m = source.match(/^(.*):(\d+)$/);
  if (m && !/^https?:/i.test(source)) {
    return {
      physicalLocation: {
        artifactLocation: { uri: m[1]! },
        region: { startLine: Number.parseInt(m[2]!, 10) },
      },
    };
  }
  return { physicalLocation: { artifactLocation: { uri: source } } };
}

export function toSarif(findings: Finding[], version: string): string {
  const rules = new Map<string, { id: string; name: string; help: string; uri?: string }>();

  const results = findings.map((f) => {
    if (!rules.has(f.id)) {
      rules.set(f.id, {
        id: f.id,
        name: f.label,
        help: [f.why, f.exploit].filter(Boolean).join(' '),
        uri: f.references?.[0],
      });
    }
    const parts = [f.exploit, f.impact, f.why].filter(Boolean);
    const loc = locationOf(f.source);
    return {
      ruleId: f.id,
      level: LEVEL[f.severity],
      message: { text: `${f.label}. ${parts.join(' ')}` },
      ...(loc ? { locations: [loc] } : {}),
    };
  });

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'vibeward',
            version,
            informationUri: 'https://github.com/JSiapoDEV/vibeward',
            rules: [...rules.values()].map((r) => ({
              id: r.id,
              name: r.name,
              shortDescription: { text: r.name },
              fullDescription: { text: r.help },
              ...(r.uri ? { helpUri: r.uri } : {}),
            })),
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
