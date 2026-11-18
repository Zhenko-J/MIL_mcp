import type { PmNode } from '../schema/element.js';

/**
 * Markdown ligne à ligne → document ProseMirror (format de docs/endpoints.md §5, nœuds observés dans les captures).
 * Une ligne = un bloc (comme le texte brut d'avant) ; reconnus : `# titre` (1-6), `- `/`* ` puces, `1. ` numéros,
 * `> ` citation, ligne vide = paragraphe vide ; en ligne : **gras**, *italique*, `code`, [texte](url).
 * Les listes contiguës sont regroupées. Tout le reste est du texte.
 */
export function markdownToDoc(markdown: string, blockKey: () => string): PmNode {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const content: PmNode[] = [];
  let list: { node: PmNode; ordered: boolean } | undefined;

  const paragraph = (text: string): PmNode => ({
    type: 'paragraph',
    attrs: { key: blockKey(), textAlign: 'left' },
    ...(text ? { content: inlineNodes(text) } : {}),
  });
  const closeList = () => {
    list = undefined;
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading) {
      closeList();
      content.push({
        type: 'heading',
        attrs: { key: blockKey(), textAlign: 'left', level: heading[1]!.length },
        content: inlineNodes(heading[2]!),
      });
    } else if (bullet || ordered) {
      const isOrdered = !bullet;
      if (!list || list.ordered !== isOrdered) {
        list = { node: { type: isOrdered ? 'orderedList' : 'bulletList', attrs: { key: blockKey() }, content: [] }, ordered: isOrdered };
        content.push(list.node);
      }
      list.node.content!.push({ type: 'listItem', attrs: { key: blockKey() }, content: [paragraph((bullet ?? ordered)![1]!)] });
    } else if (quote) {
      closeList();
      content.push({ type: 'blockquote', attrs: { key: blockKey() }, content: [paragraph(quote[1]!)] });
    } else {
      closeList();
      content.push(paragraph(line));
    }
  }
  return { type: 'doc', content };
}

type Mark = { type: string; attrs?: Record<string, unknown> };

/** Découpe les marques en ligne : liens, gras, italique, code. Les imbrications simples sont gérées. */
export function inlineNodes(text: string, marks: Mark[] = []): PmNode[] {
  const out: PmNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|`([^`]+)`|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(textNode(text.slice(last, m.index), marks));
    if (m[1] !== undefined) out.push(...inlineNodes(m[1], [...marks, { type: 'link', attrs: { href: m[2], target: '_blank' } }]));
    else if (m[3] !== undefined) out.push(...inlineNodes(m[3], [...marks, { type: 'bold' }]));
    else if (m[4] !== undefined) out.push(textNode(m[4], [...marks, { type: 'code' }]));
    else if (m[5] !== undefined) out.push(...inlineNodes(m[5], [...marks, { type: 'italic' }]));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(textNode(text.slice(last), marks));
  return out;
}

function textNode(text: string, marks: Mark[]): PmNode {
  return { type: 'text', text, ...(marks.length ? { marks } : {}) };
}
