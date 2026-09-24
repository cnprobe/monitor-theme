import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchJson, readResponseText } from '../server/probe/http.js';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('response bodies are bounded while streaming', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('x'.repeat(1024));
    res.end('y'.repeat(1024));
  });
  try {
    const response = await fetch(`${url}/large`);
    await assert.rejects(() => readResponseText(response, 512), /超过 512/);
  } finally {
    await close(server);
  }
});

test('custom credential headers are not forwarded across redirects', async () => {
  let targetHits = 0;
  const target = await listen((req, res) => {
    targetHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  const source = await listen((req, res) => {
    res.writeHead(302, { Location: `${target.url}/target` });
    res.end();
  });
  try {
    const result = await fetchJson(`${source.url}/source`, {
      headers: { 'X-Api-Key': 'do-not-forward' },
      ms: 2000,
    });
    assert.equal(result.ok, false);
    assert.equal(targetHits, 0);
  } finally {
    await close(source.server);
    await close(target.server);
  }
});
