// 归一化工具箱
// 目标：把七种探针各不相同的字段名、单位、表达方式，收敛成同一套语义。
// 所有上层逻辑只认这里的单位约定：
//   容量 → 字节(B)   速率 → B/s   累计流量 → B   时长 → 秒   时间戳 → epoch 毫秒

/** 安全数字：能转成有限数就转，否则 null（绝不返回 NaN 污染后续运算） */
export function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 数字，缺省补 0（用于"必须有个数"的场合） */
export function num0(v) {
  const n = num(v);
  return n === null ? 0 : n;
}

// ---- 单位换算 ----
export const KB = 1024;
export const MB = 1024 * 1024;
export const GB = 1024 * 1024 * 1024;
export const TB = 1024 * 1024 * 1024 * 1024;

export const kb = v => { const n = num(v); return n === null ? null : n * KB; };
export const mb = v => { const n = num(v); return n === null ? null : n * MB; };
export const gb = v => { const n = num(v); return n === null ? null : n * GB; };

/**
 * 时间戳归一到 epoch 毫秒。
 * 需要处理四种输入：
 *   - 秒级数字（ServerStatus `latest_ts`）
 *   - 毫秒数字（CF探针 `last_updated`）
 *   - 数字字符串（CF探针 `boot_time` = "1789690370000"）
 *   - ISO8601 字符串（Komari `time`）
 */
export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    // < 1e11 视为秒（1e11 秒 ≈ 公元 5138 年，1e11 毫秒 ≈ 1973 年，分界安全）
    return v < 1e11 ? v * 1000 : v;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * 运行时长 → 秒。
 * ServerStatus 给的是本地化字符串（"1 天" / "8 天" / "3 小时" / "12 分"），
 * 极简探针/Komari 给的是秒数，CF探针给的是开机时间戳（由调用方换算）。
 */
const UPTIME_UNITS = [
  [/年|y(ear)?s?\b/i, 365 * 86400],
  [/月|mo(nth)?s?\b/i, 30 * 86400],
  [/天|日|d(ay)?s?\b/i, 86400],
  [/小时|时|h(our)?s?\b/i, 3600],
  [/分(钟)?|m(in(ute)?s?)?\b/i, 60],
  [/秒|s(ec(ond)?s?)?\b/i, 1],
];

export function uptimeToSec(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v; // 已是秒
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);            // 数字字符串
  let total = 0;
  let matched = false;
  // 形如 "1 天 2 小时" / "3d 4h" / "12 分"
  const re = /(\d+(?:\.\d+)?)\s*([^\d\s]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    const unit = m[2];
    const hit = UPTIME_UNITS.find(([rx]) => rx.test(unit));
    if (hit) { total += n * hit[1]; matched = true; }
  }
  if (!matched) {
    const only = Number(s.match(/\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(only) ? only : null;
  }
  return Math.round(total);
}

/**
 * 负载归一到 [1m, 5m, 15m]。
 * 各类型的表达：
 *   - ServerStatus: `load`(单值) 或 `load_1/load_5/load_15`
 *   - CF探针:       `load_avg` = "0.00 0.00 0.00"
 *   - 极简探针:     `metrics.load` = [1,5,15]
 *   - Komari:       `load` / `load5` / `load15`
 */
export function normLoad(rec, { single, three, arr, str } = {}) {
  if (arr) {
    const a = rec[arr];
    if (Array.isArray(a) && a.length >= 3) {
      const [x, y, z] = a.map(num);
      if (x !== null || y !== null || z !== null) return [x, y, z];
    }
  }
  if (three) {
    const keys = Array.isArray(three) ? three : [three];
    const x = num(rec[keys[0]]), y = num(rec[keys[1]]), z = num(rec[keys[2]]);
    if (x !== null || y !== null || z !== null) return [x, y, z];
  }
  if (str) {
    const s = rec[str];
    if (typeof s === 'string') {
      const parts = s.trim().split(/\s+/).map(Number);
      if (parts.length >= 3 && parts.every(Number.isFinite)) return parts.slice(0, 3);
      if (parts.length === 1 && Number.isFinite(parts[0])) return [parts[0], parts[0], parts[0]];
    }
  }
  if (single) {
    const x = num(rec[single]);
    if (x !== null) return [x, x, x];
  }
  return null;
}

/** 布尔：兼容 true/false、"1"/"0"、1/0、"true" */
export function bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === '') return false;
  }
  return null;
}

