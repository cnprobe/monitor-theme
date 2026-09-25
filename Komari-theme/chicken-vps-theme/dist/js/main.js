// 总装：渲染器、第三人称操控、本地预测 + 远端插值、事件表现、HUD/遮罩流程。

import * as THREE from 'three';
import { CONF, WORLD_HALF, ST_DEAD, ST_PECK, ST_AIR, ST_RUN, ST_WALK, ST_FLAP, stepBody, groundHeight, buildObstacles, resolveCircle } from '/shared/physics.js';
import { Net } from './net.js';
import { KomariBrowserClient } from './komari-client.js';
import { buildScene, buildWorld } from './world.js';
import { Chicken } from './chicken.js';
import { Npc } from './npc.js';
import { Feathers } from './feathers.js';
import { Sfx } from './sfx.js';
import { HUD } from './hud.js';
import { createTouchControls, buildTouchUi, isTouchDevice, hasPointerEvents } from './touch.js';

const $ = (id) => document.getElementById(id);

// 移动端：窄屏用更远的机位与更俯的视角，否则鸡会占满屏幕、看不到四周
const compact = Math.min(innerWidth, innerHeight) < 720 || innerWidth < 820;
const TOUCH = isTouchDevice() && hasPointerEvents();
document.body.classList.toggle('touch', TOUCH);

