import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardContent, listBoards, nextCanvasPosition } from '../src/board.js';
import { ElementsResponseSchema } from '../src/schema/element.js';
import { fixture, ROOT_ID, TEST_BOARD_ID } from './helpers.js';

const home = ElementsResponseSchema.parse(fixture('rest-boards-home.json'));
const testBoard = ElementsResponseSchema.parse(fixture('rest-board-mcp-test.json'));

test('les réponses REST capturées passent les schémas', () => {
  for (const f of ['rest-boards-home.json', 'rest-board-mcp-test.json', 'rest-elements-batch.json']) {
    assert.doesNotThrow(() => ElementsResponseSchema.parse(fixture(f)), f);
  }
});

test('positions en texte : converties ou ignorées, le board reste lisible (cas vu sur un board réel)', () => {
  const resp = ElementsResponseSchema.parse({
    elements: {
      [TEST_BOARD_ID]: { id: TEST_BOARD_ID, elementType: 'BOARD', content: { title: 'MCP-TEST' } },
      '1WCm6Y1UWWGU6b': {
        id: '1WCm6Y1UWWGU6b', elementType: 'CARD', content: {},
        location: { parentId: TEST_BOARD_ID, section: 'CANVAS', position: { x: '120', y: '-35.5', score: 65536 } },
      },
      '1WCm6K1UWWGU69': {
        id: '1WCm6K1UWWGU69', elementType: 'CARD', content: {},
        location: { parentId: TEST_BOARD_ID, section: 'CANVAS', position: { x: 'abc', y: '', index: null } },
      },
    },
  });
  const a = resp.elements['1WCm6Y1UWWGU6b']?.location?.position;
  assert.equal(a?.x, 120);
  assert.equal(a?.y, -35.5);
  assert.equal(a?.score, 65536);
  const b = resp.elements['1WCm6K1UWWGU69']?.location?.position;
  assert.equal(b?.x, undefined);
  assert.equal(b?.y, undefined);
  assert.equal(b?.index, undefined);
  assert.equal(boardContent(resp, TEST_BOARD_ID).elements.length, 2);
  assert.doesNotThrow(() => nextCanvasPosition(resp, TEST_BOARD_ID));
});

test('get_board : notes, liens et images du board de test', () => {
  const { board, elements } = boardContent(testBoard, TEST_BOARD_ID);
  assert.equal(board?.type, 'BOARD');
  assert.deepEqual(
    elements.map((e) => [e.type, e.section]),
    [['LINK', 'CANVAS'], ['CARD', 'CANVAS'], ['IMAGE', 'INBOX']],
  );
  const [link, card, image] = elements;
  assert.equal(link?.url, 'https://example.com');
  assert.equal(link?.title, 'Example Domain');
  assert.equal(card?.text, 'Titre test MCP\nTexte de test gras fin.');
  assert.match(image?.imageUrl ?? '', /^https:\/\/app\.milanote\.com\/media\/.+\.png$/);
});

test('list_boards : boards et alias rangés dans les colonnes de l’accueil', () => {
  const boards = listBoards(home, ROOT_ID);
  assert.ok(boards.length > 0);
  assert.ok(boards.every((b) => b.column !== undefined), 'tous les boards de la fixture sont dans des colonnes');
  const alias = boards.find((b) => b.isAlias);
  assert.ok(alias, 'au moins un alias');
  assert.equal(listBoards(home, ROOT_ID).some((b) => b.id === ROOT_ID), false, 'le board lui-même est exclu');
});

test('nextCanvasPosition place la carte sous les cartes existantes', () => {
  const pos = nextCanvasPosition(testBoard, TEST_BOARD_ID);
  assert.equal(pos.x, 25);
  assert.equal(pos.y, 40 + 27 + 3); // note la plus basse à y=40, hauteur estimée 27, marge 3 (l'image en INBOX ne compte pas)
  assert.equal(pos.score, 131072 + 65536);
});
