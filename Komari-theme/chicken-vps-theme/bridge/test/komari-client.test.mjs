import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KomariBrowserClient,
  normalizeKomariNodes,
  selectKomariNodes,
} from '../../theme/js/komari-client.js';

function rpcResponse(id, result) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

test('same-origin Komari client requests only safe metadata and selected UUIDs', async () => {
  const requests = [];
  const client = new KomariBrowserClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      if (body.method === 'public:getNodesInformation') {
        return rpcResponse(body.id, [
          { uuid: 'node-1', name: 'Node 1', os: 'Linux', arch: 'amd64', mem_total: 2048, token: 'must-not-escape' },
          { uuid: 'node-2', name: 'Node 2', mem_total: 4096, token: 'must-not-escape' },
          { uuid: 'hidden', name: 'Hidden', hidden: true, token: 'must-not-escape' },
        ]);
      }
      if (body.method === 'common:getNodesLatestStatus') {
        return rpcResponse(body.id, {
          'node-1': { client: 'node-1', online: true, cpu: 25, ram: 1024, ram_total: 2048 },
        });
      }
      throw new Error(`unexpected RPC method: ${body.method}`);
    },
  });
  client.configure({ probe_limit: 1, probe_order: 'name' });
  const nodeEvents = [];
  const healthEvents = [];
  client.on('nodes', nodes => nodeEvents.push(nodes));
  client.on('health', health => healthEvents.push(health));
  await client.refresh();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/api/rpc2');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(requests.map(request => JSON.parse(request.options.body).method), [
    'public:getNodesInformation',
    'common:getNodesLatestStatus',
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body).params, { uuids: ['node-1'] });
  assert.equal(nodeEvents[0].length, 1);
  assert.equal(nodeEvents[0][0].name, 'Node 1');
  assert.equal(nodeEvents[0][0].online, true);
  assert.equal(nodeEvents[0][0].cpu, 25);
  assert.equal(nodeEvents[0][0].memU, 1);
  assert.equal(JSON.stringify(nodeEvents[0]).includes('must-not-escape'), false);
  assert.deepEqual(healthEvents, [{ ok: true, error: null }]);
});

test('static selection is stable for random and name modes', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    key: `node-${index}`,
    name: `Node ${String(index).padStart(2, '0')}`,
  }));
  const first = selectKomariNodes(nodes, { limit: 5, order: '随机', seed: 'panel' });
  const second = selectKomariNodes(nodes, { limit: 5, order: '随机', seed: 'panel' });
  assert.deepEqual(first.map(node => node.key), second.map(node => node.key));
  assert.equal(first.length, 5);
  const named = selectKomariNodes(nodes, { limit: 3, order: '按名称' });
  assert.deepEqual(named.map(node => node.name), ['Node 00', 'Node 01', 'Node 02']);
  assert.equal(selectKomariNodes(nodes, { limit: 0 }).length, nodes.length);
  const many = Array.from({ length: 250 }, (_, index) => ({ key: `many-${index}`, name: `Many ${index}` }));
  assert.equal(selectKomariNodes(many, { limit: 0 }).length, 200);
});

test('normalization accepts array responses and clamps unsafe values', () => {
  const nodes = normalizeKomariNodes(
    [
      { uuid: 'a', name: 'A', mem_total: 1024 },
      { uuid: 'hidden', name: 'Hidden', hidden: true },
    ],
    [{ client: 'a', online: true, cpu: 999, ram: -1, uptime: 0 }]
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].cpu, 100);
  assert.equal(nodes[0].memU, 0);
  assert.equal(nodes[0].uptime, '—');
});

test('an empty visible node set does not request status data', async () => {
  const methods = [];
  const client = new KomariBrowserClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      methods.push(body.method);
      return rpcResponse(body.id, body.method === 'public:getNodesInformation'
        ? [{ uuid: 'hidden', name: 'Hidden', hidden: true }]
        : {});
    },
  });
  let nodes = null;
  let health = null;
  client.on('nodes', value => { nodes = value; });
  client.on('health', value => { health = value; });
  await client.refresh();
  assert.deepEqual(methods, ['public:getNodesInformation']);
  assert.deepEqual(nodes, []);
  assert.equal(health.ok, true);
});

test('unauthorized RPC becomes a health error without exposing credentials', async () => {
  const client = new KomariBrowserClient({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => '',
    }),
  });
  let health;
  client.on('health', value => { health = value; });
  await client.refresh();
  assert.equal(health.ok, false);
  assert.equal(health.unauthorized, true);
  assert.match(health.error, /登录|分享/);
});
