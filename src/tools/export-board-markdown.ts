import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MilanoteError } from '../client/errors.js';
import type { Milanote } from '../milanote.js';
import { ok, run } from './result.js';

/**
 * Écriture locale du Markdown : extension .md obligatoire, et jamais d'écrasement d'un fichier existant sans
 * `overwrite: true` (l'outil lit Milanote ; il ne doit pas pouvoir remplacer n'importe quel fichier du poste).
 */
export async function writeMarkdownFile(outputPath: string, markdown: string, overwrite: boolean): Promise<string> {
  const target = path.resolve(outputPath);
  if (path.extname(target).toLowerCase() !== '.md') throw new MilanoteError(`output_path doit finir par .md : ${target}`);
  const exists = await fs.stat(target).catch(() => undefined);
  if (exists?.isDirectory()) throw new MilanoteError(`output_path est un dossier : ${target}`);
  if (exists && !overwrite) throw new MilanoteError(`Le fichier existe déjà : ${target} (overwrite: true pour le remplacer).`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, markdown, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  return target;
}

export function registerExportBoardMarkdown(server: McpServer, mn: Milanote): void {
  server.registerTool(
    'export_board_markdown',
    {
      title: 'Exporter un board en Markdown',
      description:
        "Rend le contenu d'un board Milanote en Markdown (notes avec titres/listes/gras, liens, images, fichiers, " +
        'colonnes, tâches cochées ou non, tableaux, sous-boards). `depth` > 0 inclut les sous-boards (un appel REST par ' +
        'board, 25 boards max ; un sous-board illisible est cité et listé dans `skipped`). Ne modifie rien dans Milanote ; ' +
        '`output_path` écrit en plus un fichier .md local (refusé s’il existe déjà, sauf overwrite=true).',
      inputSchema: {
        board_id: z.string().describe('Id du board à exporter ou son URL app.milanote.com'),
        depth: z.number().int().min(0).max(3).default(0).describe('Profondeur des sous-boards inclus (0 = seulement cités)'),
        output_path: z.string().optional().describe('Chemin local du fichier .md à écrire (facultatif)'),
        overwrite: z.boolean().default(false).describe('true : remplace output_path s’il existe déjà'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ board_id, depth, output_path, overwrite }) =>
      run(async () => {
        const res = await mn.exportBoardMarkdown({ boardId: board_id, depth });
        const written = output_path ? await writeMarkdownFile(output_path, res.markdown, overwrite) : undefined;
        const skipped = res.skipped.length ? `, ${res.skipped.length} sous-board(s) illisible(s)` : '';
        return ok(
          `Board ${res.boardId} exporté (${res.boardsExported.length} board(s)${skipped}, ${res.markdown.length} caractères${written ? `, écrit dans ${written}` : ''}).`,
          { ...res, outputPath: written },
        );
      }),
  );
}
