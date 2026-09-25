import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPublicSettings, normalizeBridgeUrl, Net } from '../../theme/js/net.js';

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
