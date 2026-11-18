import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdSource, isElementId, makeElementId, parseElementId } from '../src/client/ids.js';

// Ids de même forme que ceux du client web (horodatage et tick d'ids capturés, identifiant de client remplacé).
test('décode un id : horodatage, identifiant de client, tick', () => {
  const p = parseElementId('1XeP40TeStCld8');
  assert.equal(p.createdAt.toISOString(), '2026-10-08T14:25:40.000Z');
  assert.equal(p.clientId, 'TeStCl');
  assert.equal(p.tick, 814);
});

test('reproduit l’algorithme du client web (base62 des secondes + client + tick sur 2 caractères)', () => {
  assert.equal(makeElementId('TeStCl', 814, Date.parse('2026-10-08T14:25:40.500Z')), '1XeP40TeStCld8');
  assert.equal(makeElementId('TeStC2', 11, Date.parse('2026-10-08T14:29:05Z')), '1XeP7jTeStC20b');
});

test('IdSource produit des ids valides et distincts', () => {
  const src = new IdSource();
  const a = src.nextElementId();
  const b = src.nextElementId();
  assert.ok(isElementId(a) && isElementId(b));
  assert.notEqual(a, b);
  assert.equal(a.slice(6, 12), src.clientId);
});

test('isElementId rejette les formats invalides', () => {
  assert.equal(isElementId('abc'), false);
  assert.equal(isElementId('000000TeStCld8'), false); // horodatage antérieur à 2016
  assert.equal(isElementId('1XeP40TeStCld8'), true);
});