// 画质分级：手机 dpr 常是 3，按 2 渲染像素量是 4 倍，压到 1.5 肉眼差别很小；
// MSAA 在高 dpr 屏上收益递减，compact 设备关掉换流畅。
const renderer = new THREE.WebGLRenderer({ antialias: !compact, preserveDrawingBuffer: true });
renderer.setPixelRatio(compact ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$('app').appendChild(renderer.domElement);

const { scene, camera } = buildScene(renderer, { lowPower: compact });
const net = new Net();
const komari = new KomariBrowserClient();
const hud = new HUD();
const sfx = new Sfx();
const feathers = new Feathers(scene);

let myId = null, worldBuilt = false;
const roster = new Map();          // id -> {name,color,flag,...}
const chickens = new Map();        // id -> Chicken
const localProbeIds = new Set();
const localProbeStates = new Map();
let directProbeHealth = null;
let directUnauthorizedNoticeShown = false;
let obstacles = [];
const snapBuf = [];                // {t, ps:Map(id -> entry)}
const RENDER_DELAY = 130;

// 本地预测状态
const body = { x: 0, y: 0, z: 0, vy: 0, kx: 0, kz: 0 };
let localYaw = 0;
let localPeckT = 0, localPeckCd = 0, localWingT = 0, localWingCd = 0, koStartT = -9;

// 相机
let camYaw = 0.6, camPitch = compact ? 0.58 : 0.42, camDist = compact ? 6.4 : 5;
const CAM_DIST_MIN = compact ? 3.2 : 2.4, CAM_DIST_MAX = compact ? 11 : 9;
const camTarget = new THREE.Vector3(0, 1, 0);
// 主循环复用的临时向量（每帧 new 两个 Vector3 是纯 GC 垃圾）
const _camGoal = new THREE.Vector3();
const _camOff = new THREE.Vector3();

// 输入
const keys = {};
let locked = false;
let dragging = false, dragMoved = 0;
const moveInput = { mx: 0, mz: 0, run: false, jump: false };

// 触屏操控层（桌面端返回 null；此时下面所有 tc.* 访问都用可选链兜底）
const touchRoot = TOUCH ? buildTouchUi($('touch-ui')) : null;
const tc = touchRoot ? createTouchControls({
  root: touchRoot,
  canvas: renderer.domElement,
  camera: {
    get yaw() { return camYaw; },
    set yaw(v) { camYaw = v; },
    get pitch() { return camPitch; },
    set pitch(v) { camPitch = v; },
  },
  action: (name) => { if (name === 'peck') peck(); else if (name === 'wing') wing(); },
  onFirstGesture: () => sfx.init(),
  // moveInput.run 由 renderFrame 每帧从 keys/tc.run 合成，这里只做视觉反馈
  onRunToggle: (on) => document.body.classList.toggle('running', on),
}) : null;

// ---------- 工具 ----------
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function dist2Me(x, z) { return Math.hypot(x - body.x, z - body.z); }

function stableHash(value) {
  let hash = 2166136261;
  const source = String(value || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function updateProbeHealth() {
  if (directProbeHealth) hud.setProbeHealth(directProbeHealth);
}

function spawnLocalProbeState(id, key) {
  const hash = stableHash(key);
  const angle = (hash % 360) * Math.PI / 180;
  const radius = 6 + ((hash >>> 8) % 150) / 10;
  const state = {
    body: { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius, vy: 0, kx: 0, kz: 0 },
    inp: { mx: 0, mz: 0, run: false, jump: false, yaw: angle + Math.PI, pid: id },
    turn: 1 + (hash % 240) / 100,
    turnIndex: 0,
  };
  resolveCircle(state.body, CONF.radius, obstacles);
  state.body.y = groundHeight(state.body.x, state.body.z);
  localProbeStates.set(id, state);
  return state;
}

function removeLocalProbeNodes() {
  for (const id of [...localProbeIds]) {
    chickens.get(id)?.dispose(scene);
    chickens.delete(id);
    roster.delete(id);
    localProbeStates.delete(id);
  }
  localProbeIds.clear();
  if (!net.connected || myId === 'local') hud.update(Array.from(localSnapshot().values()), roster);
  updateProbeHealth();
}

function localSnapshot() {
  const snapshot = new Map();
  if (myId === 'local') snapshot.set('local', ['local', body.x, body.y, body.z, localYaw, 0, CONF.maxHp, 0]);
  for (const id of localProbeIds) {
    const state = localProbeStates.get(id);
    const info = roster.get(id);
    if (!state || !info) continue;
    snapshot.set(id, [id, state.body.x, state.body.y, state.body.z, state.inp.yaw, info.offline ? ST_DEAD : 0, 100, 0]);
  }
  return snapshot;
}

function syncLocalProbeNodes(nodes) {
  if (!worldBuilt) ensureLocalWorld();
  const seen = new Set();
  const usedIds = new Set([...chickens.keys()].filter(id => Number(id) > 0));
  for (const node of nodes) {
    if (!node?.key || seen.has(node.key)) continue;
    seen.add(node.key);
    // Map 以负数 id 为键；通过稳定 key 找到已有模型，避免每次刷新更换实体 id。
    let id = null;
    for (const candidate of localProbeIds) {
      if (localProbeStates.get(candidate)?.key === node.key) { id = candidate; break; }
    }
    if (id === null) {
      let hash = stableHash(node.key) & 0x7fffffff;
      id = -(hash + 1);
      while (usedIds.has(id) || chickens.has(id)) id -= 1;
      usedIds.add(id);
      localProbeIds.add(id);
      const state = spawnLocalProbeState(id, node.key);
      state.key = node.key;
    }
    const cpu = Math.max(0, Math.min(100, Number(node.cpu) || 0));
    const info = {
      id,
      name: String(node.name || node.key).slice(0, 120),
      color: stableHash(`color:${node.key}`) % 5,
      scale: +(1 + cpu / 100 * 0.35).toFixed(3),
      flag: null,
      asn: null,
      asName: null,
      source: 'komari', readonly: true, networked: false, collidable: false,
      npc: true,
      type: 'node',
      maxHp: 100,
      stats: node,
      offline: node.online !== true,
    };
    roster.set(id, info);
    let chicken = chickens.get(id);
    if (!chicken) {
      chicken = new Chicken(info.color, info, false);
      chicken.ready = true;
      const state = localProbeStates.get(id);
      if (state) {
        chicken.group.position.set(state.body.x, state.body.y, state.body.z);
        chicken.group.rotation.y = state.inp.yaw;
      }
      chickens.set(id, chicken);
      scene.add(chicken.group);
    } else {
      chicken.setInfo(info);
    }
    chicken.setScale?.(info.scale);
  }
  for (const id of [...localProbeIds]) {
    if (!seen.has(localProbeStates.get(id)?.key)) {
      chickens.get(id)?.dispose(scene);
      chickens.delete(id);
      roster.delete(id);
      localProbeStates.delete(id);
      localProbeIds.delete(id);
    }
  }
  if (!net.connected || myId === 'local') hud.update(Array.from(localSnapshot().values()), roster);
}

function updateLocalProbeChicks(dt) {
  for (const id of localProbeIds) {
    const chicken = chickens.get(id);
    const info = roster.get(id);
    const state = localProbeStates.get(id);
    if (!chicken || !info || !state) continue;
    if (info.offline) {
      chicken.group.position.set(state.body.x, state.body.y, state.body.z);
      chicken.update(dt, ST_DEAD, 0, state.body.y);
      continue;
    }
    state.turn -= dt;
    if (state.turn <= 0) {
      state.turnIndex += 1;
      const hash = stableHash(`${info.stats?.key || id}:${state.turnIndex}`);
      const angle = (hash % 360) * Math.PI / 180;
      state.inp.mx = Math.cos(angle);
      state.inp.mz = Math.sin(angle);
      state.inp.yaw = Math.atan2(state.inp.mx, state.inp.mz);
      state.turn = 1.5 + ((hash >>> 8) % 250) / 100;
    }
    state.inp.speed = 0.7 + Math.min(1.5, (Number(info.stats?.cpu) || 0) / 100);
    stepBody(state.body, state.inp, obstacles, dt);
    chicken.group.position.set(state.body.x, state.body.y, state.body.z);
    chicken.group.rotation.y = state.inp.yaw;
    chicken.update(dt, ST_WALK, state.inp.speed, state.body.y);
  }
}

function applyThemeSettings(data) {
  const settings = data.theme_settings || {};
  const siteName = String(data.sitename || 'Komari 养鸡场').trim();
  $('site-name').textContent = siteName;
  document.title = `${siteName} · 养鸡VPS`;

  const labelMode = ({ '完整': 'full', '精简': 'compact', '关闭': 'off', full: 'full', compact: 'compact', off: 'off' })[settings.label_mode] || 'full';
  document.body.dataset.labelMode = labelMode;
  for (const chicken of chickens.values()) chicken.drawPlate?.();

  sfx.muted = settings.sound_enabled === false;
  document.body.classList.toggle('hide-controls', settings.show_controls === false);
  komari.configure({
    probe_limit: settings.probe_limit,
    probe_order: settings.probe_order,
    probe_refresh_seconds: settings.probe_refresh_seconds,
    seed: `${location.host}:${siteName}`,
  });
  void komari.start();
  if (!net.name && settings.player_name) net.name = String(settings.player_name).slice(0, 12);
  if (!worldBuilt) hud.setMe(net.name || settings.player_name || '小鸡');
}

function ensureLocalWorld() {
  if (!worldBuilt) {
    const half = WORLD_HALF;
    obstacles = buildObstacles();
    buildWorld(scene, { half, obstacles });
    worldBuilt = true;
  }

  if (myId === null) {
    myId = 'local';
    hud.myId = myId;
    const info = {
      id: myId,
      name: net.name || '本地小鸡',
      color: 0,
      npc: false,
      scale: 1,
    };
    const chicken = new Chicken(info.color, info, true);
    chicken.ready = true;
    chicken.group.position.set(body.x, body.y, body.z);
    chickens.set(myId, chicken);
    roster.set(myId, info);
    scene.add(chicken.group);
  }
  hud.setMultiplayerActive(false);
  hud.onProfile = (patch) => {
    if (net.sendProfile(patch.name)) hud.setMe(net.name);
  };
  hud.setBridgeState('missing', '单机模式');
  hud.setMe(net.name || '本地小鸡');
  hud.setSelfState(CONF.maxHp, 0, 0);
}

// ---------- 网络 ----------
komari.on('nodes', nodes => syncLocalProbeNodes(nodes));
komari.on('health', health => {
  directProbeHealth = health;
  updateProbeHealth();
  if (health?.ok) directUnauthorizedNoticeShown = false;
  if (health?.unauthorized) {
    removeLocalProbeNodes();
    if (!directUnauthorizedNoticeShown) {
      directUnauthorizedNoticeShown = true;
      hud.banner('请先登录 Komari，或使用有效的临时分享链接打开主题', 7000);
    }
  }
});

net.on('settings', applyThemeSettings);
net.on('bridge', (state, detail) => {
  hud.setBridgeState(state, detail);
  if (state === 'error' || state === 'reconnecting' || state === 'missing') {
    hud.setMultiplayerActive(false);
  }
  if ((state === 'error' || state === 'reconnecting') && !worldBuilt) {
    ensureLocalWorld();
    hud.setBridgeState(state, detail);
  }
});
net.on('bridge-unavailable', () => {
  ensureLocalWorld();
  hud.banner('未配置多人服务：当前为单机模式，Komari 监控数据仍由浏览器读取', 6000);
});
net.on('bridge-error', (message) => {
  hud.banner(`伴生服务：${message.message || '未知错误'}`, 5000);
});

net.on('welcome', (m) => {
  if (myId === 'local') {
    chickens.get('local')?.dispose(scene);
    chickens.delete('local');
    roster.delete('local');
  }
  myId = m.id;
  hud.myId = m.id;
  hud.setMultiplayerActive(true);
  obstacles = m.obstacles;
  hud.onProfile = (patch) => net.sendProfile(patch.name);
  if (!worldBuilt) { buildWorld(scene, m); worldBuilt = true; }
});

net.on('roster', (list, left) => {
  hud.setLeftBoard(left);
  const seen = new Set();
  for (const info of list) {
    seen.add(info.id);
    roster.set(info.id, info);
    let c = chickens.get(info.id);
    if (!c) {
      // Bridge roster 只包含玩家与可选大鹅。
      c = info.npc && info.type === 'goose'
        ? new Npc(info)
        : new Chicken(info.color, info, info.id === myId);
      c.ready = false;
      chickens.set(info.id, c);
      scene.add(c.group);
    } else {
      c.setInfo(info);
    }
    if (info.scale && c.setScale) c.setScale(info.scale);
    if (info.id === myId) {
      hud.setMe(info.name);
    }
  }
  for (const [id, c] of chickens) {
    if (!seen.has(id) && !localProbeIds.has(id)) { roster.delete(id); c.dispose(scene); chickens.delete(id); }
  }
});

net.on('snapshot', (m) => {
  const ps = new Map();
  for (const e of m.ps) ps.set(e[0], e);
  for (const [id, entry] of localSnapshot()) ps.set(id, entry);
  snapBuf.push({ t: performance.now(), ps });
  if (snapBuf.length > 40) snapBuf.shift();
  processEvents(m.ev || []);
  reconcile(ps.get(myId));
  // 标签页隐藏时跳过 HUD 的 DOM 写入（rAF 已停，写了也看不见，纯耗电）
  if (!document.hidden) hud.update(Array.from(ps.values()), roster);
  const mine = ps.get(myId);
  if (mine) {
    chickens.get(myId)?.setHp(mine[6]);
    const koLeft = (mine[5] & ST_DEAD) ? Math.max(0, CONF.koTime - (performance.now() - koStartT) / 1000) : 0;
    if (!document.hidden) hud.setSelfState(mine[6], mine[7], koLeft);
  }
});

net.on('drop', () => {
  hud.setMultiplayerActive(false);
  hud.banner('🔗 多人连接断开，正在重连…', 5000);
});

// 断线重连成功：服务端认出了令牌，战绩/毛色已恢复
net.on('resume', () => {
  hud.banner('🐔 欢迎回来，战绩已恢复！');
});

function processEvents(evs) {
  for (const ev of evs) {
    if (ev.e === 'peck') {
      if (ev.f === myId) sfx.peck();
      else {
        const c = chickens.get(ev.f);
        if (c && dist2Me(c.group.position.x, c.group.position.z) < 10) sfx.peck();
      }
    } else if (ev.e === 'wing') {
      if (ev.f !== myId) {
        const c = chickens.get(ev.f);
        c?.triggerFlap();
        if (c && dist2Me(c.group.position.x, c.group.position.z) < 10) sfx.flap();
      }
    } else if (ev.e === 'hit') {
      const victim = chickens.get(ev.t);
      if (!victim) continue;
      const p = victim.group.position;
      const d = dist2Me(p.x, p.z);
      victim.flash();
      victim.setHp(ev.hp);
      feathers.burst(p, 8, victim.info?.npc ? 0xe6e6da : 0xffffff);
      if (ev.t === myId) { sfx.cluck(); sfx.hit(d); }
      else if (d < 14) sfx.hit(d);
    } else if (ev.e === 'ko') {
      const victim = chickens.get(ev.t);
      const from = roster.get(ev.f)?.name || '?';
      const to = roster.get(ev.t)?.name || '?';
      if (victim) {
        victim.setHp(0);
        feathers.burst(victim.group.position, 16);
        const d = dist2Me(victim.group.position.x, victim.group.position.z);
        if (d < 18) sfx.ko(d);
      }
      if (ev.t === myId) koStartT = performance.now();
      // 击杀播报只走顶部 feed（用户要求：去掉屏幕中间的击杀横幅）。
      // 涉及自己的显示「你」；被啄晕的居中横幅（setSelfState 死亡态）不受影响。
      hud.killFeed(ev.f === myId ? '你' : from, ev.t === myId ? '你' : to);
    }
  }
}

// 本地预测与服务器权威状态的软校正（力度柔和，避免走路时的微小顿挫）
function reconcile(mine) {
  if (!mine || (mine[5] & ST_DEAD)) return;
  const dx = mine[1] - body.x, dy = mine[2] - body.y, dz = mine[3] - body.z;
  const err = Math.hypot(dx, dy, dz);
  if (err > 1.6) { body.x = mine[1]; body.y = mine[2]; body.z = mine[3]; }
  else { body.x += dx * 0.06; body.y += dy * 0.06; body.z += dz * 0.06; }
}

// ---------- 输入 ----------
addEventListener('keydown', (e) => {
  // 在输入框里打字时不捕获任何游戏按键 —— 否则 WASD 会移动、F 啄、M 切静音、
  // Space 被 preventDefault，名字框就"无法输入"了（第二十三轮踩坑）
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  keys[e.code] = true;
  // e.repeat：按住不放时浏览器以 ~30Hz 重发 keydown。
  // 移动键需要它（keys 幂等无所谓），但切换类动作必须挡掉 ——
  // 否则按住 M 会狂切静音、按住 F 会顶着冷却空发动作请求。
  if (!e.repeat) {
    if (e.code === 'KeyF') peck();
    if (e.code === 'KeyM') hud.banner(sfx.toggleMute() ? '🔇 已静音' : '🔊 声音开启', 900);
  }
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// 鼠标路径始终保留：带触摸屏的平板插上鼠标/键盘后照样能用。
// 触屏设备上**不请求指针锁定**（移动端浏览器不支持或体验很差），
// 但仍允许按住拖动转视角、右键扇翅 —— 与桌面无锁状态一致。
renderer.domElement.addEventListener('mousedown', (e) => {
  hud.closePopovers?.(); // 点回游戏画面时收起头像/改名弹层
  if (!TOUCH && !locked) renderer.domElement.requestPointerLock?.();
  if (e.button === 2) { wing(); return; }
  if (locked) { if (e.button === 0) peck(); }
  else { dragging = true; dragMoved = 0; }
});
addEventListener('mouseup', () => {
  if (dragging && !locked && dragMoved < 5) peck();
  dragging = false;
});
addEventListener('mousemove', (e) => {
  const sens = 0.0026;
  if (!locked && !dragging) return;
  if (dragging) dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
  camYaw -= e.movementX * sens;
  camPitch = Math.min(1.25, Math.max(0.06, camPitch + e.movementY * sens));
});
addEventListener('wheel', (e) => {
  camDist = Math.min(CAM_DIST_MAX, Math.max(CAM_DIST_MIN, camDist * (1 + e.deltaY * 0.001)));
}, { passive: true });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
});

function peck() {
  const now = performance.now();
  if (now - localPeckCd < CONF.peckCooldown * 1000) return;
  localPeckCd = now;
  localPeckT = CONF.peckAnim;
  net.send({ t: 'p' });
  chickens.get(myId)?.triggerPeck();
}

function wing() {
  const now = performance.now();
  if (now - localWingCd < CONF.wingCooldown * 1000) return;
  localWingCd = now;
  localWingT = CONF.wingAnim;
  net.send({ t: 'w' });
  chickens.get(myId)?.triggerFlap();
  sfx.flap();
}

// 浏览器要求音频必须在用户手势里启动：第一次点击/按键时初始化
const initAudio = () => sfx.init();
addEventListener('pointerdown', initAudio, { once: true });
addEventListener('keydown', initAudio, { once: true });

// ---------- 主循环 ----------
let lastT = performance.now();
let sendAcc = 0;

function renderFrame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  if (worldBuilt) {
    updateLocalProbeChicks(dt);
    // 输入向量（相机相对）。键盘与摇杆是**相加**的：两者都推同一方向不会叠加成
    // 双倍速度，因为 stepBody 会把长度 >1 的向量归一化。
    const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0)
      + (tc ? -tc.mz : 0);          // 摇杆向上 = 前进（屏幕 y 向下为正，故取负）
    const str = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0)
      + (tc ? tc.mx : 0);           // 摇杆向右 = 右移
    const moving = Math.abs(fwd) > 0.001 || Math.abs(str) > 0.001;
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
    moveInput.mx = moving ? fx * fwd + rx * str : 0;
    moveInput.mz = moving ? fz * fwd + rz * str : 0;
    moveInput.run = !!(keys.ShiftLeft || keys.ShiftRight) || !!tc?.run;
    moveInput.jump = !!keys.Space || !!tc?.jump;
    moveInput.pid = Number(myId) || 0; // 参与连跳段数哈希：与服务端一致（shared/physics.js）

    const me = chickens.get(myId);
    const mySnap = snapBuf.length ? snapBuf[snapBuf.length - 1].ps.get(myId) : null;
    const dead = !!(mySnap && (mySnap[5] & ST_DEAD));

    // 本地预测（死亡时冻结，等服务器复活）
    if (!dead) stepBody(body, moveInput, obstacles, dt);
    // 周围实体的软分离（与服务器同一套速度冲量公式，重叠时能挤过去不再卡位）
    if (!dead) {
      for (const [id, c] of chickens) {
        if (id === myId || localProbeIds.has(id) || !c.ready || c.offline) continue; // 浏览器监控鸡只读、不参与本地碰撞
        const p = c.group.position;
        const dx = p.x - body.x, dz = p.z - body.z;
        const d = Math.hypot(dx, dz) || 1e-6;
        const min = CONF.radius * 2;
        if (d >= min) continue;
        const overlap = (min - d) / min;
        const impulse = overlap * CONF.separation * dt;
        body.kx -= (dx / d) * impulse;
        body.kz -= (dz / d) * impulse;
      }
    }
    const sp = Math.hypot(moveInput.mx, moveInput.mz);
    if (sp > 0.05 && !dead) localYaw = lerpAngle(localYaw, Math.atan2(moveInput.mx, moveInput.mz), Math.min(1, dt * 12));
    localPeckT = Math.max(0, localPeckT - dt);
    localWingT = Math.max(0, localWingT - dt);

    if (me) {
      me.ready = true;
      me.group.position.set(body.x, body.y, body.z);
      me.group.rotation.y = localYaw;
      let bits = 0;
      if (dead) bits = ST_DEAD;
      else {
        if (localPeckT > 0) bits |= ST_PECK;
        if (localWingT > 0) bits |= ST_FLAP;
        if (body.y > groundHeight(body.x, body.z) + 0.05) bits |= ST_AIR;
        if (sp > 0.05) bits |= (moveInput.run ? ST_RUN : ST_WALK);
      }
      me.update(dt, bits, sp * (moveInput.run ? CONF.runSpeed : CONF.walkSpeed), body.y);
    }

    // 远端鸡：快照插值
    const renderT = now - RENDER_DELAY;
    let s0 = null, s1 = null;
    for (let i = snapBuf.length - 1; i >= 0; i--) {
      if (snapBuf[i].t <= renderT) { s0 = snapBuf[i]; s1 = snapBuf[i + 1] || null; break; }
    }
    if (!s0 && snapBuf.length) { s0 = snapBuf[0]; s1 = snapBuf[1] || null; }
    if (s0) {
      for (const [id, c] of chickens) {
        if (id === myId || localProbeIds.has(id) || !c.ready) continue;
        const e0 = s0.ps.get(id);
        if (!e0) continue;
        const e1 = s1 && s1.ps.get(id);
        let x = e0[1], y = e0[2], z = e0[3], yaw = e0[4], st = e0[5], speed = 0;
        if (e1) {
          const span = Math.max(1, s1.t - s0.t);
          const a = Math.min(1, Math.max(0, (renderT - s0.t) / span));
          speed = Math.hypot(e1[1] - e0[1], e1[3] - e0[3]) / (span / 1000);
          x += (e1[1] - x) * a; y += (e1[2] - y) * a; z += (e1[3] - z) * a;
          yaw = lerpAngle(e0[4], e1[4], a);
          if (e1[5] & ST_DEAD) st = e1[5];
        }
        c.group.position.set(x, y, z);
        c.group.rotation.y = yaw;
        // 把服务器给的地面高度传进去：倒地时 Chicken.update 会按翻倒角把整只鸡抬起来贴地
        c.update(dt, st, speed, y);
      }
    }
    // 新出现的远端鸡在获得首个快照后标记就绪
    if (s0) for (const [id, c] of chickens) if (id !== myId && !c.ready) c.ready = true;

    // 相机
    camTarget.lerp(_camGoal.set(body.x, body.y + 0.9, body.z), Math.min(1, dt * 14));
    _camOff.set(
      Math.sin(camYaw) * Math.cos(camPitch),
      Math.sin(camPitch),
      Math.cos(camYaw) * Math.cos(camPitch)
    ).multiplyScalar(camDist);
    camera.position.copy(camTarget).add(_camOff);
    if (camera.position.y < 0.35) camera.position.y = 0.35;
    camera.lookAt(camTarget);
  }

  feathers.update(dt);
  renderer.render(scene, camera);
  // 首帧渲染完成，撤掉加载占位
  if (!renderFrame.booted) { renderFrame.booted = true; $('boot')?.remove(); }
}

