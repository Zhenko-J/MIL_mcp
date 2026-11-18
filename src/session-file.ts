import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Fichier de session partagé entre `scripts/session.mjs` (qui l'écrit) et le serveur (qui le lit) :
 * `%USERPROFILE%\.milanote-mcp\session.json`, hors du dépôt. Contenu : { token, expires, savedAt }.
 *
 * Pourquoi pas `%LOCALAPPDATA%` (emplacement jusqu'à la v0.9.0) : l'application Claude pour Windows est un paquet MSIX,
 * et les processus qu'elle lance (dont ce serveur MCP) voient `AppData\Local` à travers une copie privée
 * (`AppData\Local\Packages\Claude_…\LocalCache\Local`). Le fichier écrit par `npm run session` depuis un terminal
 * ordinaire n'était donc pas celui que lisait le serveur (constaté le 2026-11-16 : copie privée expirée le 2026-11-10,
 * fichier réel valide jusqu'au 2026-12-18). Le dossier utilisateur n'est pas redirigé.
 */
export interface SessionFile {
  token: string;
  /** Expiration du cookie (ISO 8601) ou null si cookie de session. */
  expires: string | null;
  savedAt: string;
}

export function sessionDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MILANOTE_HOME ?? path.join(env.USERPROFILE ?? os.homedir(), '.milanote-mcp');
}

/** Ancien dossier (v0.8–v0.9), sujet à la redirection MSIX : lu seulement en secours, jamais écrit. */
export function legacySessionDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'milanote-mcp');
}

export function sessionFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MILANOTE_SESSION_FILE ?? path.join(sessionDir(env), 'session.json');
}

function readFile(file: string): SessionFile | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SessionFile>;
    if (typeof raw.token !== 'string' || !raw.token) return undefined;
    return { token: raw.token, expires: typeof raw.expires === 'string' ? raw.expires : null, savedAt: raw.savedAt ?? '' };
  } catch {
    return undefined;
  }
}

/**
 * Lit le fichier de session ; `undefined` s'il manque ou s'il est illisible. Un cookie expiré est renvoyé aussi (le
 * serveur le signale). Sans fichier au nouvel emplacement, l'ancien est lu en secours.
 */
export function readSessionFile(env: NodeJS.ProcessEnv = process.env): SessionFile | undefined {
  const current = readFile(sessionFilePath(env));
  if (current || env.MILANOTE_SESSION_FILE || env.MILANOTE_HOME) return current;
  return readFile(path.join(legacySessionDir(env), 'session.json'));
}

export function isExpired(s: SessionFile, now = Date.now()): boolean {
  return s.expires !== null && Date.parse(s.expires) <= now;
}
