import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerAddImage(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'add_image',
    {
      title: 'Ajouter une image',
      description:
        "Téléverse un fichier image local (PNG, JPEG, GIF, WebP, 25 Mo max) et le pose sur le canvas d'un board Milanote. " +
        'Séquence : création de la carte, URL signée, envoi S3, mise à jour des métadonnées, relecture. ' +
        'Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; dry_run=true lit le fichier et renvoie les actions sans ' +
        'rien envoyer. Pas de nouvelle tentative automatique.',
      inputSchema: {
        board_id: z.string().describe('Id du board cible (14 caractères) ou son URL app.milanote.com'),
        file_path: z.string().describe('Chemin local absolu du fichier image'),
        caption: z.string().max(2000).optional().describe('Légende affichée sous l’image (texte brut)'),
        width: z.number().int().min(8).max(120).default(34).describe('Largeur de la carte en unités de grille Milanote (1 unité = 10 px) ; 34 = largeur d’une note standard'),
        dry_run: z.boolean().default(false).describe('true : construit les actions sans les envoyer'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ board_id, file_path, caption, width, dry_run }) =>
      run(async () => {
        const res = await mn.addImage({ boardId: board_id, filePath: file_path, caption, width, dryRun: dry_run });
        return ok(
          res.dryRun ? `dry_run : image ${res.elementId} non envoyée.` : `Image ${res.elementId} téléversée et confirmée sur ${res.boardId}.`,
          res,
        );
      }),
  );
}
