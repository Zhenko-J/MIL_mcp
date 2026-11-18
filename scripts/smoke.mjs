// Test de fumée de bout en bout : lance le serveur en stdio et appelle les outils comme le ferait Claude.
// Usage : node scripts/smoke.mjs <board_id_de_test> [--write]
// Session : celle de « npm run session » (ou MILANOTE_SESSION_TOKEN).
// --write ajoute MILANOTE_ENABLE_WRITE=1 et, sur le board de test uniquement : note (complétée par edit_note), lien, image,
// liste de tâches (cochée puis décochée), sous-board, colonne ; déplace le lien dans la colonne puis sur le canvas,
// envoie la note dans le sous-board, met l'image à la corbeille puis la restaure ; enfin tout part à la corbeille.
// N'affiche que des comptes pour list_boards (les titres de l'accueil peuvent être confidentiels).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** PNG 64x64 valide (damier bleu/blanc), généré sans dépendance. */
function makePng() {
  const w = 64, h = 64, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 4 + 1) + 1 + x * 4, on = ((x >> 3) + (y >> 3)) % 2 === 0;
      raw[i] = on ? 30 : 255; raw[i + 1] = on ? 90 : 255; raw[i + 2] = on ? 200 : 255; raw[i + 3] = 255;
    }
  }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const [, , testBoardId, flag] = process.argv;
if (!testBoardId) throw new Error('Usage : node scripts/smoke.mjs <board_id_de_test> [--write]');
const write = flag === '--write';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/src/server.js'],
  env: { ...process.env, MILANOTE_ENABLE_WRITE: write ? '1' : '0' },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} : ${r.content?.[0]?.text}`);
  return r.structuredContent;
};

const tools = await client.listTools();
console.log(`outils (${tools.tools.length}) :`, tools.tools.map((t) => t.name).join(', '));

const st = await call('session_status', { check: true });
console.log(`session_status : source ${st.source}, ${st.daysLeft ?? '?'} j restants, acceptée=${st.valid}, rafraîchissement ${st.autoRefresh}`);
if (!st.valid) throw new Error(`session refusée : ${st.error}`);

const lb = await call('list_boards', {});
console.log(`list_boards (accueil) : ${lb.boards.length} boards, dont ${lb.boards.filter((b) => b.isAlias).length} alias`);

const gb = await call('get_board', { board_id: `https://app.milanote.com/${testBoardId}/test` });
console.log(`get_board (par URL) : « ${gb.board?.title} », ${gb.elements.length} éléments :`);
for (const e of gb.elements) console.log(`  - ${e.type} ${e.section} ${e.text ?? e.url ?? e.imageUrl ?? e.title ?? ''}`.replace(/\n/g, ' / '));

const dn = await call('add_note', { board_id: testBoardId, title: 'Smoke', body: 'dry run', dry_run: true });
console.log(`add_note dry_run : ${dn.dryRun}, ${dn.actions.length} action, type ${dn.actions[0].type}/${dn.actions[0].elementType}`);
const dl = await call('add_link', { board_id: testBoardId, url: 'https://example.com/', dry_run: true });
console.log(`add_link dry_run : ${dl.dryRun}, ${dl.actions.length} actions`);
const ex = await call('export_board_markdown', { board_id: testBoardId, depth: 1 });
console.log(`export_board_markdown : ${ex.boardsExported.length} board(s), ${ex.skipped.length} ignoré(s), ${ex.markdown.length} caractères, première ligne « ${ex.markdown.split('\n')[0]} »`);
const sb = await call('search_boards', { query: 'MCP', limit: 5 });
console.log(`search_boards : ${sb.total} board(s) pour « MCP », premier : ${sb.hits[0]?.title ?? '(aucun)'} avec ${sb.hits[0]?.matches.length ?? 0} extrait(s)`);
const dt = await call('add_task', { board_id: testBoardId, title: 'Smoke', tasks: ['a', 'b'], dry_run: true });
console.log(`add_task dry_run : ${dt.actions.length} actions (${dt.actions.map((a) => a.elementType).join(',')})`);
const db = await call('create_board', { parent_board_id: testBoardId, title: 'Smoke', dry_run: true });
console.log(`create_board dry_run : ${db.actions.length} actions (${db.actions.map((a) => a.type).join(',')})`);
const pngPath = path.join(os.tmpdir(), 'milanote-mcp-smoke.png');
fs.writeFileSync(pngPath, makePng());
const di = await call('add_image', { board_id: testBoardId, file_path: pngPath, caption: 'Image de test', dry_run: true });
console.log(`add_image dry_run : ${di.dryRun}, ${di.actions.length} actions, ${JSON.stringify(di.actions[2].updates[0].changes.image)}`);

