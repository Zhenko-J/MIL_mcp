import { z } from 'zod';

// Schémas tolérants (passthrough) : l'API interne peut ajouter des champs sans préavis.
// Seuls les champs utilisés par le serveur sont typés. Voir docs/endpoints.md §3.

export const ELEMENT_TYPES = [
  'ALIAS', 'BOARD', 'COLUMN', 'CARD', 'LINK', 'LINE', 'IMAGE', 'FILE', 'COMMENT_THREAD', 'TASK_LIST',
  'TASK', 'CLONE', 'SKETCH', 'ANNOTATION', 'COLOR_SWATCH', 'DOCUMENT', 'TABLE', 'SKELETON', 'UNKNOWN',
] as const;

export const SECTIONS = ['CANVAS', 'INBOX', 'TRASH', 'DELETED', 'ATTACHED', 'QUICK_NOTES'] as const;

/**
 * Coordonnée de position. Certaines cartes anciennes la stockent en texte (`"x": "12"`) : un texte numérique
 * est converti, toute autre valeur (texte vide, null, objet) est ignorée au lieu de faire échouer tout le board.
 */
const Coordinate = z.preprocess((v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}, z.number().optional());

export const PositionSchema = z
  .object({ x: Coordinate, y: Coordinate, score: Coordinate, index: Coordinate })
  .passthrough();

export const LocationSchema = z
  .object({
    parentId: z.string().optional(),
    section: z.string().optional(),
    position: PositionSchema.optional(),
    rootBoard: z.boolean().optional(),
  })
  .passthrough();

/** Document ProseMirror (texte riche des notes et légendes). */
export interface PmNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PmNode[];
}

export const PmNodeSchema: z.ZodType<PmNode> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      text: z.string().optional(),
      attrs: z.record(z.string(), z.unknown()).optional(),
      marks: z.array(z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() }).passthrough()).optional(),
      content: z.array(PmNodeSchema).optional(),
    })
    .passthrough(),
);

export const ElementSchema = z
  .object({
    id: z.string(),
    elementType: z.string(),
    location: LocationSchema.optional(),
    content: z.record(z.string(), z.unknown()).default({}),
    meta: z
      .object({ createdTime: z.number().optional(), modifiedTime: z.number().optional(), creator: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Element = z.infer<typeof ElementSchema>;

export const ElementsResponseSchema = z
  .object({
    elements: z.record(z.string(), ElementSchema).default({}),
    errors: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type ElementsResponse = z.infer<typeof ElementsResponseSchema>;

export const LinkUnfurlSchema = z
  .object({
    link: z.object({ url: z.string(), title: z.string().optional() }).passthrough().optional(),
    provider: z.record(z.string(), z.unknown()).optional(),
    mediaType: z.string().optional(),
    image: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
  })
  .passthrough();
export type LinkUnfurl = z.infer<typeof LinkUnfurlSchema>;

/** Réponse de `POST /api/elements/attachments/presign` (upload d'image). */
export const PresignResponseSchema = z.object({ presignedUrl: z.url() }).passthrough();

/** `GET users/me` : seuls les identifiants utiles sont lus ; la réponse brute contient des données sensibles. */
export const UsersMeSchema = z.object({ user: z.object({ _id: z.string(), rootBoardId: z.string() }).passthrough() }).passthrough();
