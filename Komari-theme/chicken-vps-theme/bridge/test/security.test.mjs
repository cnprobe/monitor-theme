import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROBE_SECURITY,
  canonicalOrigin,
  defaultAllowedOrigins,
  isOriginAllowed,
  isSameOrigin,
  isTrustedProxy,
  normalizeAllowedOrigins,
  resolveClientIp,
  resolveProbeSecurity,
  validateTrustedProxyCidrs,
  stripAuthorizationHeaders,
  withoutRemoteCredentials,
} from '../server/security.js';
import { extractApiBases, readProbe } from '../server/probe/reader.js';
import { resolveSource, resolveSourceToken } from '../server/probe.js';

test('origin allowlist matches normalized exact origins only', () => {
  const allowed = normalizeAllowedOrigins(['https://Example.test/', 'http://localhost:3777']);
  assert.deepEqual(allowed, ['https://example.test', 'http://localhost:3777']);
  assert.equal(isOriginAllowed('https://example.test', allowed), true);
  assert.equal(isOriginAllowed('https://example.test:443', allowed), true);
  assert.equal(isOriginAllowed('https://evil.test', allowed), false);
  assert.equal(isOriginAllowed(undefined, allowed), false);
  assert.equal(isOriginAllowed('null', allowed), false);
  assert.throws(() => normalizeAllowedOrigins(['*']), /invalid origin/);
  assert.equal(isOriginAllowed('https://evil.example', ['*']), false);
});

test('origin defaults contain only local development origins', () => {
  const defaults = defaultAllowedOrigins(9000);
  assert.ok(defaults.includes('http://localhost:9000'));
  assert.ok(defaults.includes('http://127.0.0.1:3777'));
  assert.ok(defaults.every(value => canonicalOrigin(value)?.startsWith('http://localhost') ||
    value.startsWith('http://127.0.0.1') || value.startsWith('http://[::1]')));
});

test('probe security defaults deny remote following and accept explicit opt-in', () => {
  assert.deepEqual(resolveProbeSecurity(), {
    allowRemoteApiBase: false,
    allowNodegetBackends: false,
    apiBaseOrigins: [],
    nodegetBackendOrigins: [],
  });
  assert.deepEqual(resolveProbeSecurity({ allowRemoteApiBase: true }), {
    allowRemoteApiBase: true,
    allowNodegetBackends: false,
    apiBaseOrigins: [],
    nodegetBackendOrigins: [],
  });
  assert.deepEqual(resolveProbeSecurity({ security: { allowNodegetBackends: true } }), {
    allowRemoteApiBase: false,
    allowNodegetBackends: true,
    apiBaseOrigins: [],
    nodegetBackendOrigins: [],
  });
  assert.equal(DEFAULT_PROBE_SECURITY.allowRemoteApiBase, false);
});

test('cross-origin options remove credentials without mutating the source', () => {
  const source = {
    token: 'Bearer secret',
    apiToken: 'api-secret',
    tokenEnv: 'TOKEN_ENV',
    headers: {
      Authorization: 'Bearer header-secret',
      'X-Trace': 'ok',
      Accept: 'application/json',
    },
  };
  const safe = withoutRemoteCredentials(source);
  assert.equal(safe.token, undefined);
  assert.equal(safe.apiToken, undefined);
  assert.equal(safe.tokenEnv, undefined);
  assert.deepEqual(safe.headers, { Accept: 'application/json' });
  assert.equal(source.headers.Authorization, 'Bearer header-secret');
  assert.deepEqual(stripAuthorizationHeaders({ authorization: 'x', 'x-test': 'y', Accept: 'ok' }), { Accept: 'ok' });
});

test('forwarded headers are trusted only for an explicitly listed proxy', () => {
  assert.equal(isTrustedProxy('10.0.0.8', ['10.0.0.0/8']), true);
  assert.equal(isTrustedProxy('203.0.113.8', ['10.0.0.0/8']), false);
  assert.equal(isTrustedProxy('203.0.113.8', []), false);
});

test('client IP resolution uses the same flags for game and rate limiting', () => {
  const headers = {
    'cf-connecting-ip': '198.51.100.20',
    'x-forwarded-for': '203.0.113.10, 10.0.0.1',
  };
  assert.equal(resolveClientIp('172.17.0.1', headers, {
    trustedProxyCidrs: ['172.17.0.1'],
    trustCloudflareIp: false,
    trustProxy: false,
  }), '172.17.0.1');
  assert.equal(resolveClientIp('172.17.0.1', headers, {
    trustedProxyCidrs: ['172.17.0.1'],
    trustCloudflareIp: false,
    trustProxy: true,
  }), '203.0.113.10');
  assert.equal(resolveClientIp('172.17.0.1', headers, {
    trustedProxyCidrs: ['172.17.0.1'],
    trustCloudflareIp: true,
    trustProxy: false,
  }), '198.51.100.20');
});

test('trusted proxy list rejects malformed and unsupported CIDRs', () => {
  assert.deepEqual(validateTrustedProxyCidrs(['10.0.0.0/8', '::1']), ['10.0.0.0/8', '::1']);
  assert.throws(() => validateTrustedProxyCidrs(['not-a-cidr']), /valid IP/);
  assert.throws(() => validateTrustedProxyCidrs(['2001:db8::/32']), /exact addresses/);
  assert.throws(() => validateTrustedProxyCidrs(['10.0.0.0/33']), /between 0 and 32/);
});

test('credentials are refused for non-loopback plaintext HTTP probes', async () => {
  const result = await readProbe('http://status.example.test', { token: 'secret' });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTPS/);
});

test('apiBase extraction and source tokenEnv resolution are pure helpers', () => {
  assert.deepEqual(
    extractApiBases('<meta name="apiBase" content="https://api.example.test, https://other.example.test">'),
    ['https://api.example.test', 'https://other.example.test']
  );
  const source = { url: 'https://panel.example.test', tokenEnv: 'PANEL_TOKEN' };
  assert.equal(resolveSourceToken(source, { PANEL_TOKEN: 'secret' }), 'secret');
  assert.equal(resolveSource(source, { PANEL_TOKEN: 'secret' }).token, 'secret');
  assert.equal(resolveSource({ kind: 'komari', tokenEnv: 'KOMARI_API_KEY' }, { KOMARI_API_KEY: 'raw-key' }).token, 'Bearer raw-key');
  assert.equal(source.token, undefined);
  assert.equal(isSameOrigin('https://example.test/path', 'https://example.test/other'), true);
});
