import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardToMarkdown } from '../src/export/markdown.js';
import { ElementsResponseSchema } from '../src/schema/element.js';
import { docToMarkdown } from '../src/text/prosemirror.js';
import { fixture, ROOT_ID, TEST_BOARD_ID } from './helpers.js';

const home = ElementsResponseSchema.parse(fixture('rest-boards-home.json'));
const testBoard = ElementsResponseSchema.parse(fixture('rest-board-mcp-test.json'));

test('boardToMarkdown : le board de test (lien, note en gras, image dans « À trier »)', () => {
  const md = boardToMarkdown(TEST_BOARD_ID, { boards: new Map([[TEST_BOARD_ID, testBoard]]), depth: 0 });
  assert.match(md, /^# MCP-TEST\n/);
  assert.match(md, /\[Example Domain\]\(https:\/\/example\.com\)/);
  assert.match(md, /Titre test MCP\n\nTexte de test \*\*gras\*\* fin\./);
  assert.match(md, /## À trier\n\n!\[mcp-test-image\.png\]\(https:\/\/app\.milanote\.com\/media\/.+\.png\)/);
});

test('boardToMarkdown : accueil anonymisé, colonnes rendues en titres, sous-boards cités', () => {
  const shallow = boardToMarkdown(ROOT_ID, { boards: new Map([[ROOT_ID, home]]), depth: 0 });
  assert.match(shallow, /^# <title>\n/);
  assert.match(shallow, /^## <title>$/m, 'au moins une colonne rendue en titre');
  assert.match(shallow, /📋 \*\*[^*]+\*\* \(board 1Xe000TESTCL0[a-z]\)/, 'sous-boards cités avec leur id');
});

test('boardToMarkdown : un sous-board est développé avec depth > 0, cité sinon', () => {
  const parentId = '1Xe000TESTCL00';
  const parent = ElementsResponseSchema.parse({
    elements: {
      [parentId]: { id: parentId, elementType: 'BOARD', content: { title: 'Parent' } },
      [TEST_BOARD_ID]: {
        id: TEST_BOARD_ID,
        elementType: 'BOARD',
        content: { title: 'MCP-TEST' },
        location: { parentId, section: 'CANVAS', position: { x: 0, y: 0 } },
      },
    },
  });
  const boards = new Map([[parentId, parent], [TEST_BOARD_ID, testBoard]]);
  assert.match(boardToMarkdown(parentId, { boards, depth: 0 }), /📋 \*\*MCP-TEST\*\* \(board 1Xe000TESTCL02\)/);
  const deep = boardToMarkdown(parentId, { boards, depth: 1 });
  assert.match(deep, /^## MCP-TEST$/m, 'sous-board développé un niveau plus bas');
  assert.match(deep, /\[Example Domain\]/);
  assert.match(deep, /^### À trier$/m);
});

test('docToMarkdown : titres, listes, citation, liens et texte Draft.js', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titre' }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'un' }] }] },
        { type: 'listItem', content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'deux' }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'deux-a' }] }] }] },
        ] },
      ] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cité' }] }] },
      { type: 'paragraph', content: [
        { type: 'text', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'italic' }], text: 'lien' },
      ] },
    ],
  };
  assert.equal(docToMarkdown(doc), '## Titre\n\n- un\n- deux\n  - deux-a\n\n> cité\n\n*[lien](https://example.com)*');
  assert.equal(docToMarkdown('@@mn-draft-js:{"blocks":[{"text":"Phase"}]}'), 'Phase');
  assert.equal(docToMarkdown({ blocks: [{ text: 'a' }, { text: 'b' }] }), 'a\nb');
});
