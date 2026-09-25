import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { KomariBrowserClient } from '../../theme/js/komari-client.js';

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

test('Komari client completes the public metadata then selected-status RPC flow', { timeout: 10000 }, async () => {
  const requests = [];
  let denied = false;
  const server = http.createServer(async (request, response) => {
    const payload = await readJson(request);
    requests.push({ url: request.url, payload });
    let result;
    if (denied) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        error: { code: -32003, message: 'Private site enabled, please login first' },
      }));
      return;
    }
    if (payload.method === 'public:getNodesInformation') {
      result = [
        { uuid: 'a', name: 'A', mem_total: 1024, token: 'secret-a' },
        { uuid: 'b', name: 'B', mem_total: 2048, token: 'secret-b' },
        { uuid: 'hidden', name: 'Hidden', hidden: true, token: 'secret-hidden' },
      ];
    } else if (payload.method === 'common:getNodesLatestStatus') {
      result = {
        a: { client: 'a', online: true, cpu: 12, ram: 512, ram_total: 1024 },
      };
    } else {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unexpected method' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
  });

  const port = await listen(server);
  try {
    const client = new KomariBrowserClient({ endpoint: `http://127.0.0.1:${port}/api/rpc2` });
    client.configure({ probe_limit: 1, probe_order: 'name' });
    const nodes = [];
    const health = [];
    client.on('nodes', value => nodes.push(value));
    client.on('health', value => health.push(value));
    await client.refresh();

    assert.deepEqual(requests.map(request => request.url), ['/api/rpc2', '/api/rpc2']);
    assert.deepEqual(requests.map(request => request.payload.method), [
      'public:getNodesInformation',
      'common:getNodesLatestStatus',
    ]);
    assert.deepEqual(requests[1].payload.params, { uuids: ['a'] });
    assert.equal(nodes[0].length, 1);
    assert.equal(nodes[0][0].key, 'a');
    assert.equal(JSON.stringify(nodes[0]).includes('secret-'), false);
    assert.deepEqual(health[0], { ok: true, error: null });

    denied = true;
    await client.refresh();
    assert.equal(health.at(-1).ok, false);
    assert.equal(health.at(-1).unauthorized, true);
    assert.equal(nodes.length, 1, 'an unauthorized refresh must not publish replacement node data');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
