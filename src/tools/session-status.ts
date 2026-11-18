import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerSessionStatus(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'session_status',
    {
      title: 'État de la session Milanote',
      description:
        'Indique si une session Milanote est disponible, sa source (fichier de « npm run session » ou variable), son ' +
        'expiration en jours, si les écritures sont activées et l’état du rafraîchissement automatique. `check=true` ' +
        'interroge Milanote pour vérifier que la session est acceptée. À appeler en premier quand un autre outil échoue ' +
        'pour une raison de session. Ne renvoie jamais le jeton.',
      inputSchema: { check: z.boolean().default(false).describe('true : vérifie la session auprès de Milanote (un appel REST)') },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ check }) =>
      run(async () => {
        const s = await mn.sessionStatus({ check });
        const summary = !s.configured
          ? 'Aucune session Milanote utilisable.'
          : `Session ${s.source}${s.daysLeft !== undefined ? `, expire dans ${s.daysLeft} j` : ''}${s.valid === undefined ? '' : s.valid ? ', acceptée par Milanote' : ', REFUSÉE par Milanote'} ; écritures ${s.writesEnabled ? 'activées' : 'désactivées'}.`;
        return ok(summary, s);
      }),
  );
}
