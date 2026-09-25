import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { readProbe } from '../server/probe/reader.js';

test('explicit adapters receive the configured source token on their second read', async () => {
  let authorization;
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ servers: [{ name: 'test', online4: true, cpu: 1 }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await readProbe(`http://127.0.0.1:${port}/json/stats.json`, {
      kind: 'serverstatus',
      token: 'Bearer test-token',
      ms: 2000,
    });
    assert.equal(result.ok, true);
    assert.equal(authorization, 'Bearer test-token');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Komari adapter forwards a private API key to REST fallback', async () => {
  let authorization;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/nodes') {
      authorization = request.headers.authorization;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        status: 'success',
        data: [{ uuid: 'node-1', name: 'Node 1', mem_total: 1024 }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await readProbe(`http://127.0.0.1:${port}`, {
      kind: 'komari',
      token: 'private-api-key',
      ms: 1000,
      wsMs: 100,
    });
    assert.equal(result.ok, true);
    assert.equal(authorization, 'Bearer private-api-key');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Komari adapter forwards a private API key to the live RPC WebSocket', async () => {
  let authorization;
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({ server, path: '/api/rpc2' });
  wss.on('connection', (socket, request) => {
    authorization = request.headers.authorization;
    socket.on('message', data => {
      const calls = JSON.parse(data.toString());
      const list = Array.isArray(calls) ? calls : [calls];
      const responses = list.map(call => ({
        jsonrpc: '2.0',
        id: call.id,
        result: call.method === 'common:getNodes'
          ? { 'node-1': { uuid: 'node-1', name: 'Node 1', mem_total: 1024 } }
          : { 'node-1': { client: 'node-1', cpu: 1, ram: 512, ram_total: 1024 } },
      }));
      socket.send(JSON.stringify(Array.isArray(calls) ? responses : responses[0]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await readProbe(`http://127.0.0.1:${port}`, {
      kind: 'komari',
      token: 'private-api-key',
      ms: 2000,
      wsMs: 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'ws');
    assert.equal(authorization, 'Bearer private-api-key');
  } finally {
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
