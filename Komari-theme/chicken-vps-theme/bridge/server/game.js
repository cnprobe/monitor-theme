// 权威游戏服务器：所有移动、碰撞、啄击/扇翅判定都在服务端算，
// 客户端只上报操作意图（方向、疾跑、跳跃、朝向、攻击请求）。
// NPC（牛/羊/鹅）也由服务器驱动：闲逛、被啄会跑、大白鹅会追人。

import { randomBytes } from 'crypto';
import {
  CONF, WORLD_HALF, buildObstacles, stepBody, resolveCircle, groundHeight,
  ST_DEAD, ST_PECK, ST_AIR, ST_WALK, ST_RUN, ST_FLAP
} from '../shared/physics.js';
import { lookup } from './geo.js';
import { resolveClientIp } from './security.js';
import { Probe } from './probe.js';
import cfg from './config.js';

const BREEDS = ['芦花鸡', '三黄鸡', '乌骨鸡', '白羽鸡', '麻鸡', '北京油鸡', '小笨鸡', '丝毛乌鸡', '清远鸡', '战斗鸡', '珍珠鸡', '芦花战斗鸡'];
const N_COLORS = 5;

// 并发上限（安全审查中危项 #4，2026-09-20）：
// 每个连接 = 1 player + 1 session(45s) + 1 次 geo 外呼（无本地 mmdb 时最多串行 3 个
// 第三方 API）+ 进出各一次 O(n) 广播。不设上限时，脚本洪水会把 CPU/带宽/出站请求
// 全放大。MAX_SOCKETS 是「握手中+已连接」的硬顶，比 players 上限更早拦截半开连接。
const MAX_PLAYERS = 60;   // 在场玩家人数上限（config.json 的 maxPlayers 可覆盖）
const MAX_SOCKETS = 200;  // ws 侧连接硬顶（含还没走完 onConnection 的）
const MAX_WS_BUFFERED_BYTES = 1_000_000;

// 自定义资料（2026-09-21）：玩家可改名字。换图标功能已移除（第二十九轮），
// 旧展示名里的图标前缀由客户端预填时剥掉，服务端不再组合图标。
// 名字按 code point 数限制（emoji/中文都算 1 个），去掉零宽字符与多余空白。
function validCustomName(s) {
  if (typeof s !== 'string') return null;
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const n = [...s].length; // code point 数：emoji/中文各算 1
  if (n < 1 || n > 12) return null;
  return s;
}

// NPC 定义与行为参数（大鹅有领地意识，会追击靠近的鸡；数量由 config.json 的 geese 决定）
const NPC_TYPE = {
  goose: { radius: 0.35, walk: 1.3, flee: 3.6, chase: 2.55, chaseRadius: 2.5, color: 2, maxHp: 60, peckDamage: 6, peckKnock: 3.2, peckCd: 1.2 },
  // 探针小鸡：与玩家鸡同体型，CPU > 50% 时见谁啄谁。
  // 疾跑（sprintSpeed/sprintTime）：被啄 1/3 概率触发，或网速 ≥5MB/s 随机触发——比逃跑/追击都快
  chick: { radius: 0.38, walk: 1.0, flee: 3.4, chase: 2.6, chaseRadius: 3.5, color: 4, maxHp: 100, peckDamage: 6, peckKnock: 3.0, peckCd: 1.6,
    sprintSpeed: 5.0, sprintTime: 1.6 },
  // 网站鸡：网站可用性检测生成，卡片显示延迟；被啄会还击，但从不主动攻击
  web: { radius: 0.38, walk: 1.0, flee: 3.4, chase: 2.6, chaseRadius: 3.5, color: 4, maxHp: 140, peckDamage: 5, peckKnock: 3.0, peckCd: 1.8 }
};

// 网速疾跑阈值：探针鸡当前上下行合计 ≥ 5MB/s（stats.netRx/netTx 单位 B/s）时随机疾跑
const NET_SPRINT_BPS = 5 * 1024 * 1024;

// 探针鸡 / 网站鸡的外观：毛色随机（和玩家鸡一致）；探针小鸡的体型仍跟机器负载
// 挂钩（越忙越大），所以"机器忙不忙"看体型依然一眼可见，但每只鸡有自己的花色。
const CHICK_PALETTES = 5; // 与前端 public/js/chicken.js 的 PALETTES 长度一致
const safeText = (value, max = 120) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ').slice(0, max);

// 由探针的稳定 key 派生一个 0..CHICK_PALETTES-1 的毛色档位。
// 用 hash 而不是 Math.random()：同一个目标每次重连/刷新都得到同一身花色，
// 不会"每次上线换一只鸡"，但不同目标之间是随机分布的。
function chickLookIndex(key, fallbackStats) {
  const s = String(key ?? '');
  if (!s) {
    // 没有稳定 key 时退回随机（例如临时实体）
    return Math.floor(Math.random() * CHICK_PALETTES);
  }
  let h = 2166136261;                 // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % CHICK_PALETTES;
}