if (!write) {
  const r = await client.callTool({ name: 'add_note', arguments: { board_id: testBoardId, body: 'x' } });
  console.log(`add_note sans MILANOTE_ENABLE_WRITE : refusé=${!!r.isError}`);
} else {
  const created = [];
  try {
    const n = await call('add_note', {
      board_id: testBoardId,
      title: 'Note créée par milanote-mcp',
      body: 'Ligne **gras** et [lien](https://example.com)\n- puce 1\n- puce 2',
    });
    created.push(n.elementId);
    console.log(`add_note : ${n.elementId} confirmé → ${JSON.stringify(n.element?.text)}`);
    const en = await call('edit_note', { board_id: testBoardId, element_id: n.elementId, body: 'Ligne ajoutée par edit_note', mode: 'append' });
    console.log(`edit_note (append) : confirmé → ${JSON.stringify(en.element?.text)}`);
    const l = await call('add_link', { board_id: testBoardId, url: 'https://example.com/' });
    created.push(l.elementId);
    console.log(`add_link : ${l.elementId} confirmé → ${l.element?.url} « ${l.element?.title} »`);
    const i = await call('add_image', { board_id: testBoardId, file_path: pngPath, caption: 'Image envoyée par milanote-mcp', width: 34 });
    created.push(i.elementId);
    console.log(`add_image : ${i.elementId} confirmé → ${i.element?.imageUrl ? 'URL ok' : 'sans URL'} « ${i.element?.caption} »`);
    const t = await call('add_task', { board_id: testBoardId, title: 'Tâches milanote-mcp', tasks: ['Première tâche', 'Deuxième tâche'] });
    created.push(t.elementId);
    console.log(`add_task : liste ${t.elementId} confirmée, ${t.taskIds.length} tâche(s)`);
    const done = await call('set_tasks_done', { board_id: testBoardId, task_ids: [t.taskIds[0]], done: true });
    console.log(`set_tasks_done (cocher) : ${JSON.stringify(done.tasks)}`);
    const gl = await call('get_board', { board_id: testBoardId });
    console.log(`get_board : tâches lues → ${JSON.stringify(gl.elements.find((e) => e.id === t.elementId)?.tasks?.map((x) => x.done))}`);
    const undone = await call('set_tasks_done', { board_id: testBoardId, task_ids: [t.taskIds[0]], done: false });
    console.log(`set_tasks_done (décocher) : ${JSON.stringify(undone.tasks)}`);
    const b = await call('create_board', { parent_board_id: testBoardId, title: 'Smoke sub-board', color: '#7db4c0' });
    created.push(b.elementId);
    console.log(`create_board : ${b.elementId} confirmé → « ${b.element?.title} »`);
    const col = await call('create_column', { board_id: testBoardId, title: 'Colonne smoke' });
    created.push(col.elementId);
    console.log(`create_column : ${col.elementId} confirmée → « ${col.element?.title} »`);
    const mc = await call('move_elements', { board_id: testBoardId, element_ids: [l.elementId], column_id: col.elementId });
    console.log(`move_elements (dans la colonne) : ${JSON.stringify(mc.moved)}`);
    const mk = await call('move_elements', { board_id: testBoardId, element_ids: [l.elementId] });
    console.log(`move_elements (retour au canvas) : ${JSON.stringify(mk.moved)}`);
    const mb = await call('move_elements', { board_id: testBoardId, element_ids: [n.elementId], target_board_id: b.elementId });
    created.splice(created.indexOf(n.elementId), 1); // la note suit désormais le sous-board
    console.log(`move_elements (vers le sous-board) : ${JSON.stringify(mb.moved)}`);
    await call('trash_elements', { board_id: testBoardId, element_ids: [i.elementId] });
    const lt = await call('list_trash', { board_id: testBoardId, limit: 5 });
    console.log(`list_trash : ${lt.items.length} carte(s), image présente=${lt.items.some((x) => x.id === i.elementId)}, hasMore=${lt.hasMore}`);
    const rs = await call('restore_elements', { board_id: testBoardId, element_ids: [i.elementId] });
    console.log(`restore_elements : ${JSON.stringify(rs.restored)}`);
    const gb2 = await call('get_board', { board_id: testBoardId });
    console.log(`get_board après écritures : ${gb2.elements.length} éléments (${gb2.elements.map((e) => e.type).join(', ')})`);
  } finally {
    // Remise à vide : tout ce qui est encore sur le board de test part à la corbeille. Un échec ici est affiché sans
    // masquer l'erreur d'origine.
    const onBoard = new Set((await call('get_board', { board_id: testBoardId }).catch(() => ({ elements: [] }))).elements.map((e) => e.id));
    const left = created.filter((id) => onBoard.has(id));
    if (left.length) {
      try {
        const tr = await call('trash_elements', { board_id: testBoardId, element_ids: left });
        console.log(`trash_elements (remise à vide du board de test) : ${tr.trashed.length}/${left.length} à la corbeille`);
      } catch (err) {
        console.error(`remise à vide incomplète : ${err.message}`);
      }
    }
  }
}
fs.rmSync(pngPath, { force: true });
await client.close();
