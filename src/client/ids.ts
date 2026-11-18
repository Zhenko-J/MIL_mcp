// Génération des ids d'éléments, reproduite du client web Milanote (docs/endpoints.md §4) :
// base62(secondes) [6] + clientId [6] + base62(tick % 3844) [2].

export const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TICK_MODULO = 62 * 62;

export function encodeBase62(n: number): string {
  if (n === 0) return '0';
  let out = '';
  while (n > 0) {
    out = BASE62[n % 62] + out;
    n = Math.floor(n / 62);
  }
  return out;
}

export function decodeBase62(s: string): number {
  let n = 0;
  for (const c of s) {
    const v = BASE62.indexOf(c);
    if (v < 0) throw new Error(`Caractère base62 invalide : ${c}`);
    n = n * 62 + v;
  }
  return n;
}

export function makeElementId(clientId: string, tick: number, nowMs = Date.now()): string {
  if (clientId.length !== 6) throw new Error('clientId doit faire 6 caractères');
  return encodeBase62(Math.floor(nowMs / 1000)) + clientId + encodeBase62(tick % TICK_MODULO).padStart(2, '0');
}

export function parseElementId(id: string): { createdAt: Date; clientId: string; tick: number } {
  return {
    createdAt: new Date(decodeBase62(id.slice(0, 6)) * 1000),
    clientId: id.slice(6, 12),
    tick: decodeBase62(id.slice(12)),
  };
}

export function isElementId(id: string): boolean {
  return /^[0-9A-Za-z]{14,15}$/.test(id) && decodeBase62(id.slice(0, 6)) * 1000 > Date.UTC(2016, 1, 29);
}

/**
 * Accepte un id de board ou une URL Milanote (`https://app.milanote.com/<id>/<slug>?p=…`) et renvoie l'id.
 * `undefined` si rien d'exploitable n'est trouvé.
 */
export function extractElementId(input: string): string | undefined {
  const s = input.trim();
  if (isElementId(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  if (!(host === 'milanote.com' || host.endsWith('.milanote.com'))) return undefined;
  return u.pathname.split('/').find((seg) => isElementId(seg));
}

function randomBase62(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += BASE62[Math.floor(Math.random() * 62)];
  return s;
}

/** Source d'ids propre au processus : clientId aléatoire, tick initial aléatoire comme le client web. */
export class IdSource {
  readonly clientId = randomBase62(6);
  readonly sessionId = randomBase62(10);
  readonly deviceId = randomBase62(10);
  private tick = Math.floor(Math.random() * TICK_MODULO * 0.25);
  private version = 0;

  nextTick(): number {
    this.tick += 1;
    return this.tick;
  }

  nextElementId(nowMs = Date.now()): string {
    return makeElementId(this.clientId, this.nextTick(), nowMs);
  }

  nextVersionId(): string {
    this.version += 1;
    return `${this.sessionId}-${this.version}`;
  }

  /** Clé de bloc ProseMirror (`attrs.key`, 5 caractères). */
  blockKey(): string {
    return randomBase62(5);
  }
}
