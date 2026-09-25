import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Game } from '../server/game.js';

const serverDir = fileURLToPath(new URL('../server/', import.meta.url));

function testConfig() {
  return {
    allowedOrigins: ['http://localhost:4173'],
    trustCloudflareIp: false,
    trustedProxyCidrs: [],
    exposeVisitorGeo: false,
    geo: { externalLookup: false, providers: [] },
    geese: 2,
    maxPlayers: 10,
    maxHandshakesPerMinute: 60,
  };
}

function fakeSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(message) { this.sent.push(message); },
    close() { this.readyState = 3; },
  };
}

test('Bridge roster contains only authoritative players and optional geese', () => {
  const wss = { clients: new Set() };
  const game = new Game(wss, testConfig());
  try {
    const player = {
      id: 1,
      name: '玩家一',
      colorIdx: 2,
      scale: 1,
      geo: { code: 'CN', asn: 64500, asName: 'Example' },
      ws: fakeSocket(),
    };
    game.players.set(player.id, player);
    wss.clients.add(player.ws);
    game.broadcastRoster();

    const geese = [...game.npcs.values()];
    assert.equal(game.npcs.size, 2);
    assert.ok(geese.every(npc => npc.type === 'goose'));
    assert.deepEqual(geese.map(npc => npc.name), ['NPC-大白鹅-1', 'NPC-大白鹅-2']);

    // 击杀只记到实际完成攻击的那只鹅，不共享给鹅群。
    const victim = { id: 99, x: geese[0].x, z: geese[0].z, hp: 1, kx: 0, kz: 0 };
    game.npcPeck(geese[0], game.time, victim);
    assert.equal(geese[0].score, 1);
    assert.equal(geese[1].score, 0);

    assert.equal(player.ws.sent.length, 1);
    const message = JSON.parse(player.ws.sent[0]);
    assert.equal(message.t, 'r');
    assert.equal(message.list.length, 3);
    assert.equal(message.list.filter(info => info.npc).length, 2);
    assert.equal(message.list.filter(info => info.source === 'game').length, 3);
    assert.equal(message.list.some(info => 'stats' in info), false);
    assert.equal('probe' in message, false);
    assert.equal(JSON.stringify(message).includes('Komari'), false);
  } finally {
    game.close();
  }
});

test('Bridge server source contains no Komari monitor module', async () => {
  const entries = await readdir(serverDir);
  assert.equal(entries.includes('probe'), false);
  assert.equal(entries.includes('probe.js'), false);

  for (const name of ['config.js', 'game.js', 'index.js', 'security.js']) {
    const source = await readFile(new URL(`../server/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /common:getNodes|public:getNodesInformation|\/api\/rpc2/i);
    assert.doesNotMatch(source, /KOMARI_API_KEY|KOMARI_SHARE_URL|shareUrlEnv|tokenEnv/i);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  }
});
