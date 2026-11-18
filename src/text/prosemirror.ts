import type { PmNode } from '../schema/element.js';

/** Construit un document ProseMirror : une ligne de texte = un paragraphe (format observé, docs/endpoints.md §5). */
export function textToDoc(lines: string[], blockKey: () => string): PmNode {
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      attrs: { key: blockKey(), textAlign: 'left' },
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}

/** Ancien format Draft.js (`{blocks:[{text}]}`), encore présent dans des légendes et des cellules de tableau. */
interface DraftDoc {
  blocks?: { text?: string }[];
}

const DRAFT_PREFIX = '@@mn-draft-js:';

/** Texte brut d'un document ProseMirror ou Draft.js : un bloc par ligne, marques ignorées. */
export function docToText(doc: unknown): string {
  if (typeof doc === 'string') return doc.startsWith(DRAFT_PREFIX) ? docToText(parseDraft(doc)) : doc;
  if (!doc || typeof doc !== 'object') return '';
  if (Array.isArray((doc as DraftDoc).blocks)) {
    return ((doc as DraftDoc).blocks ?? []).map((b) => b.text ?? '').join('\n').replace(/\n+$/, '');
  }
  const blocks: string[] = [];
  const inline = (n: PmNode): string =>
    n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : (n.content ?? []).map(inline).join('');
  const walk = (n: PmNode): void => {
    const children = n.content ?? [];
    if (CONTAINERS.has(n.type)) children.forEach(walk);
    else blocks.push(inline(n));
  };
  walk(doc as PmNode);
  return blocks.join('\n').replace(/\n+$/, '');
}

const CONTAINERS = new Set(['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'taskList', 'taskItem']);

function parseDraft(s: string): unknown {
  try {
    return JSON.parse(s.slice(DRAFT_PREFIX.length));
  } catch {
    return s;
  }
}

/**
 * Markdown d'un document ProseMirror (titres, listes, citations, code, gras, italique, liens).
 * Types de nœuds observés dans les captures : paragraph, heading(level), bulletList, orderedList, listItem,
 * blockquote, hardBreak ; marques bold, italic, underline, highlight, link(href), textStyle, code.
 */
export function docToMarkdown(doc: unknown): string {
  if (typeof doc === 'string' || !doc || typeof doc !== 'object' || Array.isArray((doc as DraftDoc).blocks)) {
    return docToText(doc);
  }
  return renderBlocks((doc as PmNode).content ?? [], '').replace(/\n{3,}/g, '\n\n').trim();
}

function renderBlocks(nodes: PmNode[], indent: string): string {
  return nodes.map((n) => renderBlock(n, indent)).join('\n');
}

function renderBlock(n: PmNode, indent: string): string {
  switch (n.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)));
      return `${indent}${'#'.repeat(level)} ${renderInline(n.content ?? [])}\n`;
    }
    case 'bulletList':
      return (n.content ?? []).map((li) => renderListItem(li, indent, '- ')).join('') + '\n';
    case 'orderedList':
      return (n.content ?? []).map((li, i) => renderListItem(li, indent, `${i + 1}. `)).join('') + '\n';
    case 'taskList':
      return (n.content ?? []).map((li) => renderListItem(li, indent, n.attrs?.checked || li.attrs?.checked ? '- [x] ' : '- [ ] ')).join('') + '\n';
    case 'blockquote':
      return (
        renderBlocks(n.content ?? [], '')
          .trimEnd()
          .split('\n')
          .map((l) => `${indent}> ${l}`)
          .join('\n') + '\n'
      );
    case 'codeBlock':
      return `${indent}\`\`\`\n${(n.content ?? []).map((t) => t.text ?? '').join('')}\n${indent}\`\`\`\n`;
    case 'horizontalRule':
      return `${indent}---\n`;
    case 'paragraph':
    default: {
      const text = n.content ? renderInline(n.content) : renderInline([]);
      return `${indent}${text}\n`;
    }
  }
}

function renderListItem(li: PmNode, indent: string, marker: string): string {
  const children = li.content ?? [];
  const [first, ...rest] = children;
  const firstText = first ? renderBlock(first, '').trimEnd() : '';
  const nested = rest.length ? renderBlocks(rest, indent + '  ') : '';
  return `${indent}${marker}${firstText}\n${nested}`;
}

function renderInline(nodes: PmNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n';
      if (n.type === 'textMention') return String(n.attrs?.label ?? n.attrs?.name ?? '@…');
      if (n.type !== 'text') return renderInline(n.content ?? []);
      let t = n.text ?? '';
      if (!t.trim()) return t;
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`;
        else if (m.type === 'italic') t = `*${t}*`;
        else if (m.type === 'code') t = `\`${t}\``;
        else if (m.type === 'strike') t = `~~${t}~~`;
        else if (m.type === 'link' && typeof m.attrs?.href === 'string') t = `[${t}](${m.attrs.href})`;
      }
      return t;
    })
    .join('');
}
