import fs from 'node:fs';
import { MilanoteConfigError } from './client/errors.js';
import { isExpired, readSessionFile, sessionFilePath } from './session-file.js';

/**
 * Deux modes d'authentification (docs/endpoints.md §2) :
 * - `session` : cookie HttpOnly `__Secure-milanote.session_token` (Better Auth, observé le 2026-10-09). Le serveur ne
 *   lit alors userId et rootBoardId qu'en appelant `GET users/me`.
 * - `jwt` : ancien cookie `mn-token` / `localStorage.token` (JWT avec claims `_id` et `rootBoardId`), encore accepté.
 */
export type Auth = { kind: 'session'; token: string } | { kind: 'jwt'; token: string };

/** Réglages du serveur, indépendants de la session : lus une fois au démarrage, jamais d'erreur de session ici. */
export interface Settings {
  baseUrl: string;
  enableWrite: boolean;
  cacheTtlMs: number;
  requestTimeoutMs: number;
  locale: string;
  /** Rafraîchissement automatique du fichier de session (navigateur sans fenêtre), désactivable. */
  autoRefresh: boolean;
}

/** Session résolue : d'où elle vient et quand elle expire. Le jeton ne sort jamais du processus. */
export interface ResolvedAuth {
  auth: Auth;
  source: 'env-session' | 'env-jwt' | 'file';
  /** Connus d'avance seulement en mode `jwt` ; sinon résolus via `users/me`. */
  userId?: string;
  rootBoardId?: string;
  /** Expiration du cookie (fichier de session uniquement) ; null = cookie de session sans date. */
  expires?: string | null;
  file?: string;
}

/** Forme historique (réglages + session résolue), gardée pour les tests et les scripts. */
export type Config = Settings & ResolvedAuth;

interface JwtClaims {
  _id?: unknown;
  rootBoardId?: unknown;
}

/** Décode la charge utile du JWT sans le vérifier (signature côté serveur uniquement). */
export function decodeJwtClaims(token: string): JwtClaims {
  const part = token.split('.')[1];
  if (!part) throw new MilanoteConfigError('MILANOTE_TOKEN ne ressemble pas à un JWT (trois segments attendus).');
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    throw new MilanoteConfigError('MILANOTE_TOKEN : charge utile JWT illisible.');
  }
}

/** En-tête Cookie envoyé au REST et au socket. Ne jamais le loguer. */
export function cookieHeader(auth: Auth): string {
  return auth.kind === 'session' ? `__Secure-milanote.session_token=${auth.token}` : `mn-token=${auth.token}`;
}

/** En-têtes d'authentification REST : cookie dans les deux modes, plus `Authorization: Bearer` pour un JWT. */
export function authHeaders(auth: Auth): Record<string, string> {
  return auth.kind === 'jwt' ? { authorization: `Bearer ${auth.token}`, cookie: cookieHeader(auth) } : { cookie: cookieHeader(auth) };
}

/**
 * Le cookie de session part vers `baseUrl` : seule une origine HTTPS de milanote.com est acceptée, pour qu'une variable
 * mal réglée ne puisse pas l'envoyer ailleurs.
 */
export function checkBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new MilanoteConfigError(`MILANOTE_BASE_URL invalide : ${raw}`);
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !(host === 'milanote.com' || host.endsWith('.milanote.com'))) {
    throw new MilanoteConfigError(`MILANOTE_BASE_URL refusée (${u.origin}) : seule une origine https://…milanote.com est acceptée.`);
  }
  return u.origin;
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new MilanoteConfigError(`${name} doit être un nombre positif (reçu : ${raw}).`);
  return n;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    baseUrl: checkBaseUrl(env.MILANOTE_BASE_URL ?? 'https://app.milanote.com'),
    enableWrite: env.MILANOTE_ENABLE_WRITE === '1',
    cacheTtlMs: positiveNumber('MILANOTE_CACHE_TTL_MS', env.MILANOTE_CACHE_TTL_MS, 60_000),
    requestTimeoutMs: positiveNumber('MILANOTE_TIMEOUT_MS', env.MILANOTE_TIMEOUT_MS, 15_000) || 15_000,
    locale: env.MILANOTE_LOCALE ?? 'fr-fr',
    autoRefresh: env.MILANOTE_AUTO_REFRESH !== '0',
  };
}

