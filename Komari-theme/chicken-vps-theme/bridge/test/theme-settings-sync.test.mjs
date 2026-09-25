import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchGeeseSetting,
  readGeeseSetting,
  selectThemeSettingsOrigin,
  startThemeSettingsPoller,
} from '../server/theme-settings.js';

test('reads a bounded integer goose setting from public Komari settings', () => {
  assert.equal(readGeeseSetting({ data: { theme_settings: {} } }), undefined);
  assert.equal(readGeeseSetting({ data: { theme_settings: { geese: 0 } } }), 0);
  assert.equal(readGeeseSetting({ data: { theme_settings: { geese: 100 } } }), 100);
  assert.equal(readGeeseSetting({ data: { theme_settings: { geese: '7' } } }), 7);
  assert.throws(
    () => readGeeseSetting({ data: { theme_settings: { geese: 101 } } }),
    /geese must be an integer/,
  );
  assert.throws(
    () => readGeeseSetting({ data: { theme_settings: { geese: 1.5 } } }),
    /geese must be an integer/,
  );
  assert.throws(
    () => readGeeseSetting({ data: { theme_settings: { geese: true } } }),
    /geese must be an integer/,
  );
  assert.throws(
    () => readGeeseSetting({ data: { theme_settings: { geese: -1 } } }),
    /geese must be an integer/,
  );
});

test('selects an explicit or public allowed origin for theme settings', () => {
  assert.equal(selectThemeSettingsOrigin({
    themeSettingsOrigin: 'https://settings.example/',
    allowedOrigins: ['https://other.example'],
  }), 'https://settings.example');
  assert.equal(selectThemeSettingsOrigin({
    allowedOrigins: ['http://localhost:4173', 'https://public.example'],
  }), 'https://public.example');
  assert.equal(selectThemeSettingsOrigin({
    allowedOrigins: ['https://one.example', 'https://two.example'],
  }), '');
  assert.equal(selectThemeSettingsOrigin({
    allowedOrigins: ['http://localhost:4173'],
  }), '');
});

test('fetches public settings without credentials and rejects oversized responses', async () => {
  let request;
  const value = await fetchGeeseSetting('https://example.test', {
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ data: { theme_settings: { geese: 4 } } }),
      };
    },
  });
  assert.equal(value, 4);
  assert.equal(request.url, 'https://example.test/api/public');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');

  await assert.rejects(
    fetchGeeseSetting('https://example.test', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ data: { theme_settings: { geese: 4 } }, padding: 'x'.repeat(300000) }),
      }),
    }),
    /too large/,
  );
});

test('theme settings poller applies the first valid public value and can stop', async () => {
  let stop = () => {};
  const applied = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('poller did not apply the setting')), 1000);
    stop = startThemeSettingsPoller({
      config: { allowedOrigins: ['https://example.test'] },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ data: { theme_settings: { geese: 3 } } }),
      }),
      onGeese: value => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });
  assert.equal(await applied, 3);
  stop();
});
