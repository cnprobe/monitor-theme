import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBoardName } from '../../theme/js/hud.js';

test('leaderboard names stay readable and distinguish duplicate players', () => {
  assert.equal(formatBoardName('战斗鸡', true), '战斗鸡（玩家）');
  assert.equal(formatBoardName('战斗鸡', false), '战斗鸡');
  assert.equal(formatBoardName('NPC-大白鹅-1', false), 'NPC-大白鹅-1');
});
