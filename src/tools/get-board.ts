import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerGetBoard(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'get_board',
    {
      title: "Lire le contenu d'un board Milanote",
      description:
        "Renvoie le contenu structuré d'un board : notes (texte), liens (url, titre), images (url), sous-boards, colonnes, " +
        "avec section (CANVAS, ou INBOX pour « À trier ») et position. Les éléments rangés dans une colonne portent le titre de la colonne.",
      inputSchema: { board_id: z.string().describe('Id du board (14 caractères) ou son URL app.milanote.com/<id>/…') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ board_id }) =>
      run(async () => {
        const res = await mn.getBoard(board_id);
        return ok(`Board « ${res.board?.title ?? board_id} » : ${res.elements.length} élément(s).`, res);
      }),
  );
}
