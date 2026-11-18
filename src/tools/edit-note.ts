import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerEditNote(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'edit_note',
    {
      title: 'Modifier une note',
      description:
        "Remplace (mode replace) ou complète à la fin (mode append) le texte d'une note existante d'un board Milanote. " +
        'Même Markdown ligne à ligne que add_note. Le texte remplacé n’est pas récupérable par le serveur : lire la note ' +
        '(get_board) avant un replace. Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; dry_run=true renvoie ' +
        'l’action sans rien envoyer. Pas de nouvelle tentative automatique.',
      inputSchema: {
        board_id: z.string().describe('Id (ou URL) du board qui contient la note'),
        element_id: z.string().describe('Id de la note (champ id de get_board)'),
        title: z.string().max(500).optional().describe('Titre (premier paragraphe du texte ajouté ou du nouveau texte)'),
        body: z.string().max(20_000).describe('Texte en Markdown ; une ligne = un bloc'),
        mode: z.enum(['replace', 'append']).default('append').describe('append (défaut) : ajoute à la fin ; replace : remplace tout le texte'),
        dry_run: z.boolean().default(false).describe("true : construit l'action sans l'envoyer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ board_id, element_id, title, body, mode, dry_run }) =>
      run(async () => {
        const res = await mn.editNote({ boardId: board_id, elementId: element_id, title, body, mode, dryRun: dry_run });
        return ok(
          res.dryRun ? `dry_run : note ${res.elementId} non modifiée.` : `Note ${res.elementId} modifiée (${mode}) et confirmée.`,
          res,
        );
      }),
  );
}
