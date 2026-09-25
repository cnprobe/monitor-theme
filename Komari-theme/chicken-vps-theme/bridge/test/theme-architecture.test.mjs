import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../../theme/${path}`, import.meta.url), 'utf8');
}

test('single-ZIP nodes are read-only, non-colliding, and never use admin metadata RPC', async () => {
  const [main, client, net, hud, footer, html, css] = await Promise.all([
    source('js/main.js'),
    source('js/komari-client.js'),
    source('js/net.js'),
    source('js/hud.js'),
    source('js/footer.js'),
    source('index.html'),
    source('style.css'),
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
  assert.match(hud, /placeBridgeState/);
  assert.match(hud, /nameCounts/);
  assert.match(hud, /formatBoardName/);
  assert.match(hud, /r\.left \? 1 : 0/);
  assert.match(hud, /board-id/);
  assert.doesNotMatch(hud, /goose-team|NPC·大白鹅/);
  assert.match(main, /selectPlayerName/);
  assert.match(main, /mountFooter/);
  assert.match(main, /syncLocalIdentity/);
  assert.match(main, /net\.sendProfile\(patch\.name\);[\s\S]*syncLocalIdentity\(\)/);
  assert.match(main, /updateFooterPosition/);
  assert.match(main, /sprite\.getWorldPosition/);
  assert.doesNotMatch(main, /myId === 'local' \|\| !net\.connected/);
  assert.doesNotMatch(footer, /fetch|ipwho|ipapi|user-ip|visitor/);
  assert.match(html, /<div id="me-footer"[\s\S]*<div id="me-stack">/);
  assert.match(html, /id="footer-text"/);
  assert.doesNotMatch(html, /user-ip|user-country|server-info/);
  assert.match(html, /<div id="topbar">[\s\S]*id="bridge-state"/);
  assert.match(html, /<div id="score"><span id="score-text">/);
  assert.match(css, /body\.singleplayer #me-stack[\s\S]*display: block !important/);
  assert.doesNotMatch(html, /web-online|website-count/);
});
