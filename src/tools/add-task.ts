import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerAddTask(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'add_task',
    {
      title: 'Ajouter une liste de tâches',
      description:
        "Crée une carte « liste de tâches » sur le canvas d'un board Milanote, avec un titre facultatif et une tâche par " +
        'entrée de `tasks` (texte brut, non cochées). Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; ' +
        'dry_run=true renvoie les actions sans rien envoyer. Pas de nouvelle tentative automatique.',
      inputSchema: {
        board_id: z.string().describe('Id du board cible (14 caractères) ou son URL app.milanote.com'),
        title: z.string().max(200).optional().describe('Titre de la liste (affiché si fourni)'),
        tasks: z.array(z.string().min(1).max(2000)).min(1).max(50).describe('Tâches, dans l’ordre'),
        dry_run: z.boolean().default(false).describe('true : construit les actions sans les envoyer'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ board_id, title, tasks, dry_run }) =>
      run(async () => {
        const res = await mn.addTaskList({ boardId: board_id, title, tasks, dryRun: dry_run });
        return ok(
          res.dryRun
            ? `dry_run : liste ${res.elementId} (${tasks.length} tâche(s)) non envoyée.`
            : `Liste ${res.elementId} créée et confirmée sur ${res.boardId} avec ${res.taskIds?.length ?? 0} tâche(s).`,
          res,
        );
      }),
  );
}
