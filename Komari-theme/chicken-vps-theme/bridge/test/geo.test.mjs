import test from 'node:test';
import assert from 'node:assert/strict';

import { lookup } from '../server/geo.js';
import { normalizeConfig } from '../server/config.js';

test('geo lookup is offline by default', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('network should not be used');
  };
  try {
    const result = await lookup('8.8.8.8', { externalLookup: false });
    assert.deepEqual(result, { code: null, label: null, asn: null, asName: null });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geo config rejects plaintext/unknown providers', () => {
  assert.throws(
    () => normalizeConfig({ geo: { providers: ['ip-api.com'] } }, 'config.json'),
    /config\.json\.geo\.providers\[0\]/
  );
  assert.throws(() => normalizeConfig({ geo: { providers: 'ipwho.is' } }, 'config.json'), /config\.json\.geo\.providers/);
  assert.throws(() => normalizeConfig({ geo: null }, 'config.json'), /config\.json\.geo/);
  assert.equal(normalizeConfig({}, 'config.json').geo.externalLookup, false);
});
