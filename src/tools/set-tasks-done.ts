import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerSetTasksDone(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'set_tasks_done',
    {
      title: 'Cocher ou décocher des tâches',
      description:
        "Coche (done=true) ou décoche (done=false) des tâches d'une liste de tâches d'un board Milanote. Les ids de " +
        'tâches sont dans le champ `tasks` des listes renvoyées par get_board. L’état obtenu est relu avant d’être ' +
        'annoncé. Écriture réelle seulement si MILANOTE_ENABLE_WRITE=1 ; dry_run=true renvoie les actions sans rien ' +
        'envoyer. Pas de nouvelle tentative automatique.',
      inputSchema: {
        board_id: z.string().describe('Id (ou URL) du board qui contient la liste'),
        task_ids: z.array(z.string()).min(1).max(50).describe('Ids des tâches'),
        done: z.boolean().default(true).describe('true : cocher ; false : décocher'),
        dry_run: z.boolean().default(false).describe('true : construit les actions sans les envoyer'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ board_id, task_ids, done, dry_run }) =>
      run(async () => {
        const res = await mn.setTasksDone({ boardId: board_id, taskIds: task_ids, done, dryRun: dry_run });
        return ok(
          res.dryRun
            ? `dry_run : ${task_ids.length} tâche(s) non modifiée(s).`
            : `${res.tasks.length} tâche(s) ${done ? 'cochée(s)' : 'décochée(s)'} et confirmée(s).`,
          res,
        );
      }),
  );
}