function chickScale(stats) {
  const cpu = Math.max(0, Math.min(100, +stats?.cpu || 0));
  return +(1.0 + cpu / 100 * 0.35).toFixed(3); // 1.00 ~ 1.35
}

function extractIp(req, trustCf, trustedProxyCidrs = []) {
  return resolveClientIp(req.socket?.remoteAddress, req.headers, {
    trustCloudflareIp: trustCf,
    trustProxy: process.env.TRUST_PROXY === '1',
    trustedProxyCidrs,
  });
}

export class Game {
  constructor(wss, serverCfg = cfg) {
    this.cfg = serverCfg;
    this.wss = wss;
    this.maxPlayers = Math.min(MAX_SOCKETS, Math.max(1, Number(serverCfg.maxPlayers) || MAX_PLAYERS));
    this.maxProbeChicks = Math.min(1000, Math.max(1, Number(serverCfg.maxProbeChicks) || 200));
    this.maxNpcEntities = Math.min(2000, Math.max(1, Number(serverCfg.maxNpcEntities) || 500));
    this.exposeVisitorGeo = serverCfg.exposeVisitorGeo === true;
    this.players = new Map();
    this.pendingPlayers = 0;
    this.npcs = new Map();
    this.sessions = new Map(); // token -> { player, expireAt }：断线后可恢复身份与战绩
    // 离场玩家的啄倒记录（榜单保留用）：id -> {id, name, score, leftAt}
    // 只记 score>0 的；上限 100 条，满了挤最旧的。玩家回场（resume）即撤下。
    this.leftPlayers = new Map();
    this.nextId = 1;
    this.obstacles = buildObstacles();
    this.evQueue = [];
    this.tick = 0;
    this.chickSeq = 0;
    this.time = 0; // 模拟时间（秒），与真实时钟保持同步
    // 清理过期的断线会话，避免内存无限增长
    setInterval(() => {
      const t = Date.now();
      for (const [tok, s] of this.sessions) if (s.expireAt < t) this.sessions.delete(tok);
    }, 30000);
    // Windows 下 setInterval 粒度可达 62.5ms，直接按 50ms 步进会让模拟时间越走越慢，
    // 因此用真实流逝时间累加，按固定步长追帧。
    const STEP = 0.05;
    let acc = 0, last = Date.now();
    setInterval(() => {
      const t = Date.now();
      acc += Math.min(0.5, (t - last) / 1000);
      last = t;
      let n = 0;
      while (acc >= STEP && n < 10) { this.update(STEP); acc -= STEP; n++; }
      if (n >= 10) acc = 0; // 长时间卡顿后直接追平，不做雪崩式补帧
    }, 25);

    this.spawnNpcs();

    // VPS 探针 → NPC 小鸡（每台机器一只；离线的仍留在场上但躺倒不可选中）
    // probe.sources 是新的多源配置（可混用 7 类探针）；
    // 未配置时回退到旧的 probe.url + probe.sites 形式。
    const pcfg = this.cfg.probe || {};
    const hasSources = Array.isArray(pcfg.sources) ? pcfg.sources.length > 0 : !!pcfg.sources;
    this.probe = new Probe(hasSources ? pcfg.sources : pcfg.url, pcfg.interval, pcfg.sites, pcfg);
    this.probe.onUpdate = (list) => this.syncProbeChicks('chick', list, s => s);
    this.probe.onSitesUpdate = (list) => this.syncProbeChicks('web', list, s => ({
      site: true, region: s.region, latency: s.latency, online: s.online, err: s.err || null
    }));
    this.probe.onHealth = (h) => {
      this.probeHealth = h;
      // 探针挂了要让场内玩家看得见，而不是数据静默停在旧值
      this.broadcastRoster();
    };
    this.probeHealth = { ok: true, error: null, sources: [] };
    this.probe.start();
  }

  // ---- 连接生命周期 ------------------------------------------------------

