import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalOrigin,
  defaultAllowedOrigins,
  isOriginAllowed,
  isTrustedProxy,
  normalizeAllowedOrigins,
  resolveClientIp,
  validateTrustedProxyCidrs,
} from '../server/security.js';

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
    trustedProxyCidrs: ['172.17.0.1'], trustCloudflareIp: false, trustProxy: false,
  }), '172.17.0.1');
  assert.equal(resolveClientIp('172.17.0.1', headers, {
    trustedProxyCidrs: ['172.17.0.1'], trustCloudflareIp: false, trustProxy: true,
  }), '203.0.113.10');
  assert.equal(resolveClientIp('172.17.0.1', headers, {
    trustedProxyCidrs: ['172.17.0.1'], trustCloudflareIp: true, trustProxy: false,
  }), '198.51.100.20');
});

test('trusted proxy list rejects malformed and unsupported CIDRs', () => {
  assert.deepEqual(validateTrustedProxyCidrs(['10.0.0.0/8', '::1']), ['10.0.0.0/8', '::1']);
  assert.throws(() => validateTrustedProxyCidrs(['not-a-cidr']), /valid IP/);
  assert.throws(() => validateTrustedProxyCidrs(['2001:db8::/32']), /exact addresses/);
  assert.throws(() => validateTrustedProxyCidrs(['10.0.0.0/33']), /between 0 and 32/);
});
