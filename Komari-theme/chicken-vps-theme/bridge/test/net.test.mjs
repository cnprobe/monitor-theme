import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPublicSettings, normalizeBridgeUrl, normalizeGooseName, normalizePlayerName, selectPlayerName, Net } from '../../theme/js/net.js';

function setLocation(value) {
  Object.defineProperty(globalThis, 'location', { value, configurable: true, writable: true });
}

test('public settings use same-origin credentials and a timeout signal', async () => {
  let request = null;
  const data = await loadPublicSettings({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { sitename: 'Fixture' } }),
      };
    },
  });
  assert.equal(request.url, '/api/public');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(data.sitename, 'Fixture');

  const result = await loadPublicSettings({
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  assert.deepEqual(result, {});
});

test('Bridge URL normalization is HTTPS-safe and rejects credential-like queries', () => {
  const originalLocation = globalThis.location;
  try {
    setLocation({ href: 'https://monitor.example.com/', protocol: 'https:' });
    assert.equal(normalizeBridgeUrl('https://chicken.example.com'), 'wss://chicken.example.com/ws');
    assert.equal(normalizeBridgeUrl('wss://chicken.example.com/game'), 'wss://chicken.example.com/game');
    assert.equal(normalizeBridgeUrl('http://chicken.example.com'), '');
    assert.equal(normalizeBridgeUrl('wss://user:pass@chicken.example.com/ws'), '');
    assert.equal(normalizeBridgeUrl('wss://chicken.example.com/ws?token=x'), '');
    assert.equal(normalizeBridgeUrl('wss://chicken.example.com/ws?room=public'), '');
  } finally {
    if (originalLocation === undefined) delete globalThis.location;
    else setLocation(originalLocation);
  }
});

test('goose display names stay distinct when an older Bridge sends a shared name', () => {
  assert.equal(normalizeGooseName('NPC·大白鹅', 9001), 'NPC-大白鹅-1');
  assert.equal(normalizeGooseName('NPC·大白鹅', 9002), 'NPC-大白鹅-2');
  assert.equal(normalizeGooseName('NPC·大白鹅-7', 9001), 'NPC-大白鹅-7');
  assert.equal(normalizeGooseName('其他名字', 9001), '其他名字');
});

test('persisted player names are normalized and invalid values are rejected', () => {
  assert.equal(normalizePlayerName('  战斗鸡  '), '战斗鸡');
  assert.equal(normalizePlayerName('A'.repeat(13)), '');
  assert.equal(normalizePlayerName('\u200b'.repeat(20)), '');
  assert.equal(normalizePlayerName('😀'.repeat(12)), '😀'.repeat(12));
});

test('player name pools select one stable valid name for a visitor', () => {
  const pool = '战斗鸡, 芦花鸡，铁公鸡、\n小鸡';
  assert.equal(selectPlayerName(pool, () => 0), '战斗鸡');
  assert.equal(selectPlayerName(pool, () => 0.34), '芦花鸡');
  assert.equal(selectPlayerName(pool, () => 0.99), '小鸡');
  assert.equal(selectPlayerName('这是一个超过十二个字符的名字', () => 0), '这是一个超过十二个字符的名字'.slice(0, 12));
  assert.equal(selectPlayerName('', () => 0), '小鸡');
});

test('offline profile edits report failure instead of pretending to sync', async () => {
  const originalLocation = globalThis.location;
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  try {
    setLocation({
      href: 'http://localhost:4173/',
      protocol: 'http:',
      hostname: 'localhost',
      search: '',
    });
    globalThis.localStorage = storage;
    globalThis.sessionStorage = storage;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: {} }),
    });
    const net = new Net();
    await net.ready;
    assert.equal(net.sendProfile('本地名字'), false);
    assert.equal(net.name, '本地名字');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
    if (originalSessionStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = originalSessionStorage;
    if (originalLocation === undefined) delete globalThis.location;
    else setLocation(originalLocation);
  }
});
