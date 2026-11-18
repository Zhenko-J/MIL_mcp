import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MilanoteError } from '../client/errors.js';

/**
 * Réponse d'outil : résumé texte court + JSON compact (sans indentation : environ un tiers de jetons en moins),
 * et la même donnée en `structuredContent` pour les clients qui la lisent.
 */
export function ok(summary: string, data: object): CallToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data)}` }],
    structuredContent: data as Record<string, unknown>,
  };
}

/** Erreur lisible ; ne contient jamais le jeton (les messages d'erreur n'en incluent pas). */
export function fail(err: unknown): CallToolResult {
  const message = err instanceof MilanoteError ? err.message : `Erreur inattendue : ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}
