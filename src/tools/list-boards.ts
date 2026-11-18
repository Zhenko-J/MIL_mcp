import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerListBoards(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'list_boards',
    {
      title: 'Lister les boards Milanote',
      description:
        "Liste les boards (et alias de boards) contenus dans un board Milanote, y compris ceux rangés dans des colonnes. " +
        "Sans board_id, part du board d'accueil. Renvoie id, titre, board cible (pour un alias) et colonne.",
      inputSchema: { board_id: z.string().optional().describe("Id ou URL du board parent ; par défaut le board d'accueil") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ board_id }) =>
      run(async () => {
        const res = await mn.listBoards(board_id);
        return ok(`${res.boards.length} board(s) dans ${res.boardId}.`, res);
      }),
  );
}
