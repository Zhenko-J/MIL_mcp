import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthSource, ResolvedAuth, Settings } from './config.js';
import { TtlCache } from './client/cache.js';
import { MilanoteAuthError, MilanoteError, MilanoteUnconfirmedWriteError, MilanoteWriteDisabledError } from './client/errors.js';
import { extractElementId, IdSource, isElementId } from './client/ids.js';
import { RestClient, type RestLike } from './client/rest.js';
import { ActionSocket, type Emit, type SocketLike } from './client/socket.js';
import {
  buildElementCreate,
  buildElementMove,
  buildElementSetType,
  buildElementTrash,
  buildElementUpdate,
  type ActionContext,
  type ElementLocation,
  type TrashMove,
} from './actions.js';
import { boardContent, isTaskDone, listBoards, nextCanvasPosition, summarizeElement, type BoardRef, type ElementSummary } from './board.js';
import { boardToMarkdown } from './export/markdown.js';
import { parseSearch, type SearchHit } from './search.js';
import { readImageInfo } from './image/dimensions.js';
import { ElementsResponseSchema, LinkUnfurlSchema, PresignResponseSchema, UsersMeSchema, type Element, type ElementsResponse, type PmNode } from './schema/element.js';
import type { RefreshState } from './session-refresh.js';
import { markdownToDoc } from './text/markdown.js';
import { docToText, textToDoc } from './text/prosemirror.js';
import { VERSION } from './version.js';

/** Relectures après écriture : délais successifs (ms). L'acquittement socket ne prouve rien (docs/endpoints.md §1). */
const CONFIRM_DELAYS_MS = [1_500, 2_500, 4_000];
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_EXPORT_BOARDS = 25;
const DEFAULT_CARD_WIDTH = 34;
/** Palette envoyée par le client web à la création d'un board (fixture ws-02). */
const DEFAULT_BOARD_PALETTE = ['#7db4c0', '#80c7ca', '#a8dadc', '#c9d4c7', '#e4d1b6', '#f09035', '#ed6c18'];

export interface WriteResult {
  dryRun: boolean;
  elementId: string;
  boardId: string;
  /** dry_run : actions qui seraient envoyées. Écriture réelle : seulement leur nombre (`actionsSent`). */
  actions?: object[];
  actionsSent?: number;
  element?: ElementSummary;
  /** add_task : ids des tâches créées. */
  taskIds?: string[];
}

export interface SessionStatus {
  version: string;
  configured: boolean;
  source?: ResolvedAuth['source'];
  file?: string;
  expires?: string | null;
  daysLeft?: number;
  /** Résultat de `GET users/me` (seulement avec `check`). */
  valid?: boolean;
  rootBoardId?: string;
  writesEnabled: boolean;
  autoRefresh: RefreshState;
  error?: string;
  hint?: string;
}

/** Rafraîchissement de session (src/session-refresh.ts), injectable pour les tests. */
export interface RefresherLike {
  state: RefreshState;
  maybeRefresh(): void;
}

export interface MilanoteDeps {
  rest?: RestLike;
  socket?: SocketLike;
  /** Attente entre relectures ; remplaçable dans les tests. */
  sleep?: (ms: number) => Promise<void>;
  refresher?: RefresherLike;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const normalizeText = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Façade lecture/écriture utilisée par les outils MCP. */
export class Milanote {
  private readonly rest: RestLike;
  private readonly socket: SocketLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly refresher?: RefresherLike;
  private readonly ids = new IdSource();
  private readonly boardCache: TtlCache<ElementsResponse>;
  private identity?: { token: string; value: Promise<{ userId: string; rootBoardId: string }> };
  /** File d'écriture : une écriture réelle à la fois (lecture du board, position, envoi, relecture). */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: Settings,
    private readonly auth: AuthSource,
    deps: MilanoteDeps = {},
  ) {
    this.rest = deps.rest ?? new RestClient(settings, auth);
    this.socket = deps.socket ?? new ActionSocket(settings, auth);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.refresher = deps.refresher;
    this.boardCache = new TtlCache(settings.cacheTtlMs);
  }

  // ---------------------------------------------------------------- session et identité

  /** Session courante ; déclenche au passage un rafraîchissement en arrière-plan si elle manque ou expire bientôt. */
  private session(): ResolvedAuth {
    this.refresher?.maybeRefresh();
    return this.auth.current();
  }

  /** Identité du compte : connue du JWT, sinon lue dans `GET users/me` (une fois par session). */
  whoami({ fresh = false } = {}): Promise<{ userId: string; rootBoardId: string }> {
    const s = this.session();
    if (s.userId && s.rootBoardId) return Promise.resolve({ userId: s.userId, rootBoardId: s.rootBoardId });
    if (this.identity && this.identity.token !== s.auth.token) this.boardCache.clear(); // autre session : rien de l'ancienne
    if (fresh || !this.identity || this.identity.token !== s.auth.token) {
      const value = this.rest.get<unknown>('users/me').then((raw) => {
        const me = UsersMeSchema.parse(raw);
        return { userId: me.user._id, rootBoardId: me.user.rootBoardId };
      });
      const entry = { token: s.auth.token, value };
      this.identity = entry;
      value.catch(() => {
        if (this.identity === entry) this.identity = undefined; // nouvel essai au prochain appel
      });
    }
    return this.identity!.value;
  }

