import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToDoc } from '../src/text/markdown.js';
import { docToMarkdown, docToText } from '../src/text/prosemirror.js';

const key = () => 'kkkkk';

test('markdownToDoc : titres, listes, citation, marques en ligne, et aller-retour vers Markdown', () => {
  const md = '# Titre\nTexte **gras** et *italique* avec [lien](https://example.com)\n\n- un\n- deux\n1. premier\n> cité';
  const doc = markdownToDoc(md, key);
  assert.deepEqual(
    doc.content?.map((n) => n.type),
    ['heading', 'paragraph', 'paragraph', 'bulletList', 'orderedList', 'blockquote'],
  );
  assert.equal(doc.content?.[0]?.attrs?.level, 1);
  assert.deepEqual(doc.content?.[1]?.content, [
    { type: 'text', text: 'Texte ' },
    { type: 'text', text: 'gras', marks: [{ type: 'bold' }] },
    { type: 'text', text: ' et ' },
    { type: 'text', text: 'italique', marks: [{ type: 'italic' }] },
    { type: 'text', text: ' avec ' },
    { type: 'text', text: 'lien', marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }] },
  ]);
  assert.equal(doc.content?.[2]?.content, undefined, 'ligne vide = paragraphe vide sans content');
  assert.equal(doc.content?.[3]?.content?.length, 2);
  assert.equal(docToMarkdown(doc), '# Titre\n\nTexte **gras** et *italique* avec [lien](https://example.com)\n\n- un\n- deux\n\n1. premier\n\n> cité');
});

test('markdownToDoc : du texte brut reste du texte brut, une ligne par paragraphe', () => {
  const doc = markdownToDoc('Ligne 1\nLigne 2 avec 2*3 et a_b', key);
  assert.equal(docToText(doc), 'Ligne 1\nLigne 2 avec 2*3 et a_b');
  assert.ok(doc.content?.every((n) => n.type === 'paragraph'));
  assert.deepEqual(doc.content?.[0]?.attrs, { key: 'kkkkk', textAlign: 'left' });
});
