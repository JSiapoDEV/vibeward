import type { Finding } from '../core/types.js';
import { fetchText } from '../http/client.js';

// Firebase misconfiguration checks — the other dominant BaaS pattern in vibe-coded apps
// (the Tea breach; historically ~11% of Firebase apps left their DB world-readable).
// Everything here is a read-only GET.

export interface FirebaseConfig {
  projectId?: string;
  databaseURL?: string;
  storageBucket?: string;
}

/**
 * Pulls a Firebase config out of a bundle. Requires a Firebase API key (`AIza…`) to be
 * present so we don't match unrelated `projectId` strings. Pure — no network.
 */
export function extractFirebaseConfig(text: string): FirebaseConfig | null {
  if (!/AIza[0-9A-Za-z_-]{35}/.test(text)) return null;

  const projectId = text.match(/["']?projectId["']?\s*[:=]\s*["']([a-z0-9-]+)["']/i)?.[1];
  const databaseURL = text.match(
    /["']?databaseURL["']?\s*[:=]\s*["'](https:\/\/[^"']+?(?:firebaseio\.com|firebasedatabase\.app))["']/i,
  )?.[1];
  const storageBucket = text.match(
    /["']?storageBucket["']?\s*[:=]\s*["']([a-z0-9.-]+\.(?:appspot\.com|firebasestorage\.app))["']/i,
  )?.[1];

  if (!projectId && !databaseURL && !storageBucket) return null;
  return { projectId, databaseURL, storageBucket };
}

/**
 * What a confirmation prompt should show before probing this config: the most specific
 * address the probe will actually reach. Naming the project rather than the endpoints is how
 * a prompt becomes something people click through instead of read.
 */
export function firebaseTarget(cfg: FirebaseConfig): string {
  if (cfg.databaseURL) return cfg.databaseURL.replace(/\/$/, '');
  if (cfg.projectId) return `https://${cfg.projectId}-default-rtdb.firebaseio.com`;
  if (cfg.storageBucket) return `firebasestorage.googleapis.com/v0/b/${cfg.storageBucket}/o`;
  return 'the project’s Firebase endpoints';
}

export function firebaseRtdbFinding(baseUrl: string, empty: boolean): Finding {
  return {
    id: 'firebase_rtdb_open',
    es: {
      label: `La Realtime Database de Firebase es legible sin autenticación${empty ? ' (ahora mismo vacía)' : ''}`,
      evidence: empty
        ? 'Una lectura superficial devolvió 200 sin error de permisos (la base está abierta pero ahora mismo vacía).'
        : 'Una lectura superficial devolvió las claves de primer nivel sin autenticación.',
      exploit: `Cualquiera pide \`${baseUrl}/.json\` y se descarga la base de datos entera — sin login. Añadiendo \`?shallow=true\` lista las claves; quitándolo, lo vuelca todo.`,
      impact:
        'Todos los registros de la Realtime Database son legibles (y, si las reglas de escritura también están abiertas, escribibles) por cualquiera en internet.',
      why: 'Las reglas de seguridad permiten lectura pública. Sustituye `".read": true` por reglas ligadas a la autenticación (`auth != null` y propiedad por nodo).',
    },
    label: `Firebase Realtime Database is readable without authentication${empty ? ' (currently empty)' : ''}`,
    severity: empty ? 'high' : 'critical',
    check: 6,
    cwe: 'CWE-863',
    source: `${baseUrl}/.json`,
    evidence: empty
      ? 'A shallow read returned 200 with no permission error (the database is open but currently empty).'
      : 'A shallow read returned the top-level keys with no authentication.',
    exploit: `Anyone requests \`${baseUrl}/.json\` and downloads the entire database — no login. Adding \`?shallow=true\` lists keys; removing it dumps everything.`,
    impact:
      'Every record in the Realtime Database is readable (and, if write rules are also open, writable) by anyone on the internet.',
    why: 'The security rules allow public read. Replace `".read": true` with auth-scoped rules (`auth != null` and per-node ownership).',
    references: [
      'https://firebase.google.com/docs/database/security',
      'https://cwe.mitre.org/data/definitions/863.html',
    ],
  };
}

export function firebaseStorageFinding(bucket: string): Finding {
  return {
    id: 'firebase_storage_open',
    es: {
      label: 'El bucket de Firebase Storage se puede listar públicamente',
      evidence: 'El endpoint de listado de objetos devolvió 200 sin autenticación.',
      exploit: `Cualquiera pide \`https://firebasestorage.googleapis.com/v0/b/${bucket}/o\` para enumerar todos los ficheros guardados y luego se descarga cada uno — el patrón de la brecha de Tea (documentos de identidad y selfies).`,
      impact:
        'Todos los ficheros subidos (que en apps hechas con vibe-coding suelen incluir fotos de documentos, recibos y subidas de usuarios) se pueden enumerar y descargar por cualquiera.',
      why: 'Las reglas de Storage permiten el listado público. Restringe `allow read` a los propietarios autenticados y nunca dejes un bucket en modo de pruebas.',
    },
    label: `Firebase Storage bucket is publicly listable`,
    severity: 'high',
    check: 6,
    cwe: 'CWE-863',
    source: `firebasestorage.googleapis.com/v0/b/${bucket}/o`,
    evidence: 'The object-listing endpoint returned 200 without authentication.',
    exploit: `Anyone requests \`https://firebasestorage.googleapis.com/v0/b/${bucket}/o\` to enumerate every stored file, then downloads each one — the Tea-breach pattern (IDs and selfies).`,
    impact:
      'All uploaded files (which for vibe-coded apps often include ID photos, receipts and user uploads) can be enumerated and downloaded by anyone.',
    why: 'Storage rules allow public listing. Restrict `allow read` to authenticated owners and never leave a bucket in test mode.',
    references: [
      'https://firebase.google.com/docs/storage/security',
      'https://cwe.mitre.org/data/definitions/863.html',
    ],
  };
}

/** Probes the Realtime Database and Storage endpoints implied by a Firebase config. */
export async function checkFirebase(cfg: FirebaseConfig): Promise<Finding[]> {
  const findings: Finding[] = [];

  const rtdbBases: string[] = [];
  if (cfg.databaseURL) rtdbBases.push(cfg.databaseURL.replace(/\/$/, ''));
  else if (cfg.projectId) {
    rtdbBases.push(`https://${cfg.projectId}-default-rtdb.firebaseio.com`);
    rtdbBases.push(`https://${cfg.projectId}.firebaseio.com`);
  }
  for (const base of rtdbBases) {
    const res = await fetchText(`${base}/.json?shallow=true`, 8000);
    if (res.ok && !/"error"/.test(res.body)) {
      findings.push(firebaseRtdbFinding(base, res.body.trim() === 'null'));
      break; // one reachable RTDB is enough
    }
  }

  if (cfg.storageBucket) {
    const res = await fetchText(
      `https://firebasestorage.googleapis.com/v0/b/${cfg.storageBucket}/o?maxResults=1`,
      8000,
    );
    if (res.ok) findings.push(firebaseStorageFinding(cfg.storageBucket));
  }

  return findings;
}