  /** État de la session, sans jamais renvoyer le jeton. `check` interroge Milanote (`users/me`). */
  async sessionStatus({ check = false } = {}): Promise<SessionStatus> {
    const base: SessionStatus = {
      version: VERSION,
      configured: false,
      writesEnabled: this.settings.enableWrite,
      autoRefresh: this.refresher?.state ?? 'disabled',
    };
    let s: ResolvedAuth;
    try {
      s = this.session();
    } catch (err) {
      return { ...base, autoRefresh: this.refresher?.state ?? 'disabled', error: errMsg(err), hint: 'Lancer « npm run session » dans le dossier du serveur.' };
    }
    const out: SessionStatus = { ...base, configured: true, source: s.source, autoRefresh: this.refresher?.state ?? 'disabled' };
    if (s.file) out.file = s.file;
    if (s.expires !== undefined) {
      out.expires = s.expires;
      if (s.expires) out.daysLeft = Math.floor((Date.parse(s.expires) - Date.now()) / 86_400_000);
    }
    if (check) {
      try {
        out.rootBoardId = (await this.whoami({ fresh: true })).rootBoardId;
        out.valid = true;
      } catch (err) {
        out.valid = false;
        out.error = errMsg(err);
      }
    }
    return out;
  }

  private async ctx(): Promise<ActionContext> {
    return { userId: (await this.whoami()).userId, ids: this.ids };
  }

  /** Accepte un id ou une URL Milanote. */
  boardIdOf(input: string): string {
    const id = extractElementId(input);
    if (!id) throw new MilanoteError(`Identifiant de board invalide : ${input} (id de 14 caractères ou URL app.milanote.com attendu).`);
    return id;
  }

  // ---------------------------------------------------------------- lectures

  async fetchBoard(boardInput: string, { fresh = false } = {}): Promise<ElementsResponse> {
    const boardId = this.boardIdOf(boardInput);
    this.session();
    const cached = fresh ? undefined : this.boardCache.get(boardId);
    if (cached) return cached;
    const raw = await this.rest.get<unknown>('boards', { ids: boardId, excludeSelf: false, loadAncestors: true });
    const resp = ElementsResponseSchema.parse(raw);
    if (!resp.elements[boardId]) throw new MilanoteError(`Board introuvable ou inaccessible : ${boardId}`, 404);
    this.boardCache.set(boardId, resp);
    return resp;
  }

  async listBoards(boardInput?: string): Promise<{ boardId: string; boards: BoardRef[] }> {
    const id = boardInput ? this.boardIdOf(boardInput) : (await this.whoami()).rootBoardId;
    return { boardId: id, boards: listBoards(await this.fetchBoard(id), id) };
  }

  async getBoard(boardInput: string): Promise<ReturnType<typeof boardContent>> {
    const id = this.boardIdOf(boardInput);
    return boardContent(await this.fetchBoard(id), id);
  }

