import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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
