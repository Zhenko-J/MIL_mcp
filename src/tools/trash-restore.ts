import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerListTrash(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'list_trash',
    {
      title: "Lister la corbeille d'un board",
      description:
        "Liste les cartes mises à la corbeille d'un board Milanote (les plus récentes d'abord), avec la date et " +
        "l'emplacement de restauration, pour retrouver les ids à passer à restore_elements. Lit la première page de la " +
        'corbeille du compte (`hasMore` indique s’il en existe de plus anciennes, non lues). Lecture seule.',
      inputSchema: {
        board_id: z.string().describe('Id (ou URL) du board'),
        limit: z.number().int().min(1).max(200).default(50).describe('Nombre maximal de cartes renvoyées'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ board_id, limit }) =>
      run(async () => {
        const res = await mn.listTrash({ boardId: board_id, limit });
        return ok(
          `${res.items.length} carte(s) dans la corbeille de ${res.boardId}${res.hasMore ? ' (corbeille du compte lue en partie : des cartes plus anciennes peuvent manquer)' : ''}.`,
          res,
        );
      }),
  );
}

export function registerRestoreElements(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'restore_elements',
    {
      title: 'Restaurer depuis la corbeille',
      description:
        "Remet des cartes de la corbeille d'un board à leur emplacement d'origine (canvas, colonne), ou sur le canvas si " +
        "cet emplacement n'existe plus. Ids donnés par list_trash ou par trash_elements. Écriture réelle seulement si " +
        'MILANOTE_ENABLE_WRITE=1 ; dry_run=true renvoie l’action sans rien envoyer. Pas de nouvelle tentative automatique.',
      inputSchema: {
        board_id: z.string().describe('Id (ou URL) du board dont la corbeille contient les cartes'),
        element_ids: z.array(z.string()).min(1).max(100).describe('Ids des cartes à restaurer'),
        dry_run: z.boolean().default(false).describe("true : construit l'action sans l'envoyer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ board_id, element_ids, dry_run }) =>
      run(async () => {
        const res = await mn.restoreElements({ boardId: board_id, elementIds: element_ids, dryRun: dry_run });
        return ok(res.dryRun ? `dry_run : ${element_ids.length} carte(s) non restaurée(s).` : `${res.restored.length} carte(s) restaurée(s) et confirmée(s).`, res);
      }),
  );
}
