import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildElementCreate, buildElementMove, buildElementSetType, buildElementTrash, buildElementUpdate } from '../src/actions.js';
import { IdSource } from '../src/client/ids.js';
import { fixture, TEST_BOARD_ID } from './helpers.js';

const ctx = { userId: '000000000000000000000001', ids: new IdSource(), now: 1_791_469_645_289 };

test('ELEMENT_CREATE a la même forme que la capture du client web (hors `tokens`)', () => {
  const captured = fixture<Record<string, unknown>>('ws-06-create-card.json');
  const built = buildElementCreate(ctx, {
    id: 'x',
    elementType: 'CARD',
    boardId: TEST_BOARD_ID,
    position: { x: 25, y: 40, score: 131072 },
    content: { textContent: null },
  });
  const expected = Object.keys(captured).filter((k) => k !== 'tokens').sort();
  assert.deepEqual(Object.keys(built).sort(), expected);
  assert.deepEqual(Object.keys(built.meta).sort(), Object.keys(captured.meta as object).sort());
  assert.equal(built.location.section, 'CANVAS');
  assert.deepEqual(built.channels, [TEST_BOARD_ID]);
});

test('ELEMENT_SET_TYPE reprend les champs de la capture du lien', () => {
  const captured = fixture<Record<string, unknown>>('ws-05-set-type-link.json');
  const built = buildElementSetType(ctx, { id: 'x', elementType: 'LINK', boardId: TEST_BOARD_ID, changes: {} });
  const expected = Object.keys(captured).filter((k) => k !== 'tokens').sort();
  assert.deepEqual(Object.keys(built).sort(), expected);
});

test('ELEMENT_UPDATE reprend les champs de la capture de l’image (hors `tokens`)', () => {
  const captured = fixture<Record<string, unknown>>('ws-09-update-image.json');
  const built = buildElementUpdate(ctx, { id: '1Xe000TESTCL05', elementType: 'IMAGE', boardId: TEST_BOARD_ID, changes: { image: {} } });
  const expected = Object.keys(captured).filter((k) => k !== 'tokens').sort();
  assert.deepEqual(Object.keys(built).sort(), expected);
  assert.deepEqual(built.activity, { track: false, boardId: TEST_BOARD_ID, elementTypes: { '1Xe000TESTCL05': 'IMAGE' } });
  assert.equal(built.recalculateChannels, false);
  assert.deepEqual(Object.keys(built.updates[0]!).sort(), ['changes', 'id']);
});

test('ELEMENT_CREATE d’une tâche : parent = liste, section INBOX, position {index, score}', () => {
  const built = buildElementCreate(ctx, {
    id: 't1',
    elementType: 'TASK',
    boardId: TEST_BOARD_ID,
    parentId: 'list1',
    section: 'INBOX',
    position: { index: 2, score: 131072 },
    content: { textContent: null },
  });
  assert.deepEqual(built.location, { parentId: 'list1', section: 'INBOX', position: { index: 2, score: 131072 } });
  assert.deepEqual(built.channels, [TEST_BOARD_ID]);
  assert.equal(built.activity.boardId, TEST_BOARD_ID);
});

test('ELEMENT_UPDATE du titre d’un board : canaux parent + nouveau board, comme la capture', () => {
  const captured = fixture<{ channels: string[] }>('ws-03-update-board-title.json');
  const built = buildElementUpdate(ctx, {
    id: TEST_BOARD_ID,
    elementType: 'BOARD',
    boardId: '1Xe000TESTCL01',
    extraChannels: [TEST_BOARD_ID],
    changes: { title: 'MCP-TEST' },
  });
  assert.deepEqual(built.channels, captured.channels);
});

test('ELEMENT_MOVE_MULTI vers la corbeille reprend la capture (hors `tokens`)', () => {
  const captured = fixture<Record<string, unknown>>('ws-10-trash-element.json');
  const built = buildElementTrash(ctx, {
    boardId: TEST_BOARD_ID,
    moves: [{ id: '1Xe000TESTCL03', elementType: 'LINK', location: { parentId: TEST_BOARD_ID, section: 'CANVAS', position: { x: 25, y: 190, score: 458752 } } }],
  });
  assert.deepEqual(Object.keys(built).sort(), Object.keys(captured).filter((k) => k !== 'tokens').sort());
  const move = built.moves[0]!;
  const capturedMove = (captured.moves as Record<string, unknown>[])[0]!;
  assert.deepEqual(move.from, capturedMove.from);
  assert.equal(move.location.parentId, `${TEST_BOARD_ID}-trash`);
  assert.equal(move.location.section, 'TRASH');
  assert.deepEqual(move.location.position.restoreLocation, capturedMove.from);
  assert.deepEqual(Object.keys(built.activity).sort(), Object.keys(captured.activity as object).sort());
  assert.deepEqual(built.activity.elementTypes, { '1Xe000TESTCL03': 'LINK' });
});

test('ELEMENT_MOVE_MULTI « DROP » : mêmes champs que les captures (restaurer, colonne, autre board)', () => {
  for (const name of ['ws-11-restore-element.json', 'ws-13-move-into-column.json', 'ws-14-move-to-board.json']) {
    const captured = fixture<{
      moves: { id: string; location: Record<string, unknown>; from: Record<string, unknown> }[];
      activity: { sourceBoardId: string; destinationBoardId: string; elementTypes: Record<string, string> };
      channels: string[];
    }>(name);
    const m = captured.moves[0]!;
    const built = buildElementMove(ctx, {
      sourceBoardId: captured.activity.sourceBoardId,
      destinationBoardId: captured.activity.destinationBoardId,
      moves: [{ id: m.id, elementType: captured.activity.elementTypes[m.id]!, from: m.from, to: m.location }],
    });
    const expected = Object.keys(captured).filter((k) => k !== 'tokens').sort();
    assert.deepEqual(Object.keys(built).sort(), expected, name);
    assert.deepEqual(built.moves, captured.moves, name);
    assert.deepEqual(built.activity, captured.activity, name);
    assert.deepEqual(built.channels, captured.channels, name);
    assert.equal(built.moveOperation, 'DROP');
  }
});

test('Colonne : ELEMENT_CREATE et mise à jour du titre ont la forme capturée', () => {
  const create = fixture<Record<string, unknown> & { meta: object; content: object }>('ws-12-create-column.json');
  const built = buildElementCreate(ctx, { id: 'c', elementType: 'COLUMN', boardId: TEST_BOARD_ID, position: { x: 1, y: 2, score: 3 }, content: { title: null } });
  assert.deepEqual(Object.keys(built).sort(), Object.keys(create).filter((k) => k !== 'tokens').sort());
  assert.deepEqual(built.content, create.content);
  const title = fixture<Record<string, unknown>>('ws-15-update-column-title.json');
  const upd = buildElementUpdate(ctx, { id: 'c', elementType: 'COLUMN', boardId: TEST_BOARD_ID, changes: { title: 'COL-TEST' } });
  assert.deepEqual(Object.keys(upd).sort(), Object.keys(title).filter((k) => k !== 'tokens').sort());
});