  async onConnection(ws, req) {
    // 并发上限：满了就拒（1013 = Try Again Later），不做 geo 外呼、不进名单，
    // 让拒绝的成本接近零。客户端会照常走断线重连逻辑，恢复后再进场。
    if (this.wss.clients.size > MAX_SOCKETS || this.players.size + this.pendingPlayers >= this.maxPlayers) {
      try { ws.close(1013, 'chicken-vps-full'); } catch { /* ignore */ }
      console.log(`[full] 拒绝连接：players=${this.players.size}/${this.maxPlayers} sockets=${this.wss.clients.size}/${MAX_SOCKETS}`);
      return;
    }
    ws._msgs = 0; // 简单限速计数
    ws._bytes = 0; // 每秒输入字节预算
    const ip = extractIp(req, this.cfg.trustCloudflareIp, this.cfg.trustedProxyCidrs);
    this.pendingPlayers += 1;
    ws.pause?.();
    let geo;
    try {
      geo = await lookup(ip, this.cfg.geo);
    } catch (error) {
      this.pendingPlayers -= 1;
      throw error;
    }
    this.pendingPlayers -= 1;
    if (ws.readyState !== 1 || this.players.size >= this.maxPlayers) {
      try { ws.close(1013, 'chicken-vps-full'); } catch { /* ignore */ }
      return;
    }

    const id = this.nextId++;
    const breed = BREEDS[Math.floor(Math.random() * BREEDS.length)];
    // 名字只显示鸡的品种；地区信息由名牌上的旗标图标表达
    const token = randomBytes(24).toString('base64url');
    const p = {
      id, ws, ip, geo, token,
      name: breed,
      customName: breed,   // 玩家自定义名；name 即 customName（换图标功能已移除）
      colorIdx: (id * 7 + breed.length) % N_COLORS,
      x: 0, y: 0, z: 0, vy: 0, kx: 0, kz: 0,
      yaw: 0, hp: CONF.maxHp, score: 0,
      deadUntil: 0, lastPeck: -9, lastWing: -9, peckAnim: 0, wingAnim: 0,
      // pid 参与连跳段数哈希（physics.js）：客户端与服务端据此算出同一个上限
      inp: { mx: 0, mz: 0, run: false, jump: false, yaw: 0, pid: id }
    };
    this.spawn(p);
    this.players.set(id, p);
    this.sessions.set(token, { player: p, expireAt: Date.now() + 45000 });

    ws._player = p;
    ws.on('message', (data) => this.onMessage(p, data));
    ws.on('close', () => this.onLeave(p));
    ws.on('error', () => {});
    ws.resume?.();

    this.send(p, {
      t: 'w', id, conf: CONF, half: WORLD_HALF,
      obstacles: this.obstacles, colors: N_COLORS, token
    });
    this.broadcastRoster();
    console.log(`[join] #${id} ${p.name}`);
  }

  // 断线重连：用令牌换回同一只鸡（名字、毛色、分数、位置全部保留）
  tryResume(p, token) {
    const s = token && this.sessions.get(String(token));
    if (!s || s.expireAt < Date.now()) return false;
    const old = s.player;

    // 老连接还活着就先踢掉，避免同一只鸡被两个 socket 驱动
    if (old.ws && old.ws !== p.ws && old.ws.readyState === 1) {
      try { old.ws._resumed = true; old.ws.close(); } catch { /* ignore */ }
    }

    // 关键：新 socket 在 onConnection 里已经临时登记了一只鸡，必须先摘掉它，
    // 否则名单里会同时存在临时鸡和恢复后的鸡（同一玩家出现两次）。
    this.players.delete(old.id);
    if (p.id !== old.id) this.players.delete(p.id);
    const tmpScale = p.scale;
    const tmpToken = p.token;

    p.id = old.id;
    p.name = old.name;
    p.colorIdx = old.colorIdx;
    p.score = old.score;
    p.scale = old.scale ?? tmpScale ?? 1;
    p.x = old.x; p.y = old.y; p.z = old.z;
    p.yaw = old.yaw; p.vy = 0; p.kx = 0; p.kz = 0;
    p.hp = old.hp > 0 ? old.hp : CONF.maxHp;
    p.deadUntil = old.deadUntil > this.time ? old.deadUntil : 0;
    this.players.set(p.id, p);
    this.leftPlayers.delete(old.id); // 回场的玩家从离场榜单撤下（下面的广播会同步到所有客户端）

    // 每次恢复都轮换会话令牌，旧令牌立即失效，降低重放窗口。
    const nextToken = randomBytes(24).toString('base64url');
    this.sessions.delete(String(token));
    if (tmpToken && tmpToken !== token) this.sessions.delete(tmpToken);
    p.token = nextToken;
    this.sessions.set(nextToken, { player: p, expireAt: Date.now() + 45000 });

    this.send(p, {
      t: 'w', id: p.id, conf: CONF, half: WORLD_HALF,
      obstacles: this.obstacles, colors: N_COLORS, token: nextToken, resumed: true
    });
    this.send(p, { t: 'resume', id: p.id, name: p.name, color: p.colorIdx, score: p.score });
    this.broadcastRoster();
    console.log(`[resume] #${p.id} ${p.name} 战绩已恢复（${p.score} 分）`);
    return true;
  }

