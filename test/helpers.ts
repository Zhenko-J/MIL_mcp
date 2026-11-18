import fs from 'node:fs';
import path from 'node:path';

/** Charge une fixture anonymisée de test/fixtures (chemin relatif à la racine du dépôt). */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', name), 'utf8')) as T;
}

/** Ids anonymisés stables (voir l'anonymiseur) : accueil et board de test. */
export const ROOT_ID = '1Xe000TESTCL01';
export const TEST_BOARD_ID = '1Xe000TESTCL02';
