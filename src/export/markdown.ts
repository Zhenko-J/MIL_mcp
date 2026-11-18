import { childrenIndex, isTaskDone, tableRows } from '../board.js';
import type { Element, ElementsResponse } from '../schema/element.js';
import { docToMarkdown, docToText } from '../text/prosemirror.js';

// Rendu Markdown d'un board à partir des réponses REST (fonction pure, testée sur test/fixtures).
// Le rendu est fait côté client : l'export serveur `POST /api/export/{id}` a des formats non vérifiés
// (docs/endpoints.md §7, n°8).

export interface ExportOptions {
  /** Boards déjà chargés, par id : un sous-board présent ici est rendu en entier, sinon il est seulement cité. */
  boards: Map<string, ElementsResponse>;
  /** Profondeur de récursion restante. */
  depth: number;
  /** Préfixe de titre (`#` du board racine, `##` des sous-boards…). */
  level?: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const IGNORED = new Set(['COMMENT_THREAD', 'LINE', 'ANNOTATION', 'SKELETON', 'UNKNOWN', 'CLONE', 'SKETCH']);

export function boardToMarkdown(boardId: string, opts: ExportOptions): string {
  const resp = opts.boards.get(boardId);
  const level = opts.level ?? 1;
  if (!resp) return `${'#'.repeat(level)} (board ${boardId} non chargé)\n`;
  const board = resp.elements[boardId];
  const title = str(board?.content.title) ?? boardId;
  const idx = childrenIndex(resp);
  const out: string[] = [`${'#'.repeat(level)} ${title}`, ''];
  const children = idx.get(boardId) ?? [];
  const section = (name: string) => children.filter((e) => (e.location?.section ?? 'CANVAS') === name);

  out.push(...renderList(section('CANVAS'), idx, opts, level));
  const inbox = section('INBOX');
  if (inbox.length) out.push(`${'#'.repeat(level + 1)} À trier`, '', ...renderList(inbox, idx, opts, level + 1));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function renderList(els: Element[], idx: Map<string, Element[]>, opts: ExportOptions, level: number): string[] {
  const out: string[] = [];
  for (const el of els) {
    if (IGNORED.has(el.elementType)) continue;
    out.push(...renderElement(el, idx, opts, level), '');
  }
  return out;
}

function caption(c: Record<string, unknown>): string[] {
  const text = c.showCaption === false ? '' : docToMarkdown(c.caption);
  return text ? [text] : [];
}

function renderElement(el: Element, idx: Map<string, Element[]>, opts: ExportOptions, level: number): string[] {
  const c = el.content;
  switch (el.elementType) {
    case 'CARD':
    case 'DOCUMENT':
      return [docToMarkdown(c.textContent) || '(note vide)'];
    case 'LINK': {
      const link = rec(c.link);
      const url = str(link.url) ?? str(c.url) ?? '';
      const title = str(link.title) ?? url;
      return [`[${title}](${url})`, ...caption(c)];
    }
    case 'IMAGE': {
      const image = rec(c.image);
      const file = rec(c.file);
      const alt = str(file.filename) ?? 'image';
      const url = str(image.original) ?? str(image.large) ?? '';
      return [url ? `![${alt}](${url})` : `(image ${alt} sans URL)`, ...caption(c)];
    }
    case 'FILE': {
      const file = rec(c.file);
      const name = str(file.filename) ?? 'fichier';
      const url = str(file.url);
      return [url ? `📎 [${name}](${url})` : `📎 ${name}`];
    }
    case 'COLUMN': {
      const h = `${'#'.repeat(Math.min(6, level + 1))} ${str(c.title) || 'Colonne'}`;
      return [h, '', ...renderList(idx.get(el.id) ?? [], idx, opts, level + 1)];
    }
    case 'TASK_LIST': {
      const tasks = (idx.get(el.id) ?? []).filter((t) => t.elementType === 'TASK');
      const title = c.showTitle === false ? undefined : str(c.title);
      return [
        ...(title ? [`**${title}**`] : []),
        ...tasks.map((t) => `- [${isTaskDone(t) ? 'x' : ' '}] ${docToText(t.content.textContent)}`),
      ];
    }
    case 'TASK':
      return [`- [${isTaskDone(el) ? 'x' : ' '}] ${docToText(c.textContent)}`];
    case 'TABLE':
      return renderTable(c);
    case 'COLOR_SWATCH': {
      const color = rec(c.color);
      return [`🎨 ${str(color.value) ?? ''}`.trim(), ...caption(c)];
    }
    case 'BOARD':
    case 'ALIAS': {
      const targetId = (el.elementType === 'ALIAS' ? str(c.linkTo) : undefined) ?? el.id;
      const title = str(c.title) ?? str(c.originalTitle) ?? targetId;
      if (opts.depth > 0 && opts.boards.has(targetId)) {
        return [boardToMarkdown(targetId, { ...opts, depth: opts.depth - 1, level: Math.min(6, level + 1) }).trimEnd()];
      }
      return [`📋 **${title}** (board ${targetId})`];
    }
    default:
      return [`(${el.elementType} ${el.id})`];
  }
}

function renderTable(c: Record<string, unknown>): string[] {
  const rows = tableRows(c).map((r) => r.map((cell) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')));
  if (rows.length === 0) return ['(tableau vide)'];
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill('')];
  const [head, ...body] = rows.map(pad);
  const title = c.showTitle === false ? undefined : str(c.title);
  return [
    ...(title ? [`**${title}**`, ''] : []),
    `| ${head!.join(' | ')} |`,
    `| ${head!.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
}
