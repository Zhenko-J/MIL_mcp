import { authHeaders, type AuthSource, type Settings } from '../config.js';
import { MilanoteAuthError, MilanoteError } from './errors.js';

type Params = Record<string, string | number | boolean | undefined>;

/** Ce dont la façade a besoin côté REST (remplaçable par un faux client dans les tests). */
export interface RestLike {
  get<T>(path: string, params?: Params): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  putSigned(url: string, body: Uint8Array, contentType: string): Promise<void>;
}

/**
 * Client REST de l'API interne. Aucun retry : une requête qui échoue remonte telle quelle.
 * La session est demandée à chaque requête (AuthSource) : un `npm run session` est pris en compte sans redémarrage.
 * Le jeton ne figure jamais dans les messages d'erreur.
 */
export class RestClient implements RestLike {
  constructor(
    private readonly settings: Settings,
    private readonly auth: AuthSource,
  ) {}

  private url(path: string, params?: Params): string {
    const u = new URL(path.startsWith('/') ? path : `/api/${path}`, this.settings.baseUrl);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, opts: { params?: Params; body?: unknown } = {}): Promise<T> {
    const { auth } = this.auth.current();
    const res = await fetch(this.url(path, opts.params), {
      method,
      headers: {
        ...authHeaders(auth),
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
    });
    // 401/403, ou redirection vers /login : session refusée. On oublie la session en cache pour relire le fichier.
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      this.auth.invalidate();
      throw new MilanoteAuthError(res.status);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new MilanoteError(`Milanote ${method} ${path} : HTTP ${res.status} ${summarizeError(text)}`.trim(), res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MilanoteError(`Milanote ${method} ${path} : réponse non JSON (${text.length} octets)`, res.status);
    }
  }

  get<T>(path: string, params?: Params): Promise<T> {
    return this.request<T>('GET', path, { params });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  /**
   * Envoi d'un fichier vers une URL signée (S3). Hors API Milanote : aucun en-tête d'authentification,
   * la signature est dans l'URL, qui n'apparaît jamais dans les erreurs.
   */
  async putSigned(url: string, body: Uint8Array, contentType: string): Promise<void> {
    const blob = new Blob([body as BlobPart], { type: contentType });
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
      body: blob,
      signal: AbortSignal.timeout(Math.max(this.settings.requestTimeoutMs, 120_000)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
      throw new MilanoteError(`Envoi S3 refusé : HTTP ${res.status} ${code}`.trim(), res.status);
    }
  }
}

function summarizeError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; code?: string } };
    return [j.error?.code, j.error?.message].filter(Boolean).join(' : ');
  } catch {
    return '';
  }
}
