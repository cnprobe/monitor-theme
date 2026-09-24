import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServers, normalizeServices } from '../server/probe/adapters/nezha.js';
import { merge } from '../server/probe/adapters/komari.js';
import { finalizeNode, emptyNode } from '../server/probe/model.js';

test('Nezha normalization ignores malformed array entries', () => {
  assert.doesNotThrow(() => normalizeServers({ servers: [null, 1, {}, { id: 'ok' }] }));
  assert.doesNotThrow(() => normalizeServices({ data: { services: { bad: null, good: { delay: [1, 2] } } } }));
});

test('Komari ping fan-out is bounded and stack-safe', () => {
  const ping = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`p${i}`, i + 1]));
  const nodes = merge({ ok: { uuid: 'ok', name: 'ok' } }, { ok: { client: 'ok', ping, online: true } }, 'panel.example');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].ping, 1);
});

test('node metadata is size-bounded before entering the game model', () => {
  const node = finalizeNode({
    ...emptyNode('x'.repeat(1000), 'generic'),
    name: 'n\u202e'.repeat(1000),
    meta: { raw: 'z'.repeat(100000) },
  });
  assert.ok(node.key.length <= 256);
  assert.ok(node.name.length <= 120);
  assert.ok(!node.name.includes('\u202e'));
  assert.ok(JSON.stringify(node.meta).length < 1000);
});
