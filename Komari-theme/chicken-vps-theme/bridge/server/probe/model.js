// 统一节点模型
// 所有适配器都必须产出这个形状。上层（游戏 / API / 前端）只认它。
//
// 单位约定（唯一权威，适配器负责换算）：
//   容量类 memU/memT/swapU/swapT/diskU/diskT/netIn/netOut/netMonthIn/netMonthOut  → 字节
//   速率类 netRx/netTx                                                              → B/s
//   时长类 uptime                                                                   → 秒
//   时间类 lastSeen                                                                 → epoch 毫秒
//   比率类 cpu                                                                      → 百分数 0~100

export function emptyNode(key, kind) {
  return {
    key: String(key),
    name: String(key),
    kind,                       // 'serverstatus' | 'cf' | 'minimal' | 'komari' | 'nezha' | 'nodeget' | 'nodeflare'
    online: false,

    region: null,               // 规范大区码（HK/US/…）
    location: '',               // 人类可读机房名
    os: null,
    virt: null,

    cpu: null,                  // %
    cores: null,                // 核
    load: null,                 // [1m,5m,15m]

    memU: null, memT: null,     // 字节
    swapU: null, swapT: null,   // 字节
    diskU: null, diskT: null,   // 字节

    netRx: null, netTx: null,   // B/s
    netIn: null, netOut: null,  // 字节，累计
    netMonthIn: null, netMonthOut: null, // 字节，本月

    ping: null,                 // ms，代表值
    uptime: null,               // 秒
    lastSeen: null,             // epoch ms

    // 类型特有字段原文，信息不丢
    meta: {},
  };
}

/** 数值兜底：只接受有限数，其余 null */
function n(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

const shortText = (value, max) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
  .slice(0, max);

function sanitizeMeta(value, depth = 0) {
  if (depth > 3) return null;
  if (typeof value === 'string') return shortText(value, 512);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => sanitizeMeta(item, depth + 1));
  if (typeof value !== 'object') return null;
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    const safeKey = shortText(key, 64);
    if (safeKey === '__proto__' || safeKey === 'constructor' || safeKey === 'prototype') continue;
    out[safeKey] = sanitizeMeta(item, depth + 1);
  }
  return out;
}

export function finalizeNode(node) {
  if (!node || typeof node !== 'object') return emptyNode('unknown', 'generic');
  for (const k of ['cpu', 'cores', 'memU', 'memT', 'swapU', 'swapT', 'diskU', 'diskT',
    'netRx', 'netTx', 'netIn', 'netOut', 'netMonthIn', 'netMonthOut', 'ping', 'uptime', 'lastSeen']) {
    node[k] = n(node[k]);
  }
  if (Array.isArray(node.load)) node.load = node.load.slice(0, 3).map(n);
  node.key = shortText(node.key || 'unknown', 256);
  node.name = shortText(node.name || node.key, 120);
  node.kind = shortText(node.kind || 'generic', 32);
  node.region = node.region ? shortText(node.region, 16) : null;
  node.location = shortText(node.location, 120);
  node.os = node.os ? shortText(node.os, 80) : null;
  node.virt = node.virt ? shortText(node.virt, 80) : null;
  node.meta = sanitizeMeta(node.meta);
  node.online = !!node.online;
  return node;
}

/** CPU 百分比裁剪到 0~100（有的探针会给出 >100 的瞬时值） */
export function clampCpu(v) {
  const x = n(v);
  if (x === null) return null;
  return Math.max(0, Math.min(100, x));
}
