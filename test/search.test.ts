import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSearch } from '../src/search.js';
import { fixture } from './helpers.js';

test('parseSearch : boards trouvés, chemin, extraits sans balises [hit]', () => {
  const { total, hits } = parseSearch(fixture('rest-boards-search.json'));
  assert.equal(total, 2);
  assert.equal(hits.length, 1);
  const [h] = hits;
  assert.equal(h?.boardId, '1Xe000TESTCL02');
  assert.equal(h?.title, 'MCP-TEST');
  assert.deepEqual(h?.path, ['<title>']);
  assert.deepEqual(h?.matches, [{ elementId: '1Xe000TESTCL02', type: 'BOARD', excerpts: ['« MCP »-TEST'] }]);
});

test('parseSearch : réponse vide tolérée', () => {
  assert.deepEqual(parseSearch({ offset: 0, total: 0, size: 0, results: [] }), { total: 0, hits: [] });
});
