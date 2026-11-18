import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerAddNote(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'add_note',
    {
      title: 'Ajouter une note',
      description:
        "Ajoute une carte note sur le canvas d'un board Milanote. Le titre devient le premier paragraphe. Le texte est lu " +
        'en Markdown ligne à ligne : `# titre`, `- puce`, `1. numéro`, `> citation`, **gras**, *italique*, `code`, ' +
        '[texte](url) ; une ligne = un bloc. Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; dry_run=true renvoie ' +
        'l’action sans rien envoyer. Pas de nouvelle tentative automatique. Pour modifier une note existante : edit_note.',
      inputSchema: {
        board_id: z.string().describe('Id du board cible (14 caractères) ou son URL app.milanote.com'),
        title: z.string().max(500).optional().describe('Titre de la note (premier paragraphe)'),
        body: z.string().max(20_000).describe('Texte de la note en Markdown ; une ligne = un bloc'),
        dry_run: z.boolean().default(false).describe("true : construit l'action sans l'envoyer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ board_id, title, body, dry_run }) =>
      run(async () => {
        const res = await mn.addNote({ boardId: board_id, title, body, dryRun: dry_run });
        return ok(
          res.dryRun ? `dry_run : note ${res.elementId} non envoyée.` : `Note ${res.elementId} créée et confirmée sur ${res.boardId}.`,
          res,
        );
      }),
  );
}
