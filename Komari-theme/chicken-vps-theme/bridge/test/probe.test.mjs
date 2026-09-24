import test from 'node:test';
import assert from 'node:assert/strict';

import { Probe } from '../server/probe.js';

test('siteList merges source sites and legacy probe.sites without duplicates', () => {
  const probe = new Probe([
    { url: 'https://source.example', site: true, key: 'source', name: 'Source' },
  ], 15000, [
    { url: 'https://legacy.example', key: 'legacy', name: 'Legacy' },
    { url: 'https://source.example', key: 'source', name: 'Duplicate' },
  ]);
  assert.deepEqual(probe.siteList().map(site => site.key), ['source', 'legacy']);
});

test('siteList accepts legacy string entries', () => {
  const probe = new Probe([], 15000, ['https://legacy.example']);
  assert.deepEqual(probe.siteList().map(site => site.url), ['https://legacy.example']);
});
