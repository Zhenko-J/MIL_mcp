import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MilanoteError, MilanoteUnconfirmedWriteError, MilanoteWriteDisabledError } from '../src/client/errors.js';
import { Milanote } from '../src/milanote.js';
import { writeMarkdownFile } from '../src/tools/export-board-markdown.js';
import { BOARD, FakeMilanote, makeMilanote, OTHER_BOARD, SETTINGS, tinyPng } from './fakes.js';

const count = (log: string[], entry: string) => log.filter((l) => l === entry).length;

test('add_note dry_run : action construite, rien d’envoyé', async () => {
  const fake = new FakeMilanote();
  const res = await makeMilanote(fake, { enableWrite: false }).addNote({ boardId: BOARD, title: 'T', body: '- a', dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.actions?.length, 1);
  assert.equal(fake.emitted.length, 0);
});

test('écritures désactivées : refus avant toute lecture ou envoi', async () => {
  const fake = new FakeMilanote();
  await assert.rejects(makeMilanote(fake, { enableWrite: false }).addNote({ boardId: BOARD, body: 'x', dryRun: false }), MilanoteWriteDisabledError);
  assert.deepEqual(fake.log, []);
});

test('add_note : relue jusqu’à ce que la note apparaisse, un seul envoi, réponse sans le détail des actions', async () => {
  const fake = new FakeMilanote();
  fake.visibleAfterReads = 2; // visible à la 3e relecture
  const res = await makeMilanote(fake).addNote({ boardId: BOARD, title: 'Titre', body: 'Ligne **grasse**', dryRun: false });
  assert.equal(count(fake.log, 'emit ELEMENT_CREATE'), 1);
  assert.equal(count(fake.log, 'GET elements'), 3);
  assert.equal(res.element?.text, 'Titre\nLigne grasse');
  assert.equal(res.actions, undefined);
  assert.equal(res.actionsSent, 1);
});

test('écriture acquittée sans effet : erreur « non confirmée », jamais de nouvel envoi', async () => {
  const fake = new FakeMilanote();
  fake.dropActions = true;
  await assert.rejects(makeMilanote(fake).addNote({ boardId: BOARD, body: 'x', dryRun: false }), MilanoteUnconfirmedWriteError);
  assert.equal(fake.emitted.length, 1);
  assert.equal(count(fake.log, 'GET elements'), 3);
});

test('add_image : un échec de téléversement met la carte vide à la corbeille et le dit', async () => {
  const fake = new FakeMilanote();
  fake.presignFails = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milanote-mcp-test-'));
  const file = path.join(dir, 'x.png');
  fs.writeFileSync(file, tinyPng());
  try {
    await assert.rejects(makeMilanote(fake).addImage({ boardId: BOARD, filePath: file, dryRun: false }), (e: Error) => /corbeille/.test(e.message));
    const types = fake.emitted.map((a) => a.type);
    assert.deepEqual(types, ['ELEMENT_CREATE', 'ELEMENT_MOVE_MULTI']);
    const id = String(fake.emitted[0]!.id);
    assert.equal(fake.els.get(id)?.location?.section, 'TRASH');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('add_image : séquence complète confirmée (création, presign, S3, mise à jour)', async () => {
  const fake = new FakeMilanote();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milanote-mcp-test-'));
  const file = path.join(dir, 'photo test.png');
  fs.writeFileSync(file, tinyPng());
  try {
    const res = await makeMilanote(fake).addImage({ boardId: BOARD, filePath: file, caption: 'Légende', dryRun: false });
    assert.match(res.element?.imageUrl ?? '', /^https:\/\/app\.milanote\.com\/media\/p\/images\/.+\/photo-test\.png$/);
    assert.equal(res.element?.caption, 'Légende');
    assert.ok(fake.log.indexOf('PUT s3') < fake.log.lastIndexOf('emit ELEMENT_UPDATE'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deux écritures simultanées passent l’une après l’autre : positions différentes', async () => {
  const fake = new FakeMilanote();
  const mn = makeMilanote(fake);
  const [a, b] = await Promise.all([
    mn.addNote({ boardId: BOARD, body: 'a', dryRun: false }),
    mn.addNote({ boardId: BOARD, body: 'b', dryRun: false }),
  ]);
  assert.notEqual(a.element?.y, b.element?.y);
  // La 2e lecture du board suit la relecture de la 1re écriture.
  const firstConfirm = fake.log.indexOf('GET elements');
  const secondBoardRead = fake.log.indexOf('GET boards', fake.log.indexOf('GET boards') + 1);
  assert.ok(firstConfirm < secondBoardRead);
});

test('export : un sous-board illisible est cité et listé dans skipped, sans faire échouer l’export', async () => {
  const fake = new FakeMilanote();
  const sub = '1Xe000TESTCL20';
  fake.add({ id: sub, elementType: 'BOARD', location: { parentId: BOARD, section: 'CANVAS', position: { x: 0, y: 0 } }, content: { title: 'Sous' } });
  fake.failingBoards.add(sub);
  const res = await makeMilanote(fake).exportBoardMarkdown({ boardId: BOARD, depth: 1 });
  assert.deepEqual(res.boardsExported, [BOARD], 'ni le sous-board illisible, ni le board parent (ancêtre)');
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0]!.boardId, sub);
  assert.match(res.markdown, /Sous/);
  fake.failingBoards.add(BOARD);
  await assert.rejects(makeMilanote(fake).exportBoardMarkdown({ boardId: BOARD, depth: 0 }), /404/);
});

test('trash_elements refuse une carte d’un autre board', async () => {
  const fake = new FakeMilanote();
  const foreign = '1Xe000TESTCL30';
  fake.add({ id: foreign, elementType: 'CARD', location: { parentId: OTHER_BOARD, section: 'CANVAS' }, content: {} });
  await assert.rejects(makeMilanote(fake).trashElements({ boardId: BOARD, elementIds: [foreign], dryRun: false }), /n'est pas une carte du board/);
  assert.equal(fake.emitted.length, 0);
});

test('trash_elements : carte mise à la corbeille et confirmée', async () => {
  const fake = new FakeMilanote();
  const card = '1Xe000TESTCL31';
  fake.add({ id: card, elementType: 'CARD', location: { parentId: BOARD, section: 'CANVAS', position: { x: 1, y: 1 } }, content: {} });
  const res = await makeMilanote(fake).trashElements({ boardId: BOARD, elementIds: [card], dryRun: false });
  assert.deepEqual(res.trashed, [card]);
  assert.equal(fake.els.get(card)?.location?.section, 'TRASH');
});

test('edit_note append : texte ajouté, versions transmises comme le client web', async () => {
  const fake = new FakeMilanote();
  const card = '1Xe000TESTCL40';
  fake.add({
    id: card,
    elementType: 'CARD',
    location: { parentId: BOARD, section: 'CANVAS', position: { x: 1, y: 1 } },
    content: { textContent: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Avant' }] }] } },
    meta: { versionId: 'abc-7' },
  });
  const res = await makeMilanote(fake).editNote({ boardId: BOARD, elementId: card, body: 'Après', mode: 'append', dryRun: false });
  assert.equal(res.element?.text, 'Avant\nAprès');
  const update = (fake.emitted[0]!.updates as { meta: { modifiedVersionId: string; versionId: string } }[])[0]!;
  assert.equal(update.meta.modifiedVersionId, 'abc-7');
  assert.match(update.meta.versionId, /-\d+$/);
});

test('edit_note refuse ce qui n’est pas une note', async () => {
  const fake = new FakeMilanote();
  await assert.rejects(makeMilanote(fake).editNote({ boardId: BOARD, elementId: BOARD, body: 'x', mode: 'replace', dryRun: false }), MilanoteError);
});

test('set_tasks_done : tâche cochée et confirmée ; une tâche d’un autre board est refusée', async () => {
  const fake = new FakeMilanote();
  const list = '1Xe000TESTCL50';
  const task = '1Xe000TESTCL51';
  fake.add({ id: list, elementType: 'TASK_LIST', location: { parentId: BOARD, section: 'CANVAS', position: { x: 1, y: 1 } }, content: { title: 'L' } });
  fake.add({ id: task, elementType: 'TASK', location: { parentId: list, section: 'INBOX', position: { index: 0, score: 0 } }, content: { isComplete: false } });
  const mn = makeMilanote(fake);
  const res = await mn.setTasksDone({ boardId: BOARD, taskIds: [task], done: true, dryRun: false });
  assert.deepEqual(res.tasks, [{ id: task, done: true }]);
  assert.equal(fake.els.get(task)?.content.isComplete, true);
  await assert.rejects(mn.setTasksDone({ boardId: OTHER_BOARD, taskIds: [task], done: true, dryRun: false }), /n'est pas une tâche/);
});

test('get_board accepte l’URL du board ; renvoie les tâches d’une liste avec leur état', async () => {
  const fake = new FakeMilanote();
  const list = '1Xe000TESTCL60';
  fake.add({ id: list, elementType: 'TASK_LIST', location: { parentId: BOARD, section: 'CANVAS', position: { x: 1, y: 1 } }, content: { title: 'L' } });
  fake.add({ id: '1Xe000TESTCL61', elementType: 'TASK', location: { parentId: list, section: 'INBOX', position: { index: 1 } }, content: { isComplete: true, completed: false, textContent: 'deux' } });
  fake.add({ id: '1Xe000TESTCL62', elementType: 'TASK', location: { parentId: list, section: 'INBOX', position: { index: 0 } }, content: { isComplete: false, completed: true, textContent: 'un' } });
  const res = await makeMilanote(fake).getBoard(`https://app.milanote.com/${BOARD}/mcp-test?p=abc`);
  const l = res.elements.find((e) => e.id === list);
  assert.deepEqual(l?.tasks, [
    { id: '1Xe000TESTCL62', text: 'un', done: false },
    { id: '1Xe000TESTCL61', text: 'deux', done: true },
  ]);
  await assert.rejects(makeMilanote(fake).getBoard('https://evil.example/1Xe000TESTCL02'), /invalide/);
});

test('session_status sans session : pas d’exception, message avec la marche à suivre', async () => {
  const mn = new Milanote(SETTINGS, {
    current: () => {
      throw new MilanoteError('Aucune session Milanote : lancer « npm run session »');
    },
    invalidate: () => {},
  });
  const s = await mn.sessionStatus({ check: true });
  assert.equal(s.configured, false);
  assert.match(s.error ?? '', /npm run session/);
});

test('export : output_path .md seulement, sans écrasement sauf overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milanote-mcp-test-'));
  try {
    await assert.rejects(writeMarkdownFile(path.join(dir, 'a.txt'), 'x', false), /\.md/);
    const f = path.join(dir, 'sous', 'a.md');
    await writeMarkdownFile(f, 'un', false);
    await assert.rejects(writeMarkdownFile(f, 'deux', false), /existe déjà/);
    await writeMarkdownFile(f, 'deux', true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'deux');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('corbeille : list_trash ne garde que ce board ; restore_elements remet la carte à son emplacement d’origine', async () => {
  const fake = new FakeMilanote();
  const card = '1Xe000TESTCL70';
  const other = '1Xe000TESTCL71';
  const at = { parentId: BOARD, section: 'CANVAS', position: { x: 25, y: 40, score: 65536 } };
  fake.add({ id: card, elementType: 'CARD', location: at, content: { textContent: 'à restaurer' } });
  fake.add({ id: other, elementType: 'CARD', location: { parentId: OTHER_BOARD, section: 'CANVAS', position: { x: 1, y: 1 } }, content: {} });
  const mn = makeMilanote(fake);
  await mn.trashElements({ boardId: BOARD, elementIds: [card], dryRun: false });
  await mn.trashElements({ boardId: OTHER_BOARD, elementIds: [other], dryRun: false });
  const list = await mn.listTrash({ boardId: BOARD, limit: 10 });
  assert.deepEqual(list.items.map((i) => i.id), [card]);
  assert.equal(list.items[0]!.restoreTo, BOARD);
  const res = await mn.restoreElements({ boardId: BOARD, elementIds: [card], dryRun: false });
  assert.deepEqual(res.restored, [{ id: card, parentId: BOARD, section: 'CANVAS' }]);
  assert.deepEqual(fake.els.get(card)?.location, at);
  const move = fake.emitted.at(-1)!;
  assert.equal(move.moveOperation, 'DROP');
  await assert.rejects(mn.restoreElements({ boardId: BOARD, elementIds: [other], dryRun: false }), /pas dans la corbeille/);
});

test('move_elements : colonne (fin de liste), autre board (« À trier »), retour sur le canvas', async () => {
  const fake = new FakeMilanote();
  const col = '1Xe000TESTCL80';
  const inCol = '1Xe000TESTCL81';
  const card = '1Xe000TESTCL82';
  fake.add({ id: col, elementType: 'COLUMN', location: { parentId: BOARD, section: 'CANVAS', position: { x: 60, y: 0 } }, content: { title: 'C' } });
  fake.add({ id: inCol, elementType: 'CARD', location: { parentId: col, section: 'INBOX', position: { index: 0, score: 0 } }, content: {} });
  fake.add({ id: card, elementType: 'CARD', location: { parentId: BOARD, section: 'CANVAS', position: { x: 1, y: 1 } }, content: {} });
  const mn = makeMilanote(fake);

  await mn.moveElements({ boardId: BOARD, elementIds: [card], columnId: col, dryRun: false });
  assert.deepEqual(fake.els.get(card)?.location, { parentId: col, section: 'INBOX', position: { index: 1, score: 65536 } });

  await mn.moveElements({ boardId: BOARD, elementIds: [card], targetBoardId: OTHER_BOARD, dryRun: false });
  assert.equal(fake.els.get(card)?.location?.parentId, OTHER_BOARD);
  assert.equal(fake.els.get(card)?.location?.section, 'INBOX');
  assert.deepEqual(fake.emitted.at(-1)!.channels, [OTHER_BOARD, BOARD]);

  await mn.moveElements({ boardId: BOARD, elementIds: [inCol], dryRun: false });
  assert.equal(fake.els.get(inCol)?.location?.section, 'CANVAS');
  await assert.rejects(mn.moveElements({ boardId: BOARD, elementIds: [inCol], dryRun: false }), /déjà sur le canvas/);
  await assert.rejects(mn.moveElements({ boardId: BOARD, elementIds: [inCol], columnId: card, dryRun: false }), /pas une colonne/);
});

test('create_column : colonne titrée, confirmée', async () => {
  const fake = new FakeMilanote();
  const res = await makeMilanote(fake).createColumn({ boardId: BOARD, title: 'À faire', dryRun: false });
  assert.equal(res.element?.type, 'COLUMN');
  assert.equal(res.element?.title, 'À faire');
  assert.deepEqual(fake.emitted.map((a) => a.type), ['ELEMENT_CREATE', 'ELEMENT_UPDATE']);
});
