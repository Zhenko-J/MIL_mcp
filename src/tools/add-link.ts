import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerAddLink(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'add_link',
    {
      title: 'Ajouter une carte lien',
      description:
        "Ajoute une carte lien sur le canvas d'un board Milanote. Milanote récupère l'aperçu " +
        "(titre, description) ; `title` le remplace. Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; " +
        "dry_run=true renvoie les actions sans rien envoyer. Pas de nouvelle tentative automatique.",
      inputSchema: {
        board_id: z.string().describe('Id du board cible (14 caractères) ou son URL app.milanote.com'),
        url: z.url().describe('URL du lien'),
        title: z.string().max(500).optional().describe("Titre affiché, à la place de celui de l'aperçu"),
        dry_run: z.boolean().default(false).describe("true : construit les actions sans les envoyer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ board_id, url, title, dry_run }) =>
      run(async () => {
        const res = await mn.addLink({ boardId: board_id, url, title, dryRun: dry_run });
        return ok(
          res.dryRun ? `dry_run : lien ${res.elementId} non envoyé.` : `Lien ${res.elementId} créé et confirmé sur ${res.boardId}.`,
          res,
        );
      }),
  );
}