  onLeave(p) {
    // 已被重连接管、或已被 tryResume 摘除的 socket：不再做任何清理，
    // 否则会把刚恢复的鸡一起删掉。
    if (p.ws._resumed) return;
    if (!this.players.has(p.id) || this.players.get(p.id) !== p) return;
    this.players.delete(p.id);
    // 离场玩家的啄倒记录进榜保留（啄倒过才记；上限 100，满了挤最旧的）
    if (p.score > 0) {
      if (this.leftPlayers.size >= 100) {
        let oldest = null;
        for (const kv of this.leftPlayers) if (!oldest || kv[1].leftAt < oldest[1].leftAt) oldest = kv;
        if (oldest) this.leftPlayers.delete(oldest[0]);
      }
      this.leftPlayers.set(p.id, { id: p.id, name: p.name, score: p.score, leftAt: Date.now() });
    }
    // 非主动重连的断开：保留会话 45 秒，等玩家带着令牌回来
    if (p.token) {
      const s = this.sessions.get(p.token);
      if (s && s.player === p) s.expireAt = Date.now() + 45000;
    }
    this.broadcastRoster();
    console.log(`[leave] #${p.id} ${p.name}`);
  }

  // ---- NPC ---------------------------------------------------------------

  spawnNpcs() {
    // 大鹅数量由 config.json 的 geese 决定，随机位置入栏
    const count = Math.min(100, this.maxNpcEntities, Math.max(0, this.cfg.geese ?? 2));
    for (let i = 0; i < count; i++) {
      const t = NPC_TYPE.goose;
      const n = {
        id: 9000 + i + 1,
        npc: true, type: 'goose', name: `NPC·大白鹅`,
        color: t.color, radius: t.radius, maxHp: t.maxHp,
        x: 0, z: 0, y: 0, vy: 0, kx: 0, kz: 0,
        yaw: Math.random() * 6.28, hp: t.maxHp, score: 0,
        state: 'idle', timer: Math.random() * 2, target: { x: 0, z: 0 },
        fleeFrom: { x: 0, z: 0 },
        lastPeck: -9, peckAnim: 0, deadUntil: 0,
        inp: { mx: 0, mz: 0, run: false, jump: false, yaw: 0, radius: t.radius }
      };
      this.spawnAt(n, (Math.random() * 2 - 1) * (WORLD_HALF - 6), (Math.random() * 2 - 1) * (WORLD_HALF - 6));
      this.npcs.set(n.id, n);
    }
    console.log(`[npc] 已放养 ${this.npcs.size} 只大鹅`);
  }

  updateNpc(n, dt, now) {
    // 离线探针鸡：永远躺倒，不移动、不复活（由 syncProbeChicks 在恢复在线时唤起）
    if (n.deadUntil === Infinity) {
      n.inp.mx = 0; n.inp.mz = 0;
      n.peckAnim = 0;
      return;
    }
    // 被啄倒：原地侧翻，期满满血复活
    if (n.deadUntil > 0) {
      if (now >= n.deadUntil) {
        n.deadUntil = 0;
        n.hp = n.maxHp;
        n.state = 'idle';
        n.timer = 1;
      } else {
        n.inp.mx = 0; n.inp.mz = 0;
        return;
      }
    }
    const t = NPC_TYPE[n.type];
    const inp = n.inp;
    n.timer -= dt;
    n.peckAnim = Math.max(0, n.peckAnim - dt);
    let dir = null, fleeing = false;

    if (n.state === 'flee') {
      const dx = n.x - n.fleeFrom.x, dz = n.z - n.fleeFrom.z;
      const d = Math.hypot(dx, dz) || 1;
      dir = [dx / d, dz / d];
      fleeing = true;
      if (n.timer <= 0) { n.state = 'idle'; n.timer = 1 + Math.random() * 2; }
    } else if (n.state === 'chase') {
      // 追击：鹅盯玩家；探针鸡 CPU > 50% 主动出击，被啄后的还击则不受门控
      if (n.type === 'chick' && !n.retaliate && (n.stats?.cpu || 0) <= 50) {
        n.state = 'idle'; n.timer = 0.5; n.retaliate = false;
      } else {
        const best = this.findPrey(n, now, t.chaseRadius + 4);
        if (best) {
          const dx = best.x - n.x, dz = best.z - n.z;
          const d = Math.hypot(dx, dz);
          if (d > 1.15) dir = [dx / d, dz / d];
          else this.npcPeck(n, now, best);
        } else { n.state = 'idle'; n.timer = 0.5; n.retaliate = false; }
      }
    } else if (n.state === 'wander') {
      const dx = n.target.x - n.x, dz = n.target.z - n.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.6 || n.timer <= 0) { n.state = 'idle'; n.timer = 1.5 + Math.random() * 3.5; }
      else dir = [dx / d, dz / d];
    } else { // idle
      if (n.timer <= 0) {
        if (Math.random() < 0.7) {
          n.target = { x: (Math.random() * 2 - 1) * (WORLD_HALF - 4), z: (Math.random() * 2 - 1) * (WORLD_HALF - 4) };
          n.state = 'wander';
          n.timer = 7;
          // 高网速探针鸡（上下行合计 ≥5MB/s）：换目标时 50% 概率来一段随机疾跑
          if (n.type === 'chick'
            && (n.stats?.netRx || 0) + (n.stats?.netTx || 0) >= NET_SPRINT_BPS
            && Math.random() < 0.5) {
            n.sprintUntil = now + 1.5 + Math.random(); // 疾跑 1.5~2.5 秒
          }
        } else {
          n.timer = 2 + Math.random() * 3;
        }
      }
    }

