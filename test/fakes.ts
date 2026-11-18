import { StaticAuth, type Settings } from '../src/config.js';
import { MilanoteError } from '../src/client/errors.js';
import type { RestLike } from '../src/client/rest.js';
import type { Emit, SocketLike } from '../src/client/socket.js';
import { Milanote, type MilanoteDeps } from '../src/milanote.js';

// Faux Milanote en mémoire : un magasin d'éléments que le faux socket modifie comme le ferait le serveur,
// et que le faux REST relit. Sert à tester la façade sans réseau.

export const USER_ID = 'u0000000000000000000001';
export const ROOT = '1Xe000TESTCL01';
export const BOARD = '1Xe000TESTCL02';
export const OTHER_BOARD = '1Xe000TESTCL03';

export interface StoredElement {
  id: string;
  elementType: string;
  location?: { parentId?: string; section?: string; position?: Record<string, unknown> };
  content: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export class FakeMilanote implements RestLike, SocketLike {
  els = new Map<string, StoredElement>();
  /** Journal des appels (`GET boards`, `emit ELEMENT_CREATE`…), dans l'ordre. */
  log: string[] = [];
  emitted: Record<string, unknown>[] = [];
  /** Nombre de relectures `GET elements` avant qu'une écriture devienne visible (latence du serveur). */
  visibleAfterReads = 0;
  /** Actions acquittées mais sans effet (comme un 200 de Milanote qui n'écrit rien). */
  dropActions = false;
  /** Boards dont la lecture échoue. */
  failingBoards = new Set<string>();
  presignFails = false;
  private pending: (() => void)[] = [];
  private readsSinceWrite = 0;

  constructor() {
    this.add({ id: ROOT, elementType: 'BOARD', location: { rootBoard: true } as never, content: { title: 'Accueil' } });
    this.add({ id: BOARD, elementType: 'BOARD', location: { parentId: ROOT, section: 'CANVAS', position: { x: 0, y: 0 } }, content: { title: 'MCP-TEST' } });
    this.add({ id: OTHER_BOARD, elementType: 'BOARD', location: { parentId: ROOT, section: 'CANVAS', position: { x: 40, y: 0 } }, content: { title: 'Autre' } });
  }

  add(el: StoredElement): StoredElement {
    this.els.set(el.id, structuredClone(el));
    return el;
  }

  private snapshot(ids: string[]): { elements: Record<string, StoredElement> } {
    const elements: Record<string, StoredElement> = {};
    for (const id of ids) {
      const el = this.els.get(id);
      if (el) elements[id] = structuredClone(el);
    }
    return { elements };
  }

  /** Descendants d'un board (le board, ses cartes, colonnes, listes et tâches), comme `GET boards?ids=`. */
  private descendants(boardId: string): string[] {
    const out = [boardId];
    for (let i = 0; i < out.length; i++) {
      for (const el of this.els.values()) if (el.location?.parentId === out[i] && !out.includes(el.id)) out.push(el.id);
    }
    return out;
  }

  // ---- RestLike
  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    this.log.push(`GET ${path}`);
    if (path === 'users/me') return { user: { _id: USER_ID, rootBoardId: ROOT } } as T;
    if (path === 'boards') {
      const id = String(params.ids);
      if (this.failingBoards.has(id)) throw new MilanoteError(`Milanote GET boards : HTTP 404 BOARD_NOT_FOUND`, 404);
      // Comme le vrai `loadAncestors=true` : le board, ses descendants et ses ancêtres.
      const ancestors: string[] = [];
      for (let p = this.els.get(id)?.location?.parentId; p && this.els.has(p); p = this.els.get(p)?.location?.parentId) ancestors.push(p);
      return this.snapshot([...this.descendants(id), ...ancestors]) as T;
    }
    if (path === 'users/me/trash') {
      const ids = [...this.els.values()].filter((e) => e.location?.parentId?.endsWith('-trash')).map((e) => e.id);
      return { ...this.snapshot(ids), hasMore: false, totalCount: ids.length } as T;
    }
    if (path === 'elements') {
      this.readsSinceWrite += 1;
      if (this.readsSinceWrite > this.visibleAfterReads) this.flush();
      // Comme le vrai serveur : un élément à la corbeille n'est plus lisible ici (404 BOARD_DELETED dans `errors`).
      const ids = String(params.ids).split(',');
      const live = ids.filter((id) => !this.els.get(id)?.location?.parentId?.endsWith('-trash'));
      const errors = Object.fromEntries(ids.filter((id) => !live.includes(id)).map((id) => [id, { error: { code: 'BOARD_DELETED', status: 404 } }]));
      return { ...this.snapshot(live), errors } as T;
    }
    throw new Error(`GET inattendu : ${path}`);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    this.log.push(`POST ${path}`);
    if (path === 'elements/attachments/presign') {
      if (this.presignFails) throw new MilanoteError('Milanote POST elements/attachments/presign : HTTP 500', 500);
      const b = body as { elementId: string; filename: string };
      return { presignedUrl: `https://milanote.s3-accelerate.amazonaws.com/p/images/${b.elementId}/x/${b.filename}?fake-signature=s` } as T;
    }
    if (path === '/media-service/api/link') return { link: { url: (body as { url: string }).url, title: 'Titre' }, mediaType: 'NO_MEDIA' } as T;
    throw new Error(`POST inattendu : ${path}`);
  }

