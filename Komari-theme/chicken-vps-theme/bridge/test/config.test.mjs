import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultConfig, loadConfig, normalizeConfig } from '../server/config.js';

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicken-bridge-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return { dir, file };
}

test('loads the minimal multiplayer Bridge config', () => {
  const cfg = normalizeConfig({
    port: 8081,
    allowedOrigins: ['https://Example.test/'],
    themeSettingsOrigin: 'https://example.test',
    geese: 3,
    maxPlayers: 20,
    geo: { externalLookup: false },
  }, 'config.json');
  assert.equal(cfg.port, 8081);
  assert.deepEqual(cfg.allowedOrigins, ['https://example.test']);
  assert.equal(cfg.themeSettingsOrigin, 'https://example.test');
  assert.equal(cfg.geese, 3);
  assert.equal(cfg.maxPlayers, 20);
  assert.equal(cfg.geo.externalLookup, false);
});

test('unknown configuration fields are discarded from the game-only Bridge', () => {
  const cfg = normalizeConfig({ unexpectedOption: true }, 'config.json');
  assert.equal(cfg.unexpectedOption, undefined);
});

test('malformed JSON fails instead of silently using defaults', () => {
  const { dir, file } = tempFile('{ definitely not json');
  try {
    assert.throws(() => loadConfig(file), /不是有效 JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid multiplayer config fields fail with the field path', () => {
  assert.throws(
    () => normalizeConfig({ allowedOrigins: 'https://example.test' }, 'config.json'),
    /config\.json\.allowedOrigins/
  );
  assert.throws(
    () => normalizeConfig({
      allowedOrigins: ['https://example.test'],
      themeSettingsOrigin: 'https://other.test',
    }, 'config.json'),
    /config\.json\.themeSettingsOrigin/,
  );
  assert.throws(
    () => normalizeConfig({
      allowedOrigins: ['http://public.example'],
      themeSettingsOrigin: 'http://public.example',
    }, 'config.json'),
    /config\.json\.themeSettingsOrigin/,
  );
  assert.throws(() => normalizeConfig({ geese: 100000 }, 'config.json'), /config\.json\.geese/);
  assert.throws(() => normalizeConfig({ maxPlayers: 0 }, 'config.json'), /config\.json\.maxPlayers/);
  assert.throws(
    () => normalizeConfig({ maxHandshakesPerMinute: 1 }, 'config.json'),
    /config\.json\.maxHandshakesPerMinute/
  );
  assert.throws(
    () => normalizeConfig({ geo: { providers: ['unknown'] } }, 'config.json'),
    /config\.json\.geo\.providers/
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

test('missing config uses localhost-only multiplayer defaults', () => {
  const cfg = defaultConfig();
  assert.ok(cfg.allowedOrigins.includes('http://localhost:3777'));
  assert.ok(cfg.allowedOrigins.includes('http://127.0.0.1:4173'));
  assert.ok(cfg.allowedOrigins.every(origin => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):/.test(origin)));
  assert.equal(cfg.themeSettingsOrigin, '');
  assert.equal(cfg.geese, 2);
  assert.equal(cfg.maxPlayers, 60);
});