    // 仇恨检测：鹅见玩家就上；探针鸡只在 CPU 负载超过 50% 时才会主动攻击
    if (n.state !== 'chase' && n.state !== 'flee') {
      const angry = n.type === 'goose' || (n.stats?.cpu || 0) > 50;
      if (angry && this.findPrey(n, now, t.chaseRadius)) n.state = 'chase';
    }

    if (dir) {
      inp.yaw = Math.atan2(dir[0], dir[1]);
      inp.mx = dir[0]; inp.mz = dir[1];
      const sprinting = now < (n.sprintUntil || 0);
      inp.speed = fleeing
        ? (sprinting ? t.sprintSpeed : t.flee)
        : (n.state === 'chase' ? t.chase : (sprinting ? t.sprintSpeed : t.walk));
      inp.run = fleeing || n.state === 'chase' || sprinting;
      // 小鸡的闲逛速度跟着 CPU 负载走：机器越忙小鸡越慌（疾跑时例外）
      if (n.type === 'chick' && !fleeing && !sprinting) inp.speed = 0.8 + (n.stats?.cpu || 0) * 0.04;
    } else {
      inp.mx = 0; inp.mz = 0;
    }
    stepBody(n, inp, this.obstacles, dt);
    n.yaw = inp.yaw;
  }

  // ---- 探针小鸡 ----------------------------------------------------------

  // 同步探针小鸡（type: 'chick' VPS机器 / 'web' 网站）。
  // 离线的条目不再被移除，而是留在场上进入"倒地不可选中"状态。
  syncProbeChicks(type, list, toStats) {
    const source = Array.isArray(list) ? list : [];
    const otherEntities = [...this.npcs].filter(entity => entity.type !== type).length;
    const available = Math.max(0, this.maxNpcEntities - otherEntities);
    const visible = source
      .filter(item => item && typeof item === 'object')
      .slice(0, Math.min(this.maxProbeChicks, available));
    for (const [id, n] of [...this.npcs]) {
      // 只有彻底从探针列表里消失（配置删除了这条）才真正离场
      if (n.type === type && !visible.some(s => String(s.key) === n.probeKey)) {
        this.npcs.delete(id);
        console.log(`[probe] 下线离场: ${n.name}`);
      }
    }
    for (const s of visible) {
      const probeKey = String(s.key).slice(0, 256);
      let n = [...this.npcs.values()].find(c => c.type === type && c.probeKey === probeKey);
      const stats = toStats(s);
      const online = s.online !== false; // 缺省视为在线（向后兼容）
      if (!n) {
        const t = NPC_TYPE[type];
        const id = 9500 + ++this.chickSeq;
        n = {
          id, npc: true, type, probeKey,
          name: `探针鸡·${safeText(s.name || probeKey)}`,
          color: Math.floor(Math.random() * N_COLORS), // 随机毛色型号
          radius: t.radius, maxHp: t.maxHp,
          x: 0, z: 0, y: 0, vy: 0, kx: 0, kz: 0,
          yaw: Math.random() * 6.28, hp: t.maxHp, score: 0,
          state: 'idle', timer: Math.random() * 2, target: { x: 0, z: 0 },
          fleeFrom: { x: 0, z: 0 },
          lastPeck: -9, peckAnim: 0, deadUntil: 0,
          inp: { mx: 0, mz: 0, run: false, jump: false, yaw: 0, radius: t.radius }
        };
        // 探针鸡 / 网站鸡都用稳定 key 派生随机毛色（同一目标花色固定，不随负载变）
        n.color = chickLookIndex(probeKey, stats);
        // 离线的机器一开始就躺倒：给它一个不会过期的 deadUntil
        if (!online) n.deadUntil = Infinity;
        this.spawnAt(n, (Math.random() * 2 - 1) * (WORLD_HALF - 6), (Math.random() * 2 - 1) * (WORLD_HALF - 6));
        this.npcs.set(id, n);
        console.log(`[probe] ${online ? '小鸡入栏' : '小鸡离线躺倒'}: ${n.name}`);
      }
      // 在线状态变化：从在线→离线时立刻躺倒；恢复在线时立刻站起来
      if (online && n.deadUntil === Infinity) {
        n.deadUntil = 0;
        n.hp = n.maxHp;
        n.state = 'idle';
        n.timer = 1;
        console.log(`[probe] 恢复在线: ${n.name}`);
      } else if (!online && n.deadUntil !== Infinity) {
        n.deadUntil = Infinity;
        n.hp = 0;
        console.log(`[probe] 转为离线: ${n.name}`);
      }
      // 名字跟随探针数据刷新：面板改名、适配器修复、或首轮 /api/nodes
      // 元数据偶发失败（cfvpsmon 静默回退 agent 上报名）——都不能让鸡名
      // 永远停在第一次创建时的值。roster 下发后前端检测 info.name 变化自动重绘。
      const wantName = `探针鸡·${safeText(s.name || probeKey)}`;
      if (n.name !== wantName) n.name = wantName;
      // 体型跟随负载变化（毛色已随机固定，不再随 CPU 变动）
      if (type === 'chick' && online) {
        const scale = chickScale(stats);
        const look = chickLookIndex(probeKey, stats);
        if (n.color !== look) n.color = look; // 仅纠正历史/兜底值，正常情况下恒定
        if (n.scale !== scale) n.scale = scale;
      }
      n.stats = stats;
    }
    this.broadcastRoster();
  }

  // 在指定坐标附近生成（避开障碍）
  spawnAt(n, x, z) {
    for (let i = 0; i < 20; i++) {
      n.x = x + (Math.random() * 2 - 1) * 2;
      n.z = z + (Math.random() * 2 - 1) * 2;
      n.y = 0; n.vy = 0; n.kx = 0; n.kz = 0;
      const before = { x: n.x, z: n.z };
      resolveCircle(n, (n.radius || CONF.radius) + 0.1, this.obstacles);
      if (Math.hypot(before.x - n.x, before.z - n.z) < 0.01) {
        n.y = groundHeight(n.x, n.z);
        return;
      }
    }
    n.y = groundHeight(n.x, n.z);
  }

  // 追击判定：鹅只盯玩家；探针小鸡见谁啄谁（玩家、鹅、同伴）
  findPrey(n, now, radius) {
    let best = null, bd = 1e9;
    const consider = (e) => {
      if (!e || e.id === n.id || e.deadUntil > now) return;
      if (e.deadUntil === Infinity) return; // 离线躺倒的鸡不可选中
      const d = Math.hypot(e.x - n.x, e.z - n.z);
      if (d < bd) { bd = d; best = e; }
    };
    for (const p of this.players.values()) consider(p);
    if (n.type === 'chick') for (const q of this.npcs.values()) consider(q);
    return bd <= radius ? best : null;
  }

  npcPeck(n, now, victim) {
    const t = NPC_TYPE[n.type];
    if (now - n.lastPeck < t.peckCd) return;
    n.lastPeck = now;
    n.peckAnim = CONF.peckAnim;
    this.evQueue.push({ e: 'peck', f: n.id });
    const dx = victim.x - n.x, dz = victim.z - n.z;
    const d = Math.hypot(dx, dz) || 1;
    victim.hp -= t.peckDamage;
    victim.kx += (dx / d) * t.peckKnock;
    victim.kz += (dz / d) * t.peckKnock;
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.deadUntil = now + CONF.koTime;
      // 大鹅军团共享战绩；探针小鸡各记各的
      if (n.type === 'goose') {
        for (const g of this.npcs.values()) {
          if (g.type === 'goose') g.score++;
        }
      } else {
        n.score++;
      }
      this.evQueue.push({ e: 'ko', f: n.id, t: victim.id });
    } else {
      this.evQueue.push({ e: 'hit', f: n.id, t: victim.id, hp: victim.hp });
    }
  }

  // ---- 消息处理 ----------------------------------------------------------

  onMessage(p, data) {
    if (p.ws.readyState !== 1) return;
    const bytes = Number(data?.byteLength ?? data?.length ?? 0);
    p.ws._bytes = (p.ws._bytes || 0) + bytes;
    if (++p.ws._msgs > 120 || p.ws._bytes > 128 * 1024) {
      try { p.ws.close(1008, 'rate-limit'); } catch { /* ignore */ }
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'i') {
      const clamp = (v) => Math.max(-1, Math.min(1, +v || 0));
      p.inp.mx = clamp(m.mx);
      p.inp.mz = clamp(m.mz);
      p.inp.run = !!m.run;
      const wasJump = p.inp.jump;
      p.inp.jump = !!m.jump;
      // 短按（按下+松开都落在同一个 50ms tick 内）会被电平采样整个丢掉，
      // 客户端却逐帧预测跳了 → 快照回拉 = 抽搐。锁存一次「按下事件」，
      // 由下一个 tick 的 stepBody 一次性消费（physics.js 的 inp.jumpPress）。
      if (p.inp.jump && !wasJump) p.inp.jumpPress = true;
      p.inp.yaw = Math.max(-Math.PI, Math.min(Math.PI, +m.yaw || 0));
    } else if (m.t === 'hello') {
      // 断线重连握手：带令牌则恢复原身份与战绩
      this.tryResume(p, m.token);
    } else if (m.t === 'p') {
      this.tryPeck(p);
    } else if (m.t === 'w') {
      this.tryWing(p);
    } else if (m.t === 'profile') {
      this.tryProfile(p, m);
    }
  }

  // 自定义资料：改名。校验通过后更新展示名并全服广播（换图标功能已移除）。
  tryProfile(p, m) {
    const now = Date.now();
    if (now - (p._lastProfile || 0) < 1000) return; // 1 秒冷却，防刷
    p._lastProfile = now;
    if (m.name === undefined) return;
    const v = validCustomName(m.name);
    if (!v) return;
    p.customName = v;
    p.name = v; // 旧版组合过图标前缀的名字，改名时自然回归纯名字
    this.broadcastRoster();
  }

  // 扇形命中判定（玩家与 NPC 通用）
  inArc(p, tx, tz) {
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > CONF.peckRange + CONF.radius) return false;
    if (dist < 0.01) return true;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    return (dx / dist) * fx + (dz / dist) * fz >= Math.cos(CONF.peckArc / 2);
  }

  tryPeck(p) {
    const now = this.time;
    if (p.deadUntil > now) return;
    if (now - p.lastPeck < CONF.peckCooldown) return;
    p.lastPeck = now;
    p.peckAnim = CONF.peckAnim;
    p.inp.yaw = p.yaw; // 啄向当前朝向
    this.evQueue.push({ e: 'peck', f: p.id });

    for (const q of this.players.values()) {
      if (q.id === p.id || q.deadUntil > now || !this.inArc(p, q.x, q.z)) continue;
      this.damagePlayer(p, q, CONF.peckDamage, CONF.peckKnock);
    }
    this.damageNpcs(p, CONF.peckRange + CONF.radius, CONF.peckDamage, CONF.peckKnock);
  }

  tryWing(p) {
    const now = this.time;
    if (p.deadUntil > now) return;
    if (now - p.lastWing < CONF.wingCooldown) return;
    p.lastWing = now;
    p.wingAnim = CONF.wingAnim;
    this.evQueue.push({ e: 'wing', f: p.id });

    // 无方向限制的周身范围
    for (const q of this.players.values()) {
      if (q.id === p.id || q.deadUntil > now) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d <= CONF.wingRange + CONF.radius) {
        this.damagePlayer(p, q, CONF.wingDamage, CONF.wingKnock);
      }
    }
    this.damageNpcs(p, CONF.wingRange + CONF.radius, CONF.wingDamage, CONF.wingKnock);
  }

  damagePlayer(attacker, q, dmg, knock) {
    const dx = q.x - attacker.x, dz = q.z - attacker.z;
    const d = Math.hypot(dx, dz) || 1;
    q.hp -= dmg;
    q.kx += (dx / d) * knock;
    q.kz += (dz / d) * knock;
    if (q.hp <= 0) {
      q.hp = 0;
      q.deadUntil = this.time + CONF.koTime;
      attacker.score++;
      this.evQueue.push({ e: 'ko', f: attacker.id, t: q.id });
    } else {
      this.evQueue.push({ e: 'hit', f: attacker.id, t: q.id, hp: q.hp });
    }
  }

  // 玩家攻击命中动物：造成伤害；大鹅吓跑；探针鸡 2/3 还击追咬、1/3 吓得疾跑逃命
  // （自卫不受 CPU 门控限制）
  damageNpcs(attacker, range, dmg, knock) {
    const now = this.time;
    for (const n of this.npcs.values()) {
      if (n.deadUntil === Infinity) continue; // 离线躺倒的鸡不可被啄
      if (n.deadUntil > now) continue;
      const dx = n.x - attacker.x, dz = n.z - attacker.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d > range + n.radius) continue;
      n.hp -= dmg;
      n.kx += (dx / d) * knock * 0.6; // 动物体重大，击退稍弱
      n.kz += (dz / d) * knock * 0.6;
      if (n.hp <= 0) {
        n.hp = 0;
        n.deadUntil = now + CONF.koTime;
        attacker.score++;
        this.evQueue.push({ e: 'ko', f: attacker.id, t: n.id });
      } else if (n.type === 'chick' || n.type === 'web') {
        // 被啄的探针鸡：2/3 进入还击状态追咬攻击者；1/3 吓得疾跑逃命（更快但更短）
        if (n.type === 'chick' && Math.random() < 1 / 3) {
          n.state = 'flee';
          n.fleeFrom = { x: attacker.x, z: attacker.z };
          n.timer = NPC_TYPE.chick.sprintTime;
          n.sprintUntil = now + NPC_TYPE.chick.sprintTime;
        } else {
          n.state = 'chase';
          n.retaliate = true;
          n.timer = 3;
        }
      } else {
        n.state = 'flee';
        n.timer = 2.2;
      }
      this.evQueue.push({ e: 'hit', f: attacker.id, t: n.id, hp: n.hp });
    }
  }

  // ---- 模拟主循环（20Hz）-------------------------------------------------

  spawn(p) {
    for (let i = 0; i < 20; i++) {
      p.x = (Math.random() * 2 - 1) * (WORLD_HALF - 4);
      p.z = (Math.random() * 2 - 1) * (WORLD_HALF - 4);
      p.y = 0; p.vy = 0; p.kx = 0; p.kz = 0;
      const before = { x: p.x, z: p.z };
      resolveCircle(p, CONF.radius + 0.1, this.obstacles);
      if (Math.hypot(before.x - p.x, before.z - p.z) < 0.01) { // 没被推出=没卡进障碍
        p.y = groundHeight(p.x, p.z);
        return;
      }
    }
  }

  update(dt) {
    const now = this.time;
    this.time += dt;
    this.tick++;

    const alive = [];
    for (const p of this.players.values()) {
      if (p.deadUntil > 0 && now >= p.deadUntil) {
        p.deadUntil = 0;
        p.hp = CONF.maxHp;
        this.spawn(p);
      }
      if (p.deadUntil > now) continue;
      stepBody(p, p.inp, this.obstacles, dt);
      p.yaw = p.inp.yaw;
      p.peckAnim = Math.max(0, p.peckAnim - dt);
      p.wingAnim = Math.max(0, p.wingAnim - dt);
      alive.push(p);
    }

    for (const n of this.npcs.values()) {
      this.updateNpc(n, dt, now);
      // 离线躺倒的探针鸡不参与碰撞分离，玩家可以直接走过去（不挡路、不卡位）
      if (n.deadUntil !== Infinity) alive.push(n);
    }

    // 实体间软分离：以速度冲量代替硬推位置——重叠时可以互相挤过去，
    // 不会再被别的鸡卡住不能移动。冲量随重叠程度增大，挤过人群有阻力感。
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz) || 1e-6;
        const min = (a.radius || CONF.radius) + (b.radius || CONF.radius);
        if (d >= min) continue;
        const overlap = (min - d) / min;
        const impulse = overlap * CONF.separation * dt;
        const nx = dx / d, nz = dz / d;
        a.kx -= nx * impulse; a.kz -= nz * impulse;
        b.kx += nx * impulse; b.kz += nz * impulse;
      }
    }

    this.broadcastSnapshot(now);
    this.evQueue = [];
  }

  buildStateBits(p, now) {
    let st = 0;
    // 离线探针鸡永远呈倒地姿态（deadUntil 为 Infinity）
    if (p.deadUntil === Infinity) return ST_DEAD;
    if (p.deadUntil > now) return ST_DEAD;
    if (p.peckAnim > 0) st |= ST_PECK;
    if (p.wingAnim > 0) st |= ST_FLAP;
    if (p.y > groundHeight(p.x, p.z) + 0.05) st |= ST_AIR;
    const speed = Math.hypot(p.inp.mx, p.inp.mz);
    if (speed > 0.05) st |= (p.inp.run ? ST_RUN : ST_WALK);
    return st;
  }

  sendSocket(ws, message) {
    if (!ws || ws.readyState !== 1) return;
    // 慢客户端不能无限堆积服务器发送缓冲；主动断开比拖垮整个模拟循环安全。
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      try { ws.close(1013, 'slow-client'); } catch { /* ignore */ }
      return;
    }
    try { ws.send(message); } catch { /* ignore */ }
  }

  broadcastSnapshot(now) {
    const ps = [];
    for (const p of this.players.values()) {
      ps.push([
        p.id,
        +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +p.yaw.toFixed(2),
        this.buildStateBits(p, now),
        p.hp, p.score
      ]);
    }
    for (const n of this.npcs.values()) {
      ps.push([
        n.id,
        +n.x.toFixed(2), +n.y.toFixed(2), +n.z.toFixed(2),
        +n.yaw.toFixed(2),
        this.buildStateBits(n, now),
        n.hp, n.score
      ]);
    }
    const ev = this.evQueue;
    const msg = JSON.stringify({ t: 's', tick: this.tick, ps, ev });
    for (const p of this.players.values()) {
      this.sendSocket(p.ws, msg);
    }
  }

  broadcastRoster() {
    const list = [];
    for (const p of this.players.values()) {
      list.push({
        id: p.id, name: p.name, color: p.colorIdx, scale: p.scale || 1,
        flag: this.exposeVisitorGeo ? p.geo.code : null,
        asn: this.exposeVisitorGeo ? p.geo.asn : null,
        asName: this.exposeVisitorGeo ? p.geo.asName : null
      });
    }
    for (const n of this.npcs.values()) {
      const offline = n.deadUntil === Infinity;
      list.push({
        id: n.id, name: n.name, color: n.color, scale: n.scale || 1, flag: null, asn: null,
        npc: true, type: n.type, maxHp: n.maxHp, stats: n.stats || null, offline
      });
    }
    const left = [];
    for (const rec of this.leftPlayers.values()) left.push({ id: rec.id, name: rec.name, score: rec.score });
    const msg = JSON.stringify({ t: 'r', list, probe: this.probeHealth, left });
    for (const p of this.players.values()) {
      this.sendSocket(p.ws, msg);
    }
  }

  send(p, obj) {
    this.sendSocket(p.ws, JSON.stringify(obj));
  }
}