  async putSigned(): Promise<void> {
    this.log.push('PUT s3');
  }

  // ---- SocketLike
  async withConnection<T>(_userId: string, fn: (emit: Emit) => Promise<T>): Promise<T> {
    this.log.push('socket open');
    try {
      return await fn(async (action) => {
        const a = structuredClone(action) as Record<string, unknown>;
        this.emitted.push(a);
        this.log.push(`emit ${String(a.type)}`);
        if (!this.dropActions) this.pending.push(() => this.apply(a));
        this.readsSinceWrite = 0;
        if (this.visibleAfterReads === 0) this.flush();
      });
    } finally {
      this.log.push('socket close');
    }
  }

  private flush(): void {
    for (const f of this.pending.splice(0)) f();
  }

  private apply(a: Record<string, unknown>): void {
    switch (a.type) {
      case 'ELEMENT_CREATE':
        this.els.set(String(a.id), {
          id: String(a.id),
          elementType: String(a.elementType),
          location: a.location as StoredElement['location'],
          content: structuredClone(a.content as Record<string, unknown>),
          meta: { versionId: 'v1' },
        });
        break;
      case 'ELEMENT_SET_TYPE': {
        const el = this.els.get(String(a.id));
        if (el) Object.assign(el.content, a.changes);
        break;
      }
      case 'ELEMENT_UPDATE':
        for (const u of a.updates as { id: string; changes: Record<string, unknown> }[]) {
          const el = this.els.get(u.id);
          if (el) Object.assign(el.content, u.changes);
        }
        break;
      case 'ELEMENT_MOVE_MULTI':
        for (const m of a.moves as { id: string; location: StoredElement['location'] }[]) {
          const el = this.els.get(m.id);
          if (el) el.location = m.location;
        }
        break;
    }
  }
}

export const SETTINGS: Settings = {
  baseUrl: 'https://app.milanote.com',
  enableWrite: true,
  cacheTtlMs: 60_000,
  requestTimeoutMs: 15_000,
  locale: 'fr-fr',
  autoRefresh: false,
};

export function makeMilanote(fake: FakeMilanote, settings: Partial<Settings> = {}, deps: MilanoteDeps = {}): Milanote {
  return new Milanote({ ...SETTINGS, ...settings }, new StaticAuth({ auth: { kind: 'session', token: 't' }, source: 'env-session' }), {
    rest: fake,
    socket: fake,
    sleep: async () => {},
    ...deps,
  });
}

/** En-tête PNG minimal (signature + IHDR) : suffit à readImageInfo. */
export function tinyPng(width = 64, height = 32): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
}
