import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

export function registerSearchBoards(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'search_boards',
    {
      title: 'Rechercher dans Milanote',
      description:
        'Recherche plein texte côté serveur dans tous les boards du compte (même appel que la loupe du client web). ' +
        'Renvoie les boards qui contiennent le texte, avec leur chemin, et pour chacun les cartes qui matchent avec un ' +
        'extrait. Lecture seule.',
      inputSchema: {
        query: z.string().min(1).max(200).describe('Texte recherché'),
        limit: z.number().int().min(1).max(100).default(25).describe('Nombre maximal de boards renvoyés'),
        sort: z.enum(['viewed', 'modified']).default('viewed').describe('Ordre : derniers consultés (défaut) ou derniers modifiés'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ query, limit, sort }) =>
      run(async () => {
        const res = await mn.searchBoards({ query, limit, sort });
        return ok(`${res.total} board(s) pour « ${query} »${res.hits.length < res.total ? ` (${res.hits.length} renvoyés)` : ''}.`, res);
      }),
  );
}
