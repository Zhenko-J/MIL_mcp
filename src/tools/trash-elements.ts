import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerTrashElements(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'trash_elements',
    {
      title: 'Mettre des cartes à la corbeille',
      description:
        "Déplace des cartes d'un board Milanote vers la corbeille de ce board (même geste que la touche Suppr dans le " +
        'client web : restaurable depuis la corbeille, pas de suppression définitive). Les cartes doivent appartenir au ' +
        'board indiqué. Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; dry_run=true renvoie l’action sans rien ' +
        'envoyer. Pas de nouvelle tentative automatique.',
      inputSchema: {
        board_id: z.string().describe('Id (ou URL) du board qui contient les cartes'),
        element_ids: z.array(z.string()).min(1).max(100).describe('Ids des cartes à mettre à la corbeille'),
        dry_run: z.boolean().default(false).describe("true : construit l'action sans l'envoyer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ board_id, element_ids, dry_run }) =>
      run(async () => {
        const res = await mn.trashElements({ boardId: board_id, elementIds: element_ids, dryRun: dry_run });
        return ok(
          res.dryRun
            ? `dry_run : ${element_ids.length} carte(s) non déplacée(s).`
            : `${res.trashed.length} carte(s) mise(s) à la corbeille de ${res.boardId}.`,
          res,
        );
      }),
  );
}
