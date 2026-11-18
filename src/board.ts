import type { Element, ElementsResponse } from './schema/element.js';
import { docToText } from './text/prosemirror.js';

// Fonctions pures de lecture d'une réponse `GET /api/boards?ids=…` (testées sur test/fixtures).

export interface BoardRef {
  id: string;
  title: string;
  /** Board réel visé ; différent de `id` quand l'entrée est un alias. */
  targetId: string;
  isAlias: boolean;
  parentId: string | undefined;
  /** Titre de la colonne qui contient le board, le cas échéant. */
  column: string | undefined;
}

export interface TaskSummary {
  id: string;
  text: string;
  done: boolean;
}

export interface ElementSummary {
  id: string;
  type: string;
  section: string | undefined;
  parentId: string | undefined;
  column: string | undefined;
  x: number | undefined;
  y: number | undefined;
  title?: string;
  text?: string;
  url?: string;
  imageUrl?: string;
  caption?: string;
  /** TASK_LIST : tâches dans l'ordre ; TASK : état coché. */
  tasks?: TaskSummary[];
  done?: boolean;
  /** TABLE : cellules en texte brut (50 lignes au plus, voir `truncated`). */
  rows?: string[][];
  truncated?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const MAX_TABLE_ROWS = 50;

/**
 * Tâche cochée : `content.isComplete`. Vérifié dans le client web le 2026-11-16 : `isComplete: true` dessine la case
 * cochée et grise le texte ; `completed: true` (autre champ présent sur d'anciennes tâches, avec `completionTime`)
 * n'a aucun effet visible.
 */
export function isTaskDone(el: Element): boolean {
  return el.content.isComplete === true;
}

/** Position de tri : index/score dans une liste ou une colonne, y puis x sur le canvas. */
export function byPosition(a: Element, b: Element): number {
  const pa = a.location?.position ?? {};
  const pb = b.location?.position ?? {};
  if (pa.index !== undefined || pb.index !== undefined) return (pa.index ?? 0) - (pb.index ?? 0) || (pa.score ?? 0) - (pb.score ?? 0);
  return (pa.y ?? 0) - (pb.y ?? 0) || (pa.x ?? 0) - (pb.x ?? 0);
}

/** Enfants de chaque élément, triés par position. */
export function childrenIndex(resp: ElementsResponse): Map<string, Element[]> {
  const idx = new Map<string, Element[]>();
  for (const el of Object.values(resp.elements)) {
    const p = el.location?.parentId;
    if (!p) continue;
    if (!idx.has(p)) idx.set(p, []);
    idx.get(p)!.push(el);
  }
  for (const list of idx.values()) list.sort(byPosition);
  return idx;
}

/** Cellules d'un tableau (`content.tableContent.data`) en texte brut. */
export function tableRows(c: Record<string, unknown>): string[][] {
  const data = rec(c.tableContent).data;
  if (!Array.isArray(data)) return [];
  return data.map((row: unknown) => (Array.isArray(row) ? row : []).map((cell: unknown) => docToText(rec(cell).value)));
}

/** Éléments situés sous `boardId`, directement ou dans une colonne de ce board. */
function childrenOf(resp: ElementsResponse, boardId: string): { el: Element; column: Element | undefined }[] {
  const els = Object.values(resp.elements);
  const columns = new Map(
    els.filter((e) => e.elementType === 'COLUMN' && e.location?.parentId === boardId).map((c) => [c.id, c]),
  );
  const out: { el: Element; column: Element | undefined }[] = [];
  for (const el of els) {
    const parent = el.location?.parentId;
    if (el.id === boardId || !parent) continue;
    if (parent === boardId) out.push({ el, column: undefined });
    else if (columns.has(parent)) out.push({ el, column: columns.get(parent) });
  }
  return out;
}

const VISIBLE_SECTIONS = new Set(['CANVAS', 'INBOX', undefined]);

export function listBoards(resp: ElementsResponse, boardId: string): BoardRef[] {
  return childrenOf(resp, boardId)
    .filter(({ el }) => (el.elementType === 'BOARD' || el.elementType === 'ALIAS') && VISIBLE_SECTIONS.has(el.location?.section))
    .map(({ el, column }) => {
      const isAlias = el.elementType === 'ALIAS';
      return {
        id: el.id,
        title: str(el.content.title) ?? str(el.content.originalTitle) ?? '',
        targetId: (isAlias ? str(el.content.linkTo) : undefined) ?? el.id,
        isAlias,
        parentId: el.location?.parentId,
        column: column ? (str(column.content.title) ?? '') : undefined,
      };
    });
}

/**
 * Résumé d'un élément. `children` (index des enfants de la réponse REST) permet de joindre les tâches d'une liste.
 */
export function summarizeElement(el: Element, column?: Element, children?: Map<string, Element[]>): ElementSummary {
  const c = el.content;
  const base: ElementSummary = {
    id: el.id,
    type: el.elementType,
    section: el.location?.section,
    parentId: el.location?.parentId,
    column: column ? (str(column.content.title) ?? '') : undefined,
    x: el.location?.position?.x,
    y: el.location?.position?.y,
  };
  switch (el.elementType) {
    case 'BOARD':
    case 'COLUMN':
      return { ...base, title: str(c.title) ?? '' };
    case 'ALIAS':
      return { ...base, title: str(c.title) ?? str(c.originalTitle) ?? '', url: str(c.linkTo) };
    case 'CARD':
    case 'DOCUMENT':
      return { ...base, text: docToText(c.textContent) };
    case 'LINK': {
      const link = rec(c.link);
      return { ...base, url: str(link.url) ?? str(c.url), title: str(link.title), caption: docToText(c.caption) || undefined };
    }
    case 'IMAGE': {
      const image = rec(c.image);
      return { ...base, imageUrl: str(image.original), caption: docToText(c.caption) || undefined };
    }
    case 'FILE': {
      const file = rec(c.file);
      return { ...base, title: str(file.filename), url: str(file.url) };
    }
    case 'TASK':
      return { ...base, text: docToText(c.textContent), done: isTaskDone(el) };
    case 'TASK_LIST': {
      const tasks = (children?.get(el.id) ?? [])
        .filter((t) => t.elementType === 'TASK' && t.location?.section !== 'TRASH')
        .map((t) => ({ id: t.id, text: docToText(t.content.textContent), done: isTaskDone(t) }));
      return { ...base, title: c.showTitle === false ? undefined : str(c.title), tasks };
    }
    case 'TABLE': {
      const rows = tableRows(c);
      return {
        ...base,
        title: c.showTitle === false ? undefined : str(c.title),
        rows: rows.slice(0, MAX_TABLE_ROWS),
        ...(rows.length > MAX_TABLE_ROWS ? { truncated: true } : {}),
      };
    }
    case 'COLOR_SWATCH':
      return { ...base, text: str(rec(c.color).value) };
    default:
      return base;
  }
}

export function boardContent(resp: ElementsResponse, boardId: string): { board: ElementSummary | undefined; elements: ElementSummary[] } {
  const board = resp.elements[boardId];
  const idx = childrenIndex(resp);
  const order = (s: ElementSummary) => (s.section === 'INBOX' ? 1 : 0);
  const elements = childrenOf(resp, boardId)
    .filter(({ el }) => VISIBLE_SECTIONS.has(el.location?.section))
    .map(({ el, column }) => summarizeElement(el, column, idx))
    .sort((a, b) => order(a) - order(b) || (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
  return { board: board ? summarizeElement(board) : undefined, elements };
}

/** Hauteur estimée d'une carte en unités de grille (10 px) : connue pour les colonnes, déduite du ratio pour les images, 27 sinon. */
function estimatedHeight(el: Element): number {
  const c = el.content;
  const width = typeof c.width === 'number' ? c.width : 34;
  if (el.elementType === 'COLUMN' && typeof c.height === 'number') return c.height;
  if (el.elementType === 'IMAGE') {
    const image = rec(c.image);
    const w = typeof image.width === 'number' ? image.width : 0;
    const h = typeof image.height === 'number' ? image.height : 0;
    const base = w > 0 && h > 0 ? (typeof c.width === 'number' ? width : Math.min(width, w / 10)) * (h / w) : 27;
    return base + (c.caption && c.showCaption !== false ? 6 : 0);
  }
  return 27;
}

/**
 * Position d'une nouvelle carte sur le canvas : sous la carte la plus basse (bas estimé + 3 unités), colonne x=25.
 * Unité : grille de 10 px. Le calcul exact de `score` reste inconnu (docs/endpoints.md §7, n°5).
 */
export function nextCanvasPosition(resp: ElementsResponse, boardId: string): { x: number; y: number; score: number } {
  const onCanvas = childrenOf(resp, boardId).filter(({ el, column }) => !column && el.location?.section === 'CANVAS');
  const bottom = Math.max(-17, ...onCanvas.map(({ el }) => (el.location?.position?.y ?? 0) + estimatedHeight(el)));
  const maxScore = Math.max(0, ...onCanvas.map(({ el }) => el.location?.position?.score ?? 0));
  return { x: 25, y: Math.round(bottom + 3), score: maxScore + 65536 };
}
