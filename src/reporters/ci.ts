// The summary a CI run leaves where a person will see it: the run page and a pinned issue.
//
// The GitHub Action used to upload SARIF and nothing else. On a private repository the
// Security tab can need a paid plan, and the person this tool is for — someone who builds in
// Lovable or v0 and lets it sync to GitHub — never opens it anyway. So the run also writes this:
// counts, what to fix, what is pending, and a prompt to paste into the builder.
//
// One rule shapes everything below: on a PUBLIC repository, the run page and its issues can
// be read by anyone, and "the service-role key is in src/lib/supabase.ts" is a map for an
// attacker, not a note for the owner. There the summary keeps counts and pending reviews and
// points to the Security tab, which only people with write access can open. Nothing here ever
// prints a finding's evidence, on any repository: evidence is where a secret would be quoted.

import { VERSION } from '../core/version.js';
import { builderPrompt, moreText, shownFiles, type PendingItem } from '../core/pending.js';
import { coverageText, type Lang } from '../core/i18n.js';
import { isWeb, type Finding, type Severity } from '../core/types.js';

export interface CiSummaryInput {
  target: string;
  dateISO: string;
  lang: Lang;
  verdict: string;
  /** Already localized. */
  findings: Finding[];
  pending: PendingItem[];
  /** True when the repository is public: no finding is named, only counted. */
  publicRepo: boolean;
}

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
/** Findings listed by name. Past this the issue is a wall, and the report has the rest. */
const MAX_FINDINGS = 25;

const T = {
  en: {
    sev: { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '⚪ Low' },
    counts: 'Security findings',
    none: 'No security findings in the automated scope.',
    findings: 'To fix',
    more: (n: number) => `…and ${n} more in the report and the Security tab.`,
    publicNote:
      'This repository is public, so this page does not say what or where — anyone can read it. The details are in the **Security** tab, which only people with write access can open, and in the report of a local run (`npx vibeward scan .`).',
    pending: 'Pending — for you or your builder',
    files: 'Files',
    kind: { review: 'Review', platform: 'Your builder', unchecked: 'Not checked' },
    prompt: 'Prompt to paste into Lovable, Bolt, v0 or your agent',
    footer:
      'vibeward is deterministic: no AI ran here, and the same commit always gives the same list. Tick items as you handle them; the list is rebuilt on every push, and a tick holds until the item names a new file. The issue closes when everything is fixed or ticked, and reopens only for something new.',
  },
  es: {
    sev: { critical: '🔴 Crítico', high: '🟠 Alto', medium: '🟡 Medio', low: '⚪ Bajo' },
    counts: 'Hallazgos de seguridad',
    none: 'Sin hallazgos de seguridad en el alcance automático.',
    findings: 'Para corregir',
    more: (n: number) => `…y ${n} más en el informe y en la pestaña Security.`,
    publicNote:
      'Este repositorio es público, así que esta página no dice qué ni dónde: cualquiera puede leerla. El detalle está en la pestaña **Security**, que solo abren quienes tienen permiso de escritura, y en el informe de una corrida local (`npx vibeward scan .`).',
    pending: 'Pendientes — para ti o tu herramienta de IA',
    files: 'Archivos',
    kind: { review: 'Revisar', platform: 'Tu herramienta de IA', unchecked: 'No revisado' },
    prompt: 'Prompt para pegar en Lovable, Bolt, v0 o tu agente',
    footer:
      'vibeward es determinista: aquí no corrió ninguna IA, y el mismo commit da siempre la misma lista. Marca lo que vayas resolviendo; la lista se rehace en cada push y la marca se mantiene mientras el ítem no sume un archivo nuevo. El issue se cierra cuando todo está corregido o marcado, y solo se reabre si aparece algo nuevo.',
  },
};

/**
 * The first line is a marker the Action reads with grep: how many things are open. It is an
 * HTML comment, so GitHub renders nothing for it.
 */
export function ciSummary(input: CiSummaryInput): string {
  const t = T[input.lang];
  const security = input.findings
    .filter((f) => !isWeb(f))
    .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  const count = (s: Severity) => security.filter((f) => f.severity === s).length;

  let md = `<!-- vibeward:summary findings=${security.length} critical=${count('critical')} pending=${input.pending.length} -->\n`;
  md += `## vibeward — ${input.verdict}\n\n`;
  md += `\`${input.target}\` · vibeward ${VERSION} · ${input.dateISO}\n\n`;

  if (security.length === 0) md += `${t.none}\n\n`;
  else {
    md += `| ${t.counts} | ${ORDER.map((s) => t.sev[s]).join(' | ')} |\n`;
    md += `|---|${ORDER.map(() => '---').join('|')}|\n`;
    md += `| | ${ORDER.map((s) => String(count(s))).join(' | ')} |\n\n`;

    if (input.publicRepo) md += `${t.publicNote}\n\n`;
    else {
      md += `### ${t.findings}\n\n`;
      for (const f of security.slice(0, MAX_FINDINGS)) {
        md += `- [ ] ${t.sev[f.severity]} — ${f.label}${f.source ? ` (\`${f.source}\`)` : ''}\n`;
      }
      if (security.length > MAX_FINDINGS) md += `\n${t.more(security.length - MAX_FINDINGS)}\n`;
      md += '\n';
    }
  }

  if (input.pending.length > 0) {
    md += `### ${t.pending}\n\n`;
    for (const item of input.pending) {
      md += `- [ ] **${t.kind[item.kind]}** — ${coverageText(item.task, input.lang)}\n`;
      if (item.files.length > 0) {
        md += `  ${t.files}: ${shownFiles(item)
          .map((f) => `\`${f}\``)
          .join(', ')}${moreText(item, input.lang)}\n`;
      }
    }
    md += '\n';
  }

  // On a public repository the prompt names no finding either: it would carry the same map.
  const prompt = builderPrompt(input.publicRepo ? [] : security, input.pending, input.lang);
  if (prompt) {
    md += `<details><summary>${t.prompt}</summary>\n\n\`\`\`text\n${prompt}\n\`\`\`\n\n</details>\n\n`;
  }

  md += `<sub>${t.footer}</sub>\n`;
  return md;
}