let rafAlive = false;
let fallbackTimer = null;
function frame() {
  requestAnimationFrame(frame);
  rafAlive = true;
  // 被遮挡时降级用过 setInterval 渲染；rAF 一旦恢复就停掉降级循环，否则两个循环并行双渲染
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  renderFrame(performance.now());
}
requestAnimationFrame(frame);

// 被遮挡/远程桌面的窗口里 Chromium 会挂起 rAF：500ms 还没等到帧就降级为定时器渲染
setTimeout(() => {
  if (!rafAlive) {
    console.warn('[game] rAF 被挂起（窗口被遮挡？），降级为定时器渲染');
    fallbackTimer = setInterval(() => renderFrame(performance.now()), 33);
  }
}, 500);

// 输入上报 20Hz（触屏也一样：动作按钮是事件驱动的，摇杆松开后也要让服务器知道）。
// 内容没变化就不重复发（挂机时服务器用的就是上一次的零向量），
// 1Hz 心跳兜底 —— 防前置代理把长时间无流量的 WS 当空闲连接掐掉。
let lastSentInput = '';
let lastSentAt = 0;
setInterval(() => {
  if (!net.connected) return;
  const payload = moveInput.mx.toFixed(3) + ',' + moveInput.mz.toFixed(3) + ','
    + moveInput.run + ',' + moveInput.jump + ',' + localYaw.toFixed(3);
  const now = performance.now();
  if (payload === lastSentInput && now - lastSentAt < 1000) return;
  lastSentInput = payload;
  lastSentAt = now;
  net.send({
    t: 'i',
    mx: +moveInput.mx.toFixed(3), mz: +moveInput.mz.toFixed(3),
    run: moveInput.run, jump: moveInput.jump,
    yaw: +localYaw.toFixed(3)
  });
}, 50);

let resizeRaf = 0;
addEventListener('resize', () => {
  if (resizeRaf) return;                   // 移动端地址栏收放会狂发 resize，合并到下一帧
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    tc?.measure?.();
  });
});
// 横竖屏切换后摇杆/按钮尺寸变了，再量一次（orientationchange 后布局还没稳定，故延迟）
addEventListener('orientationchange', () => setTimeout(() => tc?.measure?.(), 300));

net.connect();

// 轻量调试钩子（不影响游戏逻辑）
window.__dbg = { keys, moveInput, body, get localYaw() { return localYaw; }, touch: tc };
