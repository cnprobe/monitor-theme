import test from 'node:test';
import assert from 'node:assert/strict';

import { Probe } from '../server/probe.js';
import { Game } from '../server/game.js';

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

test('managed snake_case theme settings update the authoritative server preference', () => {
  const game = Object.create(Game.prototype);
  game.maxProbeChicks = 20;
  game.probeLimit = 10;
  game.probeOrder = 'random';
  game.selectedProbeKeys = { chick: [], web: [] };
  game.lastProbeList = [];
  game.lastSiteList = [];
  game.setProbePreferences({ probe_limit: 3, probe_order: '按名称' });
  assert.equal(game.probeLimit, 3);
  assert.equal(game.probeOrder, 'name');
});

test('theme probe limit randomly selects a stable capped subset', () => {
  const game = Object.create(Game.prototype);
  game.maxProbeChicks = 20;
  game.probeLimit = 10;
  game.probeOrder = 'random';
  game.selectedProbeKeys = { chick: [], web: [] };
  const source = Array.from({ length: 25 }, (_, i) => ({ key: `node-${i}`, name: `Node ${i}` }));
  const first = game.selectProbeItems('chick', source, 20).map(item => item.key);
  const second = game.selectProbeItems('chick', source, 20).map(item => item.key);
  assert.equal(first.length, 10);
  assert.deepEqual(first, second);
  game.probeLimit = 3;
  assert.equal(game.selectProbeItems('chick', source, 20).length, 3);
  game.probeOrder = 'name';
  const sorted = game.selectProbeItems('chick', source, 20).map(item => item.name);
  const expected = source.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).slice(0, 3).map(item => item.name);
  assert.deepEqual(sorted, expected);
});
