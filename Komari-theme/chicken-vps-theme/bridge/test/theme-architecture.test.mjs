import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../../theme/${path}`, import.meta.url), 'utf8');
}

test('single-ZIP nodes are read-only, non-colliding, and never use admin metadata RPC', async () => {
  const [main, client, net, hud, html] = await Promise.all([
    source('js/main.js'),
    source('js/komari-client.js'),
    source('js/net.js'),
    source('js/hud.js'),
    source('index.html'),
  ]);

  assert.match(main, /readonly:\s*true/);
  assert.match(main, /networked:\s*false/);
  assert.match(main, /collidable:\s*false/);
  assert.match(main, /id === myId \|\| localProbeIds\.has\(id\)/);
  assert.match(main, /if \(health\?\.unauthorized\)[\s\S]*removeLocalProbeNodes\(\)/);
  assert.doesNotMatch(main, /net\.send\([^)]*(?:roster|node|uuid|stats)/i);

  assert.match(client, /public:getNodesInformation/);
  assert.match(client, /common:getNodesLatestStatus/);
  assert.doesNotMatch(client, /common:getNodes['"]/);
  assert.match(client, /credentials:\s*'include'/);
  assert.match(client, /endpointUrl\.origin !== location\.origin/);
  assert.match(client, /const uuids = selectedMetadata\.map/);
  assert.match(client, /common:getNodesLatestStatus[\s\S]*\{ uuids \}/);

  assert.match(net, /credentials:\s*'same-origin'/);
  assert.match(net, /message\.protocol !== 2/);
  assert.doesNotMatch(net, /sanitizeStats|readonly|collidable/);
  assert.match(hud, /setMultiplayerActive/);
  assert.doesNotMatch(html, /web-online|website-count/);
});
