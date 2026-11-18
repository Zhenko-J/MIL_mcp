#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthProvider, loadSettings } from './config.js';
import { Milanote } from './milanote.js';
import { SessionRefresher } from './session-refresh.js';
import { registerAddImage } from './tools/add-image.js';
import { registerAddLink } from './tools/add-link.js';
import { registerAddNote } from './tools/add-note.js';
import { registerAddTask } from './tools/add-task.js';
import { registerCreateBoard } from './tools/create-board.js';
import { registerEditNote } from './tools/edit-note.js';
import { registerExportBoardMarkdown } from './tools/export-board-markdown.js';
import { registerGetBoard } from './tools/get-board.js';
import { registerListBoards } from './tools/list-boards.js';
import { registerCreateColumn, registerMoveElements } from './tools/move-elements.js';
import { registerListTrash, registerRestoreElements } from './tools/trash-restore.js';
import { registerSearchBoards } from './tools/search-boards.js';
import { registerSessionStatus } from './tools/session-status.js';
import { registerSetTasksDone } from './tools/set-tasks-done.js';
import { registerTrashElements } from './tools/trash-elements.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  // Seuls les réglages invalides empêchent le démarrage. Une session absente ou expirée n'est signalée qu'à l'appel
  // d'outil (message lisible par Claude), et elle est relue à chaque appel : pas de redémarrage après « npm run session ».
  const settings = loadSettings();
  const auth = new AuthProvider();
  const refresher = new SessionRefresher(settings.autoRefresh);
  const mn = new Milanote(settings, auth, { refresher });
  const server = new McpServer({ name: 'milanote-mcp', version: VERSION });

  registerSessionStatus(server, mn);
  registerListBoards(server, mn);
  registerGetBoard(server, mn);
  registerExportBoardMarkdown(server, mn);
  registerSearchBoards(server, mn);
  registerAddLink(server, mn);
  registerAddNote(server, mn);
  registerEditNote(server, mn);
  registerAddImage(server, mn);
  registerAddTask(server, mn);
  registerSetTasksDone(server, mn);
  registerCreateBoard(server, mn);
  registerCreateColumn(server, mn);
  registerMoveElements(server, mn);
  registerTrashElements(server, mn);
  registerListTrash(server, mn);
  registerRestoreElements(server, mn);

  await server.connect(new StdioServerTransport());
  refresher.maybeRefresh();
  // stderr uniquement (stdout = protocole MCP). Jamais le jeton.
  let session: string;
  try {
    const s = auth.current();
    session = `session ${s.source}${s.expires ? ` jusqu'au ${s.expires}` : ''}`;
  } catch (err) {
    session = `SANS SESSION (${err instanceof Error ? err.message : String(err)})`;
  }
  console.error(`milanote-mcp ${VERSION} prêt (écritures ${settings.enableWrite ? 'ACTIVÉES' : 'désactivées'}, ${session}).`);
}

main().catch((err: unknown) => {
  console.error(`milanote-mcp : ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
