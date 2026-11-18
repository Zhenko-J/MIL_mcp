import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readSessionFile } from './session-file.js';

/** Rafraîchir quand il reste moins de 7 jours ; au plus une tentative toutes les 10 minutes. */
export const REFRESH_BEFORE_MS = 7 * 24 * 3600_000;
const MIN_INTERVAL_MS = 10 * 60_000;

/** Script de session, à côté de `dist/` : dist/src/session-refresh.js → ../../scripts/session.mjs. */
const SCRIPT = fileURLToPath(new URL('../../scripts/session.mjs', import.meta.url));

export type RefreshState = 'idle' | 'running' | 'done' | 'failed' | 'disabled' | 'unavailable';

/**
 * Lance `scripts/session.mjs --refresh` en arrière-plan (navigateur sans fenêtre, profil persistant) quand le fichier
 * de session manque, a expiré ou expire bientôt. Le script n'ouvre jamais de fenêtre dans ce mode et ne touche pas au
 * mot de passe : si le profil n'est plus connecté, il sort en échec et l'utilisateur lance `npm run session` lui-même.
 */
export class SessionRefresher {
  private lastAttempt = 0;
  state: RefreshState;

  constructor(
    private readonly enabled: boolean,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.state = !enabled ? 'disabled' : fs.existsSync(SCRIPT) ? 'idle' : 'unavailable';
  }

  /** Vrai si le fichier de session doit être rafraîchi maintenant (absent, expiré ou proche de l'expiration). */
  needed(now = Date.now()): boolean {
    if (this.env.MILANOTE_SESSION_TOKEN?.trim() || this.env.MILANOTE_TOKEN?.trim()) return false; // session fournie par l'environnement
    const s = readSessionFile(this.env);
    if (!s) return true;
    return s.expires !== null && Date.parse(s.expires) - now < REFRESH_BEFORE_MS;
  }

  /** Déclenche un rafraîchissement si utile ; ne bloque jamais l'appel en cours. */
  maybeRefresh(now = Date.now()): void {
    if (this.state === 'disabled' || this.state === 'unavailable' || this.state === 'running') return;
    if (now - this.lastAttempt < MIN_INTERVAL_MS || !this.needed(now)) return;
    this.lastAttempt = now;
    this.state = 'running';
    try {
      const child = spawn(process.execPath, [SCRIPT, '--refresh'], {
        env: this.env,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('exit', (code) => {
        this.state = code === 0 ? 'done' : 'failed';
        console.error(`milanote-mcp : rafraîchissement de session ${code === 0 ? 'réussi' : `échoué (code ${code}) : lancer « npm run session »`}.`);
      });
      child.on('error', () => {
        this.state = 'failed';
      });
    } catch {
      this.state = 'failed';
    }
  }
}
