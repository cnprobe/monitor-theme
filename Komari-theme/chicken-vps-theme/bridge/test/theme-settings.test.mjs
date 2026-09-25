import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../../komari-theme.json', import.meta.url), 'utf8'));
const items = manifest.configuration?.data || [];
const byKey = new Map(items.map(item => [item.key, item]));

test('Komari theme exposes safe display preferences', () => {
  assert.equal(manifest.version, '0.1.2');
  assert.equal(byKey.get('probe_limit')?.type, 'number');
  assert.equal(byKey.get('probe_order')?.type, 'select');
  assert.equal(byKey.get('probe_limit')?.default, 10);
  assert.equal(byKey.get('probe_order')?.default, '随机');
  assert.equal(byKey.get('bridge_url')?.type, 'string');
  assert.equal(byKey.get('label_mode')?.type, 'select');
});