/** 取第一个"有值"的字段（跳过 undefined/null/''），用于同义字段兜底 */
export function pick(rec, ...keys) {
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** 稳定 key：优先显式 id，退化用名字 */
export function makeKey(rec, idKeys = [], nameKeys = ['name']) {
  for (const k of idKeys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  for (const k of nameKeys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return 'unknown';
}

// ---- 地区码 ----
// 多个类型会直接返回 emoji 国旗（"🇭🇰🇨🇳"），需要转成规范码。
// 只覆盖常见机房地区；未命中的保留原文，交给上层展示。
const FLAG_TO_CODE = {
  '🇭🇰': 'HK', '🇨🇳': 'CN', '🇹🇼': 'TW', '🇲🇴': 'MO', '🇯🇵': 'JP', '🇰🇷': 'KR',
  '🇸🇬': 'SG', '🇺🇸': 'US', '🇬🇧': 'UK', '🇩🇪': 'DE', '🇫🇷': 'FR', '🇳🇱': 'NL',
  '🇷🇺': 'RU', '🇨🇦': 'CA', '🇦🇺': 'AU', '🇮🇳': 'IN', '🇧🇷': 'BR', '🇮🇹': 'IT',
  '🇪🇸': 'ES', '🇸🇪': 'SE', '🇨🇭': 'CH', '🇫🇮': 'FI', '🇳🇴': 'NO', '🇩🇰': 'DK',
  '🇵🇱': 'PL', '🇹🇷': 'TR', '🇻🇳': 'VN', '🇹🇭': 'TH', '🇲🇾': 'MY', '🇮🇩': 'ID',
  '🇵🇭': 'PH', '🇿🇦': 'ZA', '🇦🇪': 'AE', '🇮🇱': 'IL', '🇺🇦': 'UA', '🇦🇷': 'AR',
  '🇲🇽': 'MX', '🇳🇿': 'NZ', '🇮🇪': 'IE', '🇦🇹': 'AT', '🇧🇪': 'BE', '🇨🇿': 'CZ',
  '🇭🇺': 'HU', '🇷🇴': 'RO', '🇬🇷': 'GR', '🇵🇹': 'PT', '🇱🇺': 'LU', '🇮🇸': 'IS',
  '🇪🇪': 'EE', '🇱🇻': 'LV', '🇱🇹': 'LT', '🇰🇿': 'KZ', '🇸🇦': 'SA', '🇪🇬': 'EG',
  '🇳🇬': 'NG', '🇰🇪': 'KE', '🇨🇱': 'CL', '🇵🇪': 'PE', '🇨🇴': 'CO', '🇺🇾': 'UY',
};

/** 把可能含 emoji 国旗的字符串转成规范地区码；已是码则原样返回 */
export function normRegion(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // 已是 2 位码
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  // 含 emoji 国旗：逐个替换，保留可见的部分
  let out = s;
  let hit = null;
  for (const [flag, code] of Object.entries(FLAG_TO_CODE)) {
    if (out.includes(flag)) { hit = code; out = out.split(flag).join(''); }
  }
  out = out.replace(/\p{Extended_Pictographic}/gu, '').trim();
  if (hit) return hit;          // 有旗帜就以旗帜为准
  if (out && /^[A-Za-z]{2}$/.test(out)) return out.toUpperCase();
  // 「城市, 州, 国家码」/「城市, 国家码」形式（CF VPS Monitor 的 region 字段就是
  //  "Los Angeles, California, US" / "Hong Kong, HK"）：取最后一段的国家码。
  //  不提取的话原文会原样漏到前端，画名牌时整串压在名字上（第 56 轮实机 OCR 证据）。
  const parts = out.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2 && /^[A-Za-z]{2}$/.test(parts[parts.length - 1])) {
    return parts[parts.length - 1].toUpperCase();
  }
  return out || null;           // 中文地名之类，原样返回
}

/** 延迟：多网取"最小非零值"（0 表示该线路无数据） */
export function bestPing(...vals) {
  let min = Infinity;
  for (const value of vals) {
    const n = num(value);
    if (n !== null && n > 0 && n < min) min = n;
  }
  return min === Infinity ? null : min;
}
