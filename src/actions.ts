import type { IdSource } from './client/ids.js';

// Construction des actions socket.io, calquées sur les captures (test/fixtures/ws-*.json, docs/endpoints.md §4).

export interface ActionContext {
  userId: string;
  ids: IdSource;
  now?: number;
}

export type CanvasPosition = { x: number; y: number; score: number };
export type ListPosition = { index: number; score: number };

function envelope(ctx: ActionContext, boardId: string, extraChannels: string[] = []) {
  return {
    timestamp: ctx.now ?? Date.now(),
    sync: true,
    user: { _id: ctx.userId, clientId: ctx.ids.clientId, clientTick: 1 },
    deviceId: `mdid-${ctx.ids.deviceId}`,
    sessionId: `msid-${ctx.ids.sessionId}`,
    channels: [boardId, ...extraChannels],
    activity: { track: false, boardId },
  };
}

export function buildElementCreate(
  ctx: ActionContext,
  args: {
    id: string;
    elementType: 'CARD' | 'LINK' | 'IMAGE' | 'BOARD' | 'TASK_LIST' | 'TASK' | 'COLUMN';
    /** Board qui porte l'action (canal socket et `activity.boardId`). */
    boardId: string;
    /** Parent de l'élément ; par défaut le board (une tâche a pour parent sa liste). */
    parentId?: string;
    section?: 'CANVAS' | 'INBOX';
    position: CanvasPosition | ListPosition;
    content: Record<string, unknown>;
  },
) {
  const now = ctx.now ?? Date.now();
  return {
    id: args.id,
    type: 'ELEMENT_CREATE',
    elementType: args.elementType,
    location: { parentId: args.parentId ?? args.boardId, section: args.section ?? 'CANVAS', position: args.position },
    content: args.content,
    meta: {
      creator: ctx.userId,
      modifiedBy: ctx.userId,
      createdTime: now,
      modifiedTime: now,
      platform: 'Desktop web',
      locationSectionModifiedTime: now,
      versionId: ctx.ids.nextVersionId(),
    },
    creationSource: 'TOOLBAR',
    markAsFetched: true,
    ...envelope(ctx, args.boardId),
  };
}

export function buildElementSetType(
  ctx: ActionContext,
  args: { id: string; elementType: string; boardId: string; changes: Record<string, unknown> },
) {
  return {
    type: 'ELEMENT_SET_TYPE',
    id: args.id,
    elementType: args.elementType,
    changes: args.changes,
    ...envelope(ctx, args.boardId),
  };
}

export function buildElementUpdate(
  ctx: ActionContext,
  args: {
    id: string;
    elementType: string;
    boardId: string;
    changes: Record<string, unknown>;
    extraChannels?: string[];
    /** Versions de l'élément (édition d'une note, fixture ws-07) : version modifiée et nouvelle version. */
    meta?: { modifiedVersionId?: string; versionId: string };
  },
) {
  const { activity, ...env } = envelope(ctx, args.boardId, args.extraChannels);
  return {
    type: 'ELEMENT_UPDATE',
    updates: [{ id: args.id, changes: args.changes, ...(args.meta ? { meta: args.meta } : {}) }],
    recalculateChannels: false,
    ...env,
    activity: { ...activity, elementTypes: { [args.id]: args.elementType } },
  };
}

export interface TrashMove {
  id: string;
  elementType: string;
  /** Emplacement actuel (`location` lu en REST), repris tel quel dans `from` et `restoreLocation`. */
  location: { parentId?: string; section?: string; position?: Record<string, unknown> };
}

export interface ElementLocation {
  parentId?: string;
  section?: string;
  position?: Record<string, unknown>;
}

/**
 * Déplacement par glisser-déposer : `ELEMENT_MOVE_MULTI` avec `moveOperation: "DROP"`. Même forme pour restaurer depuis
 * la corbeille (source `<boardId>-trash`, ws-11), ranger dans une colonne (ws-13) et envoyer vers un autre board
 * (section INBOX du board cible, canaux cible puis source, ws-14).
 */
export function buildElementMove(
  ctx: ActionContext,
  args: {
    sourceBoardId: string;
    destinationBoardId: string;
    moves: { id: string; elementType: string; from: ElementLocation; to: ElementLocation }[];
  },
) {
  const sourceBase = args.sourceBoardId.replace(/-trash$/, '');
  const extra = sourceBase === args.destinationBoardId ? [] : [sourceBase];
  const { activity, ...env } = envelope(ctx, args.destinationBoardId, extra);
  return {
    type: 'ELEMENT_MOVE_MULTI',
    moves: args.moves.map((m) => ({ id: m.id, location: m.to, from: m.from })),
    moveOperation: 'DROP',
    monitoring: { operation: 'DROP' },
    ...env,
    activity: {
      track: activity.track,
      sourceBoardId: args.sourceBoardId,
      isSourceShared: false,
      destinationBoardId: args.destinationBoardId,
      isDestinationShared: false,
      elementTypes: Object.fromEntries(args.moves.map((m) => [m.id, m.elementType])),
    },
  };
}

/** Mise à la corbeille du board : `ELEMENT_MOVE_MULTI` vers `<boardId>-trash` (fixture ws-10-trash-element.json). */
export function buildElementTrash(ctx: ActionContext, args: { boardId: string; moves: TrashMove[] }) {
  const now = ctx.now ?? Date.now();
  const trashId = `${args.boardId}-trash`;
  const { activity, ...env } = envelope(ctx, args.boardId);
  const from = (m: TrashMove) => ({ parentId: m.location.parentId, position: m.location.position, section: m.location.section });
  return {
    type: 'ELEMENT_MOVE_MULTI',
    moves: args.moves.map((m) => ({
      id: m.id,
      location: { parentId: trashId, section: 'TRASH', position: { addedDate: now, restoreLocation: from(m) } },
      from: from(m),
    })),
    moveOperation: 'TRASH',
    monitoring: { operation: 'TRASH' },
    ...env,
    activity: {
      track: activity.track,
      sourceBoardId: args.boardId,
      isSourceShared: false,
      destinationBoardId: trashId,
      isDestinationShared: false,
      elementTypes: Object.fromEntries(args.moves.map((m) => [m.id, m.elementType])),
    },
  };
}
