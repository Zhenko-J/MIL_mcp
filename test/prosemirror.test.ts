import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docToText, textToDoc } from '../src/text/prosemirror.js';
import { fixture } from './helpers.js';

test('docToText sur la note capturée (gras ignoré)', () => {
  const action = fixture<{ updates: { changes: { textContent: unknown } }[] }>('ws-07-update-card-text.json');
  assert.equal(docToText(action.updates[0]!.changes.textContent), 'Titre test MCP\nTexte de test gras fin.');
});

test('textToDoc produit le format observé et fait l’aller-retour', () => {
  const doc = textToDoc(['Titre', '', 'Ligne 2'], () => 'k1234');
  assert.deepEqual(doc.content?.[0], {
    type: 'paragraph',
    attrs: { key: 'k1234', textAlign: 'left' },
    content: [{ type: 'text', text: 'Titre' }],
  });
  assert.equal(doc.content?.[1]?.content, undefined); // paragraphe vide sans `content`, comme le client web
  assert.equal(docToText(doc), 'Titre\n\nLigne 2');
});

test('docToText tolère les entrées absentes', () => {
  assert.equal(docToText(null), '');
  assert.equal(docToText(undefined), '');
});
