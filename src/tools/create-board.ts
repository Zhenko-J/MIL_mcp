import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerCreateBoard(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'create_board',
    {
      title: 'Créer un sous-board',
      description:
        "Crée un sous-board (titre, couleur facultative) sur le canvas d'un board Milanote, puis renvoie son id. " +
        'Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; dry_run=true renvoie les actions sans rien envoyer. ' +
        'Pas de nouvelle tentative automatique.',
      inputSchema: {
        parent_board_id: z.string().describe('Id du board parent ou son URL app.milanote.com'),
        title: z.string().min(1).max(200).describe('Titre du nouveau board'),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe('Couleur hexadécimale (#rrggbb) ; sinon Milanote choisit'),
        dry_run: z.boolean().default(false).describe('true : construit les actions sans les envoyer'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ parent_board_id, title, color, dry_run }) =>
      run(async () => {
        const res = await mn.createBoard({ parentBoardId: parent_board_id, title, color, dryRun: dry_run });
        return ok(
          res.dryRun ? `dry_run : board ${res.elementId} non créé.` : `Board « ${title} » créé (${res.elementId}) dans ${res.boardId}.`,
          res,
        );
      }),
  );
}
