import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerMoveElements(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'move_elements',
    {
      title: 'Déplacer des cartes',
      description:
        "Déplace des cartes d'un board Milanote, comme un glisser-déposer : `column_id` les range à la fin d'une colonne " +
        "(du board, ou de target_board_id) ; `target_board_id` seul les envoie dans la section « À trier » d'un autre " +
        'board ; sans l’un ni l’autre, des cartes rangées en colonne reviennent sur le canvas. Un sous-board se déplace ' +
        'avec tout son contenu. Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; dry_run=true renvoie l’action ' +
        'sans rien envoyer. Pas de nouvelle tentative automatique.',
      inputSchema: {
        board_id: z.string().describe('Id (ou URL) du board qui contient les cartes'),
        element_ids: z.array(z.string()).min(1).max(100).describe('Ids des cartes (champ id de get_board)'),
        target_board_id: z.string().optional().describe('Board de destination (id ou URL) ; par défaut le même board'),
        column_id: z.string().optional().describe('Colonne de destination (id de get_board, type COLUMN)'),
        dry_run: z.boolean().default(false).describe("true : construit l'action sans l'envoyer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ board_id, element_ids, target_board_id, column_id, dry_run }) =>
      run(async () => {
        const res = await mn.moveElements({ boardId: board_id, elementIds: element_ids, targetBoardId: target_board_id, columnId: column_id, dryRun: dry_run });
        const where = column_id ? `colonne ${column_id}` : res.targetBoardId !== res.boardId ? `« À trier » de ${res.targetBoardId}` : 'canvas';
        return ok(res.dryRun ? `dry_run : ${element_ids.length} carte(s) non déplacée(s).` : `${res.moved.length} carte(s) déplacée(s) vers ${where} et confirmée(s).`, res);
      }),
  );
}

export function registerCreateColumn(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'create_column',
    {
      title: 'Créer une colonne',
      description:
        "Crée une colonne sur le canvas d'un board Milanote, avec un titre facultatif ; y ranger ensuite des cartes avec " +
        'move_elements (column_id). Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; dry_run=true renvoie les ' +
        'actions sans rien envoyer. Pas de nouvelle tentative automatique.',
      inputSchema: {
        board_id: z.string().describe('Id (ou URL) du board'),
        title: z.string().max(200).optional().describe('Titre de la colonne'),
        dry_run: z.boolean().default(false).describe('true : construit les actions sans les envoyer'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ board_id, title, dry_run }) =>
      run(async () => {
        const res = await mn.createColumn({ boardId: board_id, title, dryRun: dry_run });
        return ok(res.dryRun ? `dry_run : colonne ${res.elementId} non créée.` : `Colonne ${res.elementId} créée et confirmée sur ${res.boardId}.`, res);
      }),
  );
}
