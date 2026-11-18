import { z } from 'zod';

// `GET /api/boards/search?query=&offset=0&sort=viewed&locale=fr-FR` (capturé le 2026-10-09, fixture rest-boards-search.json).
// La recherche renvoie des boards ; `innerHits` liste les éléments du board qui contiennent le texte, extraits balisés [hit]…[/hit].

export const SearchResponseSchema = z
  .object({
    offset: z.number().optional(),
    total: z.number().optional(),
    size: z.number().optional(),
    results: z
      .array(
        z
          .object({
            _id: z.string(),
            board: z.object({ content: z.record(z.string(), z.unknown()).default({}) }).passthrough().optional(),
            modifiedTime: z.number().optional(),
            viewedTime: z.number().optional(),
            score: z.number().optional(),
            ancestors: z.array(z.object({ _id: z.string(), title: z.string().optional() }).passthrough()).default([]),
            innerHits: z
              .array(z.object({ _id: z.string(), elementType: z.string().optional(), content: z.array(z.string()).default([]) }).passthrough())
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export interface SearchHit {
  boardId: string;
  title: string;
  /** Chemin des boards parents, de l'accueil vers le board. */
  path: string[];
  score: number | undefined;
  modifiedTime: number | undefined;
  /** Éléments du board qui contiennent le texte : extraits avec le terme entre « » (balises [hit] retirées). */
  matches: { elementId: string; type: string | undefined; excerpts: string[] }[];
}

export function parseSearch(raw: unknown): { total: number; hits: SearchHit[] } {
  const r = SearchResponseSchema.parse(raw);
  const hits = r.results.map((x) => ({
    boardId: x._id,
    title: typeof x.board?.content.title === 'string' ? x.board.content.title : '',
    path: x.ancestors.map((a) => a.title ?? a._id),
    score: x.score,
    modifiedTime: x.modifiedTime,
    matches: x.innerHits.map((h) => ({
      elementId: h._id,
      type: h.elementType,
      excerpts: h.content.map((c) => c.replace(/\[hit\]/g, '« ').replace(/\[\/hit\]/g, ' »')),
    })),
  }));
  return { total: r.total ?? hits.length, hits };
}
