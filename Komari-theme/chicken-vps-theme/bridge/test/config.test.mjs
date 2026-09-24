import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultConfig,
  loadConfig,
  normalizeConfig,
} from '../server/config.js';

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicken-bridge-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return { dir, file };
}

test('loads a valid config and normalizes origins and probe policy', () => {
  const raw = {
    port: 8081,
    allowedOrigins: ['https://Example.test/'],
    probe: {
      interval: 1000,
      security: { allowRemoteApiBase: true, allowNodegetBackends: false },
    },
  };
  const cfg = normalizeConfig(raw, 'config.json');
  assert.equal(cfg.port, 8081);
  assert.deepEqual(cfg.allowedOrigins, ['https://example.test']);
  assert.equal(cfg.probe.security.allowRemoteApiBase, true);
  assert.equal(cfg.probe.security.allowNodegetBackends, false);
});

test('malformed JSON fails instead of silently using defaults', () => {
  const { dir, file } = tempFile('{ definitely not json');
  try {
    assert.throws(() => loadConfig(file), /不是有效 JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid config fields fail with the field path', () => {
  assert.throws(
    () => normalizeConfig({ allowedOrigins: 'https://example.test' }, 'config.json'),
    /config\.json\.allowedOrigins/
  );
  assert.throws(
    () => normalizeConfig({ probe: { sources: {} } }, 'config.json'),
    /config\.json\.probe\.sources/
  );
  assert.throws(
    () => normalizeConfig({ maxProbeChicks: 100000 }, 'config.json'),
    /config\.json\.maxProbeChicks/
  );
  assert.throws(
    () => normalizeConfig({ geese: 100000 }, 'config.json'),
    /config\.json\.geese/
  );
  assert.throws(
    () => normalizeConfig({ maxNpcEntities: 100000 }, 'config.json'),
    /config\.json\.maxNpcEntities/
  );
  assert.throws(
    () => normalizeConfig({ maxHandshakesPerMinute: 1 }, 'config.json'),
    /config\.json\.maxHandshakesPerMinute/
  );
  assert.throws(
    () => normalizeConfig({ trustedProxyCidrs: ['not-a-cidr'] }, 'config.json'),
    /config\.json\.trustedProxyCidrs/
  );
  assert.throws(
    () => normalizeConfig({ trustedProxyCidrs: ['2001:db8::/32'] }, 'config.json'),
    /config\.json\.trustedProxyCidrs/
  );
});

test('missing config uses localhost-only development defaults', () => {
  const cfg = defaultConfig();
  assert.ok(cfg.allowedOrigins.includes('http://localhost:3777'));
  assert.ok(cfg.allowedOrigins.includes('http://127.0.0.1:4173'));
  assert.ok(cfg.allowedOrigins.every(origin => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):/.test(origin)));
  assert.equal(cfg.probe.security.allowRemoteApiBase, false);
  assert.equal(cfg.probe.security.allowNodegetBackends, false);
});