  /**
   * Markdown d'un board, rendu côté client depuis les lectures REST. `depth` > 0 charge les sous-boards
   * (alias compris) en largeur d'abord, dans la limite de MAX_EXPORT_BOARDS appels. Un sous-board illisible
   * (supprimé, partagé puis retiré…) est seulement cité et listé dans `skipped` ; seul le board demandé est obligatoire.
   */
  async exportBoardMarkdown(args: { boardId: string; depth: number }): Promise<{
    boardId: string;
    markdown: string;
    boardsExported: string[];
    truncated: boolean;
    skipped: { boardId: string; reason: string }[];
  }> {
    const rootId = this.boardIdOf(args.boardId);
    const boards = new Map<string, ElementsResponse>();
    const skipped: { boardId: string; reason: string }[] = [];
    const seen = new Set<string>();
    let frontier = [rootId];
    let truncated = false;
    for (let level = 0; level <= args.depth && frontier.length && !truncated; level++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        if (boards.size >= MAX_EXPORT_BOARDS) {
          truncated = true;
          break;
        }
        seen.add(id);
        let resp: ElementsResponse;
        try {
          resp = await this.fetchBoard(id);
        } catch (err) {
          if (id === rootId || err instanceof MilanoteAuthError) throw err;
          skipped.push({ boardId: id, reason: errMsg(err) });
          continue;
        }
        boards.set(id, resp);
        if (level < args.depth) {
          // Seulement les sous-boards posés sur ce board ou dans ses colonnes : la réponse contient aussi les
          // ancêtres (`loadAncestors`), qu'il ne faut pas parcourir.
          const containers = this.containersOf(resp, id);
          for (const el of Object.values(resp.elements)) {
            if (el.id === id || !['BOARD', 'ALIAS'].includes(el.elementType)) continue;
            if (!containers.has(el.location?.parentId ?? '') || !['CANVAS', 'INBOX', undefined].includes(el.location?.section)) continue;
            const target = (el.elementType === 'ALIAS' ? el.content.linkTo : el.id) as string | undefined;
            if (target && isElementId(target) && !seen.has(target)) next.push(target);
          }
        }
      }
      frontier = next;
    }
    const markdown = boardToMarkdown(rootId, { boards, depth: args.depth });
    return { boardId: rootId, markdown, boardsExported: [...boards.keys()], truncated, skipped };
  }

  /**
   * Recherche serveur `GET boards/search` (même appel que la loupe du client web, capturé le 2026-10-09 :
   * `sort=viewed`, `locale=fr-FR`). Renvoie des boards avec les cartes qui matchent. Jamais la réponse brute.
   */
  async searchBoards(args: { query: string; limit: number; sort?: 'viewed' | 'modified' }): Promise<{ query: string; total: number; hits: SearchHit[] }> {
    this.session();
    const raw = await this.rest.get<unknown>('boards/search', {
      query: args.query,
      offset: 0,
      sort: args.sort ?? 'viewed',
      locale: toBcp47(this.settings.locale),
    });
    const { total, hits } = parseSearch(raw);
    return { query: args.query, total, hits: hits.slice(0, args.limit) };
  }

  // ---------------------------------------------------------------- mécanique d'écriture

  private assertWritable(dryRun: boolean): void {
    if (!dryRun && !this.settings.enableWrite) throw new MilanoteWriteDisabledError();
  }

  /** Une écriture réelle à la fois : deux appels simultanés calculeraient la même position de carte. */
  private write<T>(dryRun: boolean, fn: () => Promise<T>): Promise<T> {
    this.assertWritable(dryRun);
    if (dryRun) return fn();
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Relit des éléments après écriture jusqu'à ce que `check` ne signale plus rien (au plus 3 relectures espacées).
   * `check` renvoie la raison d'un échec (élément absent, contenu différent…) ou undefined si l'élément est conforme.
   * Les relectures sont des lectures : aucune écriture n'est jamais renvoyée.
   */
  private async confirm(
    subject: string,
    ids: string[],
    check: (el: Element | undefined, id: string) => string | undefined,
  ): Promise<Map<string, Element | undefined>> {
    let problems: string[] = [];
    for (const delay of CONFIRM_DELAYS_MS) {
      await this.sleep(delay);
      const resp = ElementsResponseSchema.parse(await this.rest.get<unknown>('elements', { ids: ids.join(',') }));
      problems = [];
      const found = new Map<string, Element | undefined>();
      for (const id of ids) {
        const el = resp.elements[id];
        found.set(id, el);
        const why = check(el, id);
        if (why) problems.push(`${id} : ${why}`);
      }
      if (problems.length === 0) return found;
    }
    throw new MilanoteUnconfirmedWriteError(subject, `après ${CONFIRM_DELAYS_MS.length} relectures (${problems.slice(0, 3).join(' ; ')})`);
  }

  /** Relecture d'un seul élément, avec son résumé. */
  private async confirmOne(id: string, check: (el: Element) => string | undefined): Promise<ElementSummary> {
    const found = await this.confirm(`l'élément ${id}`, [id], (el) => (el ? check(el) : 'introuvable'));
    return summarizeElement(found.get(id)!);
  }

  /**
   * Étapes qui suivent une création : en cas d'échec, la carte déjà créée (acquittée) est mise à la corbeille du board
   * (restaurable) au lieu d'être laissée vide. Ce n'est pas une nouvelle tentative : l'erreur est toujours renvoyée.
   */
  private async afterCreate<T>(
    emit: Emit,
    ctx: ActionContext,
    boardId: string,
    created: TrashMove[],
    step: () => Promise<T>,
  ): Promise<T> {
    try {
      return await step();
    } catch (err) {
      let cleaned = false;
      try {
        await emit(buildElementTrash(ctx, { boardId, moves: created }));
        cleaned = true;
      } catch {
        cleaned = false;
      }
      const what = created.map((m) => m.id).join(', ');
      throw new MilanoteError(
        `${errMsg(err)} — ${cleaned ? `élément(s) ${what} créé(s) puis mis à la corbeille du board (restaurables)` : `élément(s) ${what} laissé(s) sur le board (mise à la corbeille impossible)`}.`,
      );
    }
  }

  // ---------------------------------------------------------------- écritures

  async addNote(args: { boardId: string; title?: string; body: string; dryRun: boolean }): Promise<WriteResult> {
    const boardId = this.boardIdOf(args.boardId);
    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(boardId, { fresh: true });
      const id = this.ids.nextElementId();
      const doc = markdownToDoc([...(args.title ? [args.title] : []), args.body].join('\n'), () => this.ids.blockKey());
      const create = buildElementCreate(await this.ctx(), {
        id,
        elementType: 'CARD',
        boardId,
        position: nextCanvasPosition(resp, boardId),
        content: { textContent: doc },
      });
      if (args.dryRun) return { dryRun: true, elementId: id, boardId, actions: [create] };
      await this.socket.withConnection(create.user._id, (emit) => emit(create));
      this.boardCache.delete(boardId);
      const expected = normalizeText(docToText(doc));
      const element = await this.confirmOne(id, (el) =>
        el.elementType !== 'CARD' ? `type ${el.elementType}` : normalizeText(docToText(el.content.textContent)) !== expected ? 'texte différent' : undefined,
      );
      return { dryRun: false, elementId: id, boardId, actionsSent: 1, element };
    });
  }

  /**
   * Remplace (ou complète) le texte d'une note existante : ELEMENT_UPDATE de `textContent`, avec la version lue
   * (`meta.modifiedVersionId`) et une nouvelle version, comme le client web (fixture ws-07).
   */
  async editNote(args: { boardId: string; elementId: string; title?: string; body: string; mode: 'replace' | 'append'; dryRun: boolean }): Promise<WriteResult> {
    const boardId = this.boardIdOf(args.boardId);
    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(boardId, { fresh: true });
      const el = this.cardOf(resp, boardId, args.elementId);
      if (el.elementType !== 'CARD') throw new MilanoteError(`${args.elementId} n'est pas une note (type ${el.elementType}).`);
      const added = markdownToDoc([...(args.title ? [args.title] : []), args.body].join('\n'), () => this.ids.blockKey());
      const current = rec(el.content.textContent) as unknown as PmNode;
      const doc: PmNode =
        args.mode === 'append' && Array.isArray(current.content)
          ? { type: 'doc', content: [...current.content, ...(added.content ?? [])] }
          : added;
      const ctx = await this.ctx();
      const modifiedVersionId = str(rec(el.meta).versionId);
      const update = buildElementUpdate(ctx, {
        id: el.id,
        elementType: 'CARD',
        boardId,
        changes: { textContent: doc },
        meta: { ...(modifiedVersionId ? { modifiedVersionId } : {}), versionId: this.ids.nextVersionId() },
      });
      if (args.dryRun) return { dryRun: true, elementId: el.id, boardId, actions: [update] };
      await this.socket.withConnection(ctx.userId, (emit) => emit(update));
      this.boardCache.delete(boardId);
      const expected = normalizeText(docToText(doc));
      const element = await this.confirmOne(el.id, (e) => (normalizeText(docToText(e.content.textContent)) !== expected ? 'texte différent' : undefined));
      return { dryRun: false, elementId: el.id, boardId, actionsSent: 1, element };
    });
  }

  async addLink(args: { boardId: string; url: string; title?: string; dryRun: boolean }): Promise<WriteResult> {
    const boardId = this.boardIdOf(args.boardId);
    const url = new URL(args.url).toString(); // rejette une URL invalide avant toute écriture
    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(boardId, { fresh: true });
      const id = this.ids.nextElementId();
      const ctx = await this.ctx();
      const create = buildElementCreate(ctx, {
        id,
        elementType: 'LINK',
        boardId,
        position: nextCanvasPosition(resp, boardId),
        content: { url: null },
      });
      const setType = (changes: Record<string, unknown>) => buildElementSetType(ctx, { id, elementType: 'LINK', boardId, changes });

      if (args.dryRun) {
        const preview = setType({ link: { url, title: args.title ?? '<titre récupéré par /media-service/api/link>' }, mediaType: 'NO_MEDIA' });
        return { dryRun: true, elementId: id, boardId, actions: [create, preview] };
      }

      await this.socket.withConnection(ctx.userId, async (emit) => {
        await emit(create);
        await this.afterCreate(emit, ctx, boardId, [{ id, elementType: 'LINK', location: create.location }], async () => {
          await emit(setType(await this.unfurl(url, id, args.title)));
        });
      });
      this.boardCache.delete(boardId);
      const element = await this.confirmOne(id, (el) => {
        const link = rec(el.content.link);
        return str(link.url) ?? str(el.content.url) ? undefined : 'carte lien sans URL';
      });
      return { dryRun: false, elementId: id, boardId, actionsSent: 2, element };
    });
  }

  /**
   * Image : ELEMENT_CREATE (image:null) → presign → PUT S3 → ELEMENT_UPDATE (image + file) → relecture.
   * Séquence observée sur le client web (docs/endpoints.md §4, fixtures ws-08, http-presign-*, ws-09).
   * Un échec après la création met la carte vide à la corbeille du board (restaurable) et le dit dans l'erreur.
   */
  async addImage(args: { boardId: string; filePath: string; caption?: string; width?: number; dryRun: boolean }): Promise<WriteResult> {
    const boardId = this.boardIdOf(args.boardId);
    this.assertWritable(args.dryRun);
    const filePath = path.resolve(args.filePath);
    const stat = await fs.stat(filePath).catch(() => undefined);
    if (!stat?.isFile()) throw new MilanoteError(`Fichier image introuvable : ${filePath}`);
    if (stat.size > MAX_IMAGE_BYTES) throw new MilanoteError(`Image trop volumineuse (${stat.size} octets, max ${MAX_IMAGE_BYTES}).`);
    const bytes = await fs.readFile(filePath);
    let info: ReturnType<typeof readImageInfo>;
    try {
      info = readImageInfo(bytes);
    } catch (err) {
      throw new MilanoteError(errMsg(err));
    }
    const filename = sanitizeFilename(path.basename(filePath), info.ext);

    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(boardId, { fresh: true });
      const id = this.ids.nextElementId();
      const ctx = await this.ctx();
      const create = buildElementCreate(ctx, {
        id,
        elementType: 'IMAGE',
        boardId,
        position: nextCanvasPosition(resp, boardId),
        content: { image: null },
      });
      const presignBody = { filename, contentType: info.mime, elementId: id, fileType: 'image', imageType: 'ELEMENT', fileSize: stat.size };
      const update = (original: string) =>
        buildElementUpdate(ctx, {
          id,
          elementType: 'IMAGE',
          boardId,
          changes: {
            image: { width: info.width, height: info.height, original, transparent: info.transparent },
            // Largeur de la carte en unités de grille (10 px) ; 34 = largeur d'une note standard (captures).
            width: args.width ?? DEFAULT_CARD_WIDTH,
            file: { type: 'IMAGE', ext: info.ext, mime: info.mime, filename, size: stat.size, lastModified: Math.floor(stat.mtimeMs) },
            ...(args.caption ? { caption: textToDoc(args.caption.split(/\r?\n/), () => this.ids.blockKey()), showCaption: true } : {}),
          },
        });

      if (args.dryRun) {
        const presign = { type: 'REST', request: 'POST /api/elements/attachments/presign', body: presignBody };
        return { dryRun: true, elementId: id, boardId, actions: [create, presign, update('<URL renvoyée par presign>')] };
      }

      await this.socket.withConnection(ctx.userId, async (emit) => {
        await emit(create);
        await this.afterCreate(emit, ctx, boardId, [{ id, elementType: 'IMAGE', location: create.location }], async () => {
          let original: string;
          try {
            const presigned = PresignResponseSchema.parse(await this.rest.post<unknown>('elements/attachments/presign', presignBody));
            await this.rest.putSigned(presigned.presignedUrl, bytes, info.mime);
            // Le fichier est servi par Milanote sous /media + chemin S3 (observé : ws-09 contre http-presign-response).
            original = `${this.settings.baseUrl}/media${new URL(presigned.presignedUrl).pathname}`;
          } catch (err) {
            throw new MilanoteError(`Téléversement de l'image échoué : ${errMsg(err)}`);
          }
          await emit(update(original));
        });
      });
      this.boardCache.delete(boardId);
      const element = await this.confirmOne(id, (el) => (str(rec(el.content.image).original) ? undefined : 'image sans fichier'));
      return { dryRun: false, elementId: id, boardId, actionsSent: 2, element };
    });
  }

  /** Sous-board : ELEMENT_CREATE (contenu vide, palette par défaut) puis ELEMENT_UPDATE du titre (ws-02, ws-03). */
  async createBoard(args: { parentBoardId: string; title: string; color?: string; dryRun: boolean }): Promise<WriteResult> {
    const parentId = this.boardIdOf(args.parentBoardId);
    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(parentId, { fresh: true });
      const id = this.ids.nextElementId();
      const ctx = await this.ctx();
      const create = buildElementCreate(ctx, {
        id,
        elementType: 'BOARD',
        boardId: parentId,
        position: nextCanvasPosition(resp, parentId),
        content: { title: null, icon: null, color: null, secondaryColor: null, defaultColorPalette: DEFAULT_BOARD_PALETTE },
      });
      const update = buildElementUpdate(ctx, {
        id,
        elementType: 'BOARD',
        boardId: parentId,
        extraChannels: [id],
        changes: { title: args.title, ...(args.color ? { color: args.color, secondaryColor: null } : {}) },
      });
      if (args.dryRun) return { dryRun: true, elementId: id, boardId: parentId, actions: [create, update] };
      await this.socket.withConnection(ctx.userId, async (emit) => {
        await emit(create);
        await this.afterCreate(emit, ctx, parentId, [{ id, elementType: 'BOARD', location: create.location }], () => emit(update));
      });
      this.boardCache.delete(parentId);
      const element = await this.confirmOne(id, (el) => (str(el.content.title) === args.title ? undefined : 'titre différent'));
      return { dryRun: false, elementId: id, boardId: parentId, actionsSent: 2, element };
    });
  }

  /**
   * Liste de tâches : TASK_LIST sur le canvas, puis une TASK par entrée, enfant de la liste en section INBOX avec
   * position {index, score: index × 65536} (forme relevée sur des listes existantes, validée au test de fumée).
   */
  async addTaskList(args: { boardId: string; title?: string; tasks: string[]; dryRun: boolean }): Promise<WriteResult> {
    const boardId = this.boardIdOf(args.boardId);
    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(boardId, { fresh: true });
      const listId = this.ids.nextElementId();
      const ctx = await this.ctx();
      const createList = buildElementCreate(ctx, {
        id: listId,
        elementType: 'TASK_LIST',
        boardId,
        position: nextCanvasPosition(resp, boardId),
        content: { title: args.title ?? null, showTitle: Boolean(args.title) },
      });
      const taskIds = args.tasks.map(() => this.ids.nextElementId());
      const createTasks = args.tasks.map((text, index) =>
        buildElementCreate(ctx, {
          id: taskIds[index]!,
          elementType: 'TASK',
          boardId,
          parentId: listId,
          section: 'INBOX',
          position: { index, score: index * 65536 },
          content: { textContent: textToDoc([text], () => this.ids.blockKey()) },
        }),
      );
      const actions = [createList, ...createTasks];
      if (args.dryRun) return { dryRun: true, elementId: listId, boardId, actions, taskIds };
      await this.socket.withConnection(ctx.userId, async (emit) => {
        await emit(createList);
        await this.afterCreate(emit, ctx, boardId, [{ id: listId, elementType: 'TASK_LIST', location: createList.location }], async () => {
          for (const a of createTasks) await emit(a);
        });
      });
      this.boardCache.delete(boardId);
      const found = await this.confirm(`la liste ${listId}`, [listId, ...taskIds], (el, id) =>
        !el ? 'introuvable' : id === listId ? (el.elementType === 'TASK_LIST' ? undefined : `type ${el.elementType}`) : el.elementType === 'TASK' ? undefined : `type ${el.elementType}`,
      );
      return { dryRun: false, elementId: listId, boardId, actionsSent: actions.length, element: summarizeElement(found.get(listId)!), taskIds };
    });
  }

  /**
   * Coche ou décoche des tâches : ELEMENT_UPDATE de `isComplete`. Forme non capturée mais vérifiée le 2026-11-16 dans
   * le client web (case cochée, texte grisé) ; `completed` est accepté par le serveur sans effet visible, d'où ce choix.
   */
  async setTasksDone(args: { boardId: string; taskIds: string[]; done: boolean; dryRun: boolean }): Promise<{
    dryRun: boolean;
    boardId: string;
    actions?: object[];
    actionsSent?: number;
    tasks: { id: string; done: boolean }[];
  }> {
    const boardId = this.boardIdOf(args.boardId);
    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(boardId, { fresh: true });
      const owners = this.containersOf(resp, boardId);
      for (const id of args.taskIds) {
        const el = resp.elements[id];
        const list = el?.location?.parentId ? resp.elements[el.location.parentId] : undefined;
        if (!el || el.elementType !== 'TASK' || !list || list.elementType !== 'TASK_LIST' || !owners.has(list.location?.parentId ?? '')) {
          throw new MilanoteError(`${id} n'est pas une tâche d'une liste du board ${boardId}.`);
        }
      }
      const ctx = await this.ctx();
      const actions = args.taskIds.map((id) =>
        buildElementUpdate(ctx, { id, elementType: 'TASK', boardId, changes: { isComplete: args.done } }),
      );
      if (args.dryRun) return { dryRun: true, boardId, actions, tasks: args.taskIds.map((id) => ({ id, done: isTaskDone(resp.elements[id]!) })) };
      await this.socket.withConnection(ctx.userId, async (emit) => {
        for (const a of actions) await emit(a);
      });
      this.boardCache.delete(boardId);
      const found = await this.confirm(`${args.taskIds.length} tâche(s)`, args.taskIds, (el) =>
        !el ? 'introuvable' : isTaskDone(el) === args.done ? undefined : `toujours ${args.done ? 'non cochée' : 'cochée'}`,
      );
      return { dryRun: false, boardId, actionsSent: actions.length, tasks: args.taskIds.map((id) => ({ id, done: isTaskDone(found.get(id)!) })) };
    });
  }

  /**
   * Corbeille du board (geste « Suppr » du client web, capturé le 2026-10-09). Les cartes doivent être des enfants
   * directs du board ou d'une de ses colonnes. Confirmation : relecture, section `TRASH` attendue (ou carte absente).
   */
  async trashElements(args: { boardId: string; elementIds: string[]; dryRun: boolean }): Promise<{
    dryRun: boolean;
    boardId: string;
    actions?: object[];
    actionsSent?: number;
    trashed: string[];
  }> {
    const boardId = this.boardIdOf(args.boardId);
    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(boardId, { fresh: true });
      const moves = args.elementIds.map((id) => {
        const el = this.cardOf(resp, boardId, id);
        return { id, elementType: el.elementType, location: el.location ?? {} };
      });
      const ctx = await this.ctx();
      const action = buildElementTrash(ctx, { boardId, moves });
      if (args.dryRun) return { dryRun: true, boardId, actions: [action], trashed: [] };
      await this.socket.withConnection(ctx.userId, (emit) => emit(action));
      this.boardCache.delete(boardId);
      await this.confirm(`${args.elementIds.length} carte(s) à mettre à la corbeille`, args.elementIds, (el) =>
        !el || el.location?.section === 'TRASH' || el.location?.parentId === `${boardId}-trash` ? undefined : 'toujours sur le board',
      );
      return { dryRun: false, boardId, actionsSent: 1, trashed: args.elementIds };
    });
  }

  /**
   * Corbeille d'un board : `GET users/me/trash?other-users=false` (appel du panneau Corbeille, capturé le 2026-11-16)
   * renvoie la corbeille de tout le compte, les plus récents d'abord, par pages ; seuls les éléments dont le parent est
   * `<boardId>-trash` sont gardés. La page suivante n'a pas été capturée : seule la 1re page est lue (`hasMore` le dit).
   */
  async listTrash(args: { boardId: string; limit: number }): Promise<{
    boardId: string;
    items: (ElementSummary & { trashedAt?: string; restoreTo?: string })[];
    accountTrashScanned: number;
    hasMore: boolean;
  }> {
    const boardId = this.boardIdOf(args.boardId);
    const { all, hasMore } = await this.accountTrash();
    const trashId = `${boardId}-trash`;
    const items = all
      .filter((el) => el.location?.parentId === trashId)
      .map((el) => {
        const pos = rec(el.location?.position);
        const restore = rec(pos.restoreLocation);
        const added = typeof pos.addedDate === 'number' ? new Date(pos.addedDate).toISOString() : undefined;
        return { ...summarizeElement(el), trashedAt: added, restoreTo: str(restore.parentId) };
      })
      .sort((a, b) => (b.trashedAt ?? '').localeCompare(a.trashedAt ?? ''))
      .slice(0, args.limit);
    return { boardId, items, accountTrashScanned: all.length, hasMore };
  }

  /** 1re page de la corbeille du compte. Un élément à la corbeille est illisible par `GET elements` (404 BOARD_DELETED). */
  private async accountTrash(): Promise<{ all: Element[]; hasMore: boolean }> {
    this.session();
    const raw = rec(await this.rest.get<unknown>('users/me/trash', { 'other-users': false }));
    const resp = ElementsResponseSchema.parse({ elements: raw.elements ?? {} });
    return { all: Object.values(resp.elements), hasMore: raw.hasMore === true };
  }

  /**
   * Restaure des éléments de la corbeille d'un board à leur emplacement d'origine (`restoreLocation`), ou sur le canvas
   * si ce parent n'existe plus. `ELEMENT_MOVE_MULTI` « DROP » depuis `<boardId>-trash` (ws-11).
   */
  async restoreElements(args: { boardId: string; elementIds: string[]; dryRun: boolean }): Promise<{
    dryRun: boolean;
    boardId: string;
    actions?: object[];
    actionsSent?: number;
    restored: { id: string; parentId?: string; section?: string }[];
  }> {
    const boardId = this.boardIdOf(args.boardId);
    const trashId = `${boardId}-trash`;
    return this.write(args.dryRun, async () => {
      const board = await this.fetchBoard(boardId, { fresh: true });
      const containers = this.containersOf(board, boardId);
      const trash = await this.accountTrash();
      const inTrash = new Map(trash.all.map((e) => [e.id, e]));
      let canvas = nextCanvasPosition(board, boardId);
      const moves = args.elementIds.map((id) => {
        if (!isElementId(id)) throw new MilanoteError(`Identifiant invalide : ${id}`);
        const el = inTrash.get(id);
        if (!el || el.location?.parentId !== trashId) {
          throw new MilanoteError(
            `${id} n'est pas dans la corbeille du board ${boardId}` +
              (trash.hasMore ? ' (ou trop ancien : seule la 1re page de la corbeille du compte est lue, à restaurer dans le client web).' : '.'),
          );
        }
        const restore = rec(rec(el.location.position).restoreLocation) as ElementLocation;
        let to: ElementLocation;
        if (restore.parentId && containers.has(restore.parentId) && restore.section && restore.position) {
          to = { parentId: restore.parentId, section: restore.section, position: restore.position };
        } else {
          to = { parentId: boardId, section: 'CANVAS', position: canvas };
          canvas = { ...canvas, y: canvas.y + 30, score: canvas.score + 65536 };
        }
        return { id, elementType: el.elementType, from: el.location as ElementLocation, to };
      });
      const ctx = await this.ctx();
      const action = buildElementMove(ctx, { sourceBoardId: trashId, destinationBoardId: boardId, moves });
      const restored = moves.map((m) => ({ id: m.id, parentId: m.to.parentId, section: m.to.section }));
      if (args.dryRun) return { dryRun: true, boardId, actions: [action], restored };
      await this.socket.withConnection(ctx.userId, (emit) => emit(action));
      this.boardCache.delete(boardId);
      const want = new Map(moves.map((m) => [m.id, m.to]));
      await this.confirm(`${moves.length} élément(s) à restaurer`, args.elementIds, (el, id) =>
        !el ? 'introuvable' : el.location?.parentId === want.get(id)!.parentId && el.location?.section === want.get(id)!.section ? undefined : 'toujours à la corbeille',
      );
      return { dryRun: false, boardId, actionsSent: 1, restored };
    });
  }

  /**
   * Déplace des cartes d'un board : dans une colonne (fin de colonne), vers un autre board (section « À trier » du
   * board cible, comme un glisser-déposer sur le board) ou hors d'une colonne vers le canvas. `ELEMENT_MOVE_MULTI`
   * « DROP » (ws-13, ws-14).
   */
  async moveElements(args: { boardId: string; elementIds: string[]; targetBoardId?: string; columnId?: string; dryRun: boolean }): Promise<{
    dryRun: boolean;
    boardId: string;
    targetBoardId: string;
    actions?: object[];
    actionsSent?: number;
    moved: { id: string; parentId?: string; section?: string }[];
  }> {
    const boardId = this.boardIdOf(args.boardId);
    const targetId = args.targetBoardId ? this.boardIdOf(args.targetBoardId) : boardId;
    return this.write(args.dryRun, async () => {
      const source = await this.fetchBoard(boardId, { fresh: true });
      const target = targetId === boardId ? source : await this.fetchBoard(targetId, { fresh: true });
      const cards = args.elementIds.map((id) => {
        if (id === targetId) throw new MilanoteError(`Refus : ${id} est le board de destination.`);
        return this.cardOf(source, boardId, id);
      });

      let parentId: string;
      let section: 'CANVAS' | 'INBOX';
      if (args.columnId) {
        const col = target.elements[args.columnId];
        if (!col || col.elementType !== 'COLUMN' || col.location?.parentId !== targetId || col.location?.section === 'TRASH') {
          throw new MilanoteError(`${args.columnId} n'est pas une colonne du board ${targetId}.`);
        }
        [parentId, section] = [col.id, 'INBOX'];
      } else if (targetId !== boardId) {
        [parentId, section] = [targetId, 'INBOX'];
      } else {
        [parentId, section] = [boardId, 'CANVAS'];
        if (cards.every((c) => c.location?.parentId === boardId)) throw new MilanoteError('Rien à faire : ces cartes sont déjà sur le canvas. Indiquer column_id ou target_board_id.');
      }

      // Positions : fin de liste (colonne, « À trier ») ou sous la carte la plus basse (canvas).
      const siblings = Object.values(target.elements).filter((e) => e.location?.parentId === parentId && e.location?.section === section && !args.elementIds.includes(e.id));
      const maxScore = Math.max(-65536, ...siblings.map((e) => e.location?.position?.score ?? 0));
      let canvas = nextCanvasPosition(target, targetId);
      const moves = cards.map((el, i) => {
        let position: Record<string, unknown>;
        if (section === 'INBOX') {
          position = { index: siblings.length + i, score: Math.max(maxScore + 65536 * (i + 1), (siblings.length + i) * 65536) };
        } else {
          position = canvas;
          canvas = { ...canvas, y: canvas.y + 30, score: canvas.score + 65536 };
        }
        return { id: el.id, elementType: el.elementType, from: el.location as ElementLocation, to: { parentId, section, position } };
      });
      const ctx = await this.ctx();
      const action = buildElementMove(ctx, { sourceBoardId: boardId, destinationBoardId: targetId, moves });
      const moved = moves.map((m) => ({ id: m.id, parentId, section }));
      if (args.dryRun) return { dryRun: true, boardId, targetBoardId: targetId, actions: [action], moved };
      await this.socket.withConnection(ctx.userId, (emit) => emit(action));
      this.boardCache.delete(boardId);
      this.boardCache.delete(targetId);
      await this.confirm(`${moves.length} carte(s) à déplacer`, args.elementIds, (el) =>
        !el ? 'introuvable' : el.location?.parentId === parentId && el.location?.section === section ? undefined : 'pas à la destination',
      );
      return { dryRun: false, boardId, targetBoardId: targetId, actionsSent: 1, moved };
    });
  }

  /** Colonne sur le canvas : ELEMENT_CREATE (titre null, ws-12) puis ELEMENT_UPDATE du titre (ws-15). */
  async createColumn(args: { boardId: string; title?: string; dryRun: boolean }): Promise<WriteResult> {
    const boardId = this.boardIdOf(args.boardId);
    return this.write(args.dryRun, async () => {
      const resp = await this.fetchBoard(boardId, { fresh: true });
      const id = this.ids.nextElementId();
      const ctx = await this.ctx();
      const create = buildElementCreate(ctx, { id, elementType: 'COLUMN', boardId, position: nextCanvasPosition(resp, boardId), content: { title: null } });
      const update = args.title ? buildElementUpdate(ctx, { id, elementType: 'COLUMN', boardId, changes: { title: args.title } }) : undefined;
      const actions = update ? [create, update] : [create];
      if (args.dryRun) return { dryRun: true, elementId: id, boardId, actions };
      await this.socket.withConnection(ctx.userId, async (emit) => {
        await emit(create);
        if (update) await this.afterCreate(emit, ctx, boardId, [{ id, elementType: 'COLUMN', location: create.location }], () => emit(update));
      });
      this.boardCache.delete(boardId);
      const element = await this.confirmOne(id, (el) =>
        el.elementType !== 'COLUMN' ? `type ${el.elementType}` : args.title && str(el.content.title) !== args.title ? 'titre différent' : undefined,
      );
      return { dryRun: false, elementId: id, boardId, actionsSent: actions.length, element };
    });
  }

  // ---------------------------------------------------------------- aides

  /** Le board et ses colonnes : les conteneurs directs des cartes du board. */
  private containersOf(resp: ElementsResponse, boardId: string): Set<string> {
    return new Set([
      boardId,
      ...Object.values(resp.elements)
        .filter((e) => e.elementType === 'COLUMN' && e.location?.parentId === boardId)
        .map((e) => e.id),
    ]);
  }

  /** Carte (hors corbeille) posée sur le board ou dans une de ses colonnes ; erreur explicite sinon. */
  private cardOf(resp: ElementsResponse, boardId: string, id: string): Element {
    if (!isElementId(id)) throw new MilanoteError(`Identifiant invalide : ${id}`);
    if (id === boardId) throw new MilanoteError(`Refus : ${id} est le board lui-même.`);
    const el = resp.elements[id];
    const parent = el?.location?.parentId;
    if (!el || !parent || !this.containersOf(resp, boardId).has(parent)) {
      throw new MilanoteError(`${id} n'est pas une carte du board ${boardId} (ou est déjà à la corbeille).`);
    }
    if (el.location?.section === 'TRASH') throw new MilanoteError(`${id} est déjà à la corbeille.`);
    return el;
  }

  /** Aperçu du lien par Milanote ; en cas d'échec, carte lien minimale (url + titre). */
  private async unfurl(url: string, elementId: string, title?: string): Promise<Record<string, unknown>> {
    try {
      const raw = await this.rest.post<unknown>('/media-service/api/link', {
        url,
        elementId,
        environmentFolder: 'p',
        userId: (await this.whoami()).userId,
        locale: this.settings.locale,
      });
      const u = LinkUnfurlSchema.parse(raw);
      const { description, ...rest } = u;
      delete (rest as Record<string, unknown>).elementType;
      return {
        ...rest,
        link: { ...(u.link ?? { url }), ...(title ? { title } : {}) },
        ...(description ? { caption: textToDoc([description], () => this.ids.blockKey()), showCaption: true } : {}),
      };
    } catch (err) {
      if (err instanceof MilanoteAuthError) throw err;
      return { link: { url, title: title ?? url }, mediaType: 'NO_MEDIA' };
    }
  }
}

/** Nom de fichier sûr pour S3 et l'affichage : ASCII, extension cohérente avec le contenu. */
function sanitizeFilename(name: string, ext: string): string {
  const base =
    name.replace(/\.[^.]*$/, '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
  return `${base}.${ext}`;
}

/** `fr-fr` (variable d'environnement) → `fr-FR` (forme envoyée par le client web à la recherche). */
function toBcp47(locale: string): string {
  const [lang, region] = locale.split(/[-_]/);
  return region ? `${lang!.toLowerCase()}-${region.toUpperCase()}` : locale;
}