/** Message d'erreur commun quand aucune session n'est utilisable. */
export function noSessionMessage(env: NodeJS.ProcessEnv = process.env, expired?: string | null): string {
  return expired !== undefined
    ? `Session Milanote expirée (${expired}) dans ${sessionFilePath(env)} : lancer « npm run session » dans le dossier du serveur pour la renouveler (inutile de redémarrer Claude).`
    : `Aucune session Milanote (fichier ${sessionFilePath(env)} absent ou illisible) : lancer « npm run session » dans le dossier ` +
        'du serveur et se connecter dans la fenêtre (inutile de redémarrer Claude), ou définir MILANOTE_SESSION_TOKEN. Voir README.';
}

/** Résout la session à partir de l'environnement puis du fichier de session. Lève une erreur lisible sinon. */
export function resolveAuth(env: NodeJS.ProcessEnv = process.env): ResolvedAuth {
  const session = env.MILANOTE_SESSION_TOKEN?.trim();
  const jwt = env.MILANOTE_TOKEN?.trim();
  if (session) {
    if (/[\s;]/.test(session)) throw new MilanoteConfigError('MILANOTE_SESSION_TOKEN : valeur invalide (espace ou point-virgule).');
    return { auth: { kind: 'session', token: session }, source: 'env-session' };
  }
  if (!jwt) {
    // Fichier déposé par `npm run session` (scripts/session.mjs).
    const file = sessionFilePath(env);
    const saved = readSessionFile(env);
    if (saved && !isExpired(saved)) {
      if (/[\s;]/.test(saved.token)) throw new MilanoteConfigError(`Fichier de session ${file} : jeton invalide, relancer « npm run session -- --login ».`);
      return { auth: { kind: 'session', token: saved.token }, source: 'file', expires: saved.expires, file };
    }
    throw new MilanoteConfigError(noSessionMessage(env, saved ? saved.expires : undefined));
  }
  const claims = decodeJwtClaims(jwt);
  if (typeof claims._id !== 'string' || typeof claims.rootBoardId !== 'string') {
    throw new MilanoteConfigError('MILANOTE_TOKEN : claims `_id` ou `rootBoardId` absents.');
  }
  return { auth: { kind: 'jwt', token: jwt }, source: 'env-jwt', userId: claims._id, rootBoardId: claims.rootBoardId };
}

/** Réglages + session, avec erreur immédiate si la session manque (tests, scripts). Le serveur utilise AuthProvider. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return { ...loadSettings(env), ...resolveAuth(env) };
}

/** Fournit la session à chaque appel, sans redémarrage. Interface minimale pour pouvoir la simuler dans les tests. */
export interface AuthSource {
  current(): ResolvedAuth;
  /** Oublie la session en cache (après un refus HTTP 401/403) : le prochain appel relit le fichier. */
  invalidate(): void;
}

/**
 * Session paresseuse : le serveur démarre même sans session, et relit le fichier de session dès qu'il change
 * (`npm run session` lancé pendant que Claude tourne). Les erreurs de session sortent à l'appel d'outil, lisibles.
 */
export class AuthProvider implements AuthSource {
  private cached?: { resolved: ResolvedAuth; mtimeMs: number };

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private fileMtime(): number {
    try {
      return fs.statSync(sessionFilePath(this.env)).mtimeMs;
    } catch {
      return -1;
    }
  }

  current(): ResolvedAuth {
    const mtimeMs = this.fileMtime();
    const c = this.cached;
    if (c && c.mtimeMs === mtimeMs && !(c.resolved.source === 'file' && c.resolved.expires && Date.parse(c.resolved.expires) <= Date.now())) {
      return c.resolved;
    }
    this.cached = undefined;
    const resolved = resolveAuth(this.env);
    this.cached = { resolved, mtimeMs };
    return resolved;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

/** Source fixe (tests). */
export class StaticAuth implements AuthSource {
  constructor(private readonly resolved: ResolvedAuth) {}
  current(): ResolvedAuth {
    return this.resolved;
  }
  invalidate(): void {}
}
