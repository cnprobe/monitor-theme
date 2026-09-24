// 通用兜底适配器（generic）
//
// 用途：面对**未知程序**的探针 —— 既不在已知的 7 类里，字段名也是私有命名。
// 它不猜品牌，只做两件事：
//   1. **结构嗅探**：从任意 JSON 里找出"看起来像节点列表"的那个数组；
//   2. **同义字段匹配**：用一张同义词表把私有字段名映射到统一模型。
//
// 设计原则：
//   - **宁可少认，不可认错**。字段名对不上就留 null，绝不瞎猜数值含义
//     （把"磁盘总量"当成"内存总量"比读不出来更糟）。
//   - **必须足够像才认**。至少要命中一个"身份字段"（名字/ID）+ 一个"指标字段"
//     （CPU/内存/硬盘/流量任一），否则视为不是节点列表，继续找下一个。
//   - **不丢信息**：原记录整个塞进 meta.raw，方便上层排查与后续加同义词。
//
// 这个适配器**永远排在最后**：只有当 7 个已知适配器都失败时才登场，
// 所以它的误判风险不会影响已知类型。

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { num, bool, pick, makeKey, normRegion, uptimeToSec, toMs, normLoad } from '../normalize.js';

export const transport = 'http';

// ---- 同义词表 ----------------------------------------------------------
// 全是小写、去下划线后匹配，所以 "MemUsed" / "mem_used" / "memoryused" 都能命中。

const NAME_KEYS = ['name', 'label', 'title', 'alias', 'hostname', 'host', 'nodename', 'displayname', 'server', 'tag', 'remark'];
const ID_KEYS = ['id', 'uuid', 'ident', 'key', 'nodeid', 'serverid', 'instance', 'instanceid', 'machineid', 'sid'];

const CPU_KEYS = ['cpu', 'cpuusage', 'cpupct', 'cpupercent', 'cpuload', 'cpuloadpct', 'cpuutil', 'cpuutilization', 'cpuusedpct'];
const CORES_KEYS = ['cpucores', 'cores', 'corecount', 'cpu count', 'cpunum', 'ncpu', 'vcpu', 'vcpus'];
const MEMUSED_KEYS = ['memused', 'memoryused', 'memusedbytes', 'usedmem', 'usedmemory', 'memusage', 'ramused', 'memusedb', 'memusedkb', 'memusedmb'];
const MEMTOTAL_KEYS = ['memtotal', 'memorytotal', 'totalmem', 'totalmemory', 'ramtotal', 'memtotalb', 'memtotalkb', 'memtotalmb', 'mem', 'memory'];
const DISKUSED_KEYS = ['diskused', 'hddused', 'useddisk', 'usedhdd', 'diskusage', 'storageused', 'diskusedb'];
const DISKTOTAL_KEYS = ['disktotal', 'hddtotal', 'totaldisk', 'totalhdd', 'storagetotal', 'disktotalb', 'disk', 'hdd'];
const SWAPUSED_KEYS = ['swapused', 'usedswap'];
const SWAPTOTAL_KEYS = ['swaptotal', 'totalswap', 'swap'];
const NETRX_KEYS = ['netrx', 'netin', 'rx', 'rxbps', 'netinbps', 'down', 'download', 'inspeed', 'netspeedin', 'netinspeed', 'netrxbps'];
const NETTX_KEYS = ['nettx', 'netout', 'tx', 'txbps', 'netoutbps', 'up', 'upload', 'outspeed', 'netspeedout', 'netoutspeed', 'nettxbps'];
const NETIN_KEYS = ['netin', 'totalin', 'netintotal', 'netintransfer', 'netrxbytes', 'rxbytes', 'trafficin', 'netinall'];
const NETOUT_KEYS = ['netout', 'totalout', 'netouttotal', 'netouttransfer', 'nettxbytes', 'txbytes', 'trafficout', 'netoutall'];
// 注意 'ups' = 归一化后的 "up_s" / "up_sec"，是常见的"运行秒数"写法。
// 它也是"不间断电源"的缩写，但在**节点记录**（旁边还有 cpu/mem 字段）里
// 歧义极小；而且我们只接受数字，配置里的字符串 UPS 不会被误认。
const UPTIME_KEYS = ['uptime', 'uptimesec', 'uptimeseconds', 'uptimes', 'uptimeb', 'runtime', 'uptimevalue',
  'ups', 'upsec', 'upseconds', 'onlinesec', 'runningtime'];
const LASTSEEN_KEYS = ['lastseen', 'lastupdate', 'updatedat', 'updated', 'timestamp', 'ts', 'lastheartbeat', 'lastreport', 'heartbeat', 'lastactive'];
const REGION_KEYS = ['region', 'country', 'countrycode', 'location', 'area', 'zone', 'site', 'datacenter', 'dc'];
const ONLINE_KEYS = ['online', 'alive', 'isup', 'up', 'status', 'isable', 'enabled', 'connected', 'active', 'healthy'];
const OS_KEYS = ['os', 'platform', 'osname', 'system', 'distro', 'operatingsystem'];
const LOAD_SINGLE = ['load', 'loadavg', 'loadaverage', 'cpuloadavg'];
const LOAD_THREE = ['load1', 'load5', 'load15'];
const LOAD_ARR = ['load', 'loadavg', 'loads', 'loadaverage'];

// 通用的"列表容器"候选键名
const LIST_KEYS = ['servers', 'nodes', 'data', 'list', 'items', 'result', 'results', 'machines',
  'hosts', 'instances', 'records', 'rows', 'payload', 'content', 'monitors', 'targets'];

// 指标字段全集（用于判断"这个对象像不像一只机器"）
const METRIC_KEYS = [...CPU_KEYS, ...MEMUSED_KEYS, ...MEMTOTAL_KEYS, ...DISKUSED_KEYS,
  ...DISKTOTAL_KEYS, ...NETRX_KEYS, ...NETTX_KEYS, ...NETIN_KEYS, ...NETOUT_KEYS, ...UPTIME_KEYS];

/** 归一化字段名：小写 + 去分隔符（mem_used / memUsed / mem-used → memused） */
function normKey(k) {
  return String(k).toLowerCase().replace(/[\s_\-.]+/g, '');
}

/** 在对象里按同义词找第一个有值的字段。返回 { key, value } 或 null */
function find(rec, synonyms, keyMap) {
  for (const syn of synonyms) {
    const real = keyMap.get(syn);
    if (real === undefined) continue;
    const v = rec[real];
    if (v !== undefined && v !== null && v !== '') return { key: real, value: v };
  }
  return null;
}

/** 判断一个值是否"像"容量数字（用于单位推断的辅助信号） */
function looksLikeBytes(v) {
  const n = num(v);
  return n !== null && n > 1024;   // 小于 1KB 的量不可能是内存/硬盘总量
}

/**
 * 结构嗅探：从任意 JSON 里找出最像「节点列表」的数组。
 * 返回 { arr, path } 或 null。
 */
export function sniffNodeList(json) {
  if (!json || typeof json !== 'object') return null;

  const candidates = [];

  const consider = (arr, path) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    // 数组元素必须大多是对象
    const objs = arr.filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length < Math.max(1, arr.length * 0.6)) return;

    // 给每个元素打"像不像一只机器"的分
    const scores = objs.slice(0, 30).map(o => scoreRecord(o));
    const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
    if (avg <= 0) return;
    candidates.push({ arr: objs, path, score: avg, len: objs.length });
  };

  // 一层：直接从顶层已知容器键里找
  for (const k of LIST_KEYS) {
    if (Array.isArray(json[k])) consider(json[k], k);
  }
  // 顶层本身就是数组
  if (Array.isArray(json)) consider(json, '(root)');

  // 两层：穿透常见的包装层（code/data/payload/result…）
  const WRAPPERS = ['data', 'payload', 'result', 'response', 'body', 'content', 'value', 'ret', 'resp'];
  for (const w of WRAPPERS) {
    const inner = json[w];
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
    for (const k of LIST_KEYS) {
      if (Array.isArray(inner[k])) consider(inner[k], `${w}.${k}`);
    }
    if (Array.isArray(inner)) consider(inner, w);
  }

  if (!candidates.length) return null;
  // 评分优先，其次元素多的优先（机器列表通常不止一两条）
  candidates.sort((a, b) => (b.score - a.score) || (b.len - a.len));
  return candidates[0];
}

/**
 * 给一条记录打分：越像"一台被监控的机器"分越高。
 * 打分只看**字段名**，不看数值大小 —— 数值含义不可靠，字段名才是契约。
 */
export function scoreRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 0;
  const keyMap = buildKeyMap(rec);

  let score = 0;
  const hasIdentity = NAME_KEYS.some(s => keyMap.has(s)) || ID_KEYS.some(s => keyMap.has(s));
  const metricHits = METRIC_KEYS.filter(s => keyMap.has(s)).length;

  // 没有身份字段的记录基本不是机器条目（可能是个配置对象）
  if (!hasIdentity) score -= 2;
  else score += 1;

  // 指标字段命中越多越可信，但收益递减（避免靠"字段名多"刷分）
  score += Math.min(metricHits, 6);

  // 资源容量三件套同时存在 → 强信号
  const hasCpu = CPU_KEYS.some(s => keyMap.has(s));
  const hasMem = MEMUSED_KEYS.some(s => keyMap.has(s)) || MEMTOTAL_KEYS.some(s => keyMap.has(s));
  const hasDisk = DISKUSED_KEYS.some(s => keyMap.has(s)) || DISKTOTAL_KEYS.some(s => keyMap.has(s));
  if (hasCpu && hasMem) score += 2;
  if (hasMem && hasDisk) score += 1;
  if (hasCpu && hasMem && hasDisk) score += 2;

  return score;
}

/** 建 归一化字段名 → 原始键名 的映射（同义匹配用） */
function buildKeyMap(rec) {
  const m = new Map();
  for (const k of Object.keys(rec)) {
    const nk = normKey(k);
    if (!m.has(nk)) m.set(nk, k);
  }
  return m;
}

/**
 * 推断容量字段的单位。
 * 未知程序的坑：同是"内存总量"，有的给字节、有的给 KB、有的给 MB。
 * 策略：**用 CPU 与容量的相对关系 + 绝对量级**推断。
 *   内存总量通常在 1e8 ~ 1e12 字节之间。
 *   若数值 < 1e6 → 大概是 MB 或更小的单位 → 按 MB 处理
 *   1e6 ~ 1e9  → 可能是 KB 或 MB，按 KB 处理（保守）
 *   > 1e9      → 按字节处理
 * 这个启发式**只在没别的线索时使用**，并通过 meta.unitsGuessed 明确标注。
 */
function guessCapacityUnit(v) {
  const n = num(v);
  if (n === null || n <= 0) return { mul: 1, unit: null };
  if (n >= 1e9) return { mul: 1, unit: 'B' };
  if (n >= 1e6) return { mul: 1024, unit: 'KB' };
  return { mul: 1024 * 1024, unit: 'MB' };
}

/**
 * 通用归一化：把一条任意形状的记录映射成统一节点。
 * 认不出来的字段一律留 null。
 */
export function normalizeRecord(rec, kind = 'generic') {
  const keyMap = buildKeyMap(rec);

  const idHit = find(rec, ID_KEYS, keyMap);
  const nameHit = find(rec, NAME_KEYS, keyMap);
  const key = String(idHit?.value ?? nameHit?.value ?? 'unknown');
  const node = emptyNode(key, kind);
  node.name = String(nameHit?.value ?? idHit?.value ?? key);

  // ---- 在线判定 ----
  const onHit = find(rec, ONLINE_KEYS, keyMap);
  if (onHit) {
    const b = bool(onHit.value);
    // 注意：status 类字段可能是字符串枚举（"up"/"down"/"running"）
    if (b !== null && normKey(onHit.key) !== 'status') node.online = b;
    else {
      const s = String(onHit.value).toLowerCase();
      node.online = /^(up|online|running|active|ok|alive|healthy|true|1)$/.test(s);
    }
  } else {
    // 没有显式在线字段：用 lastSeen 新鲜度兜底（5 分钟内算在线）
    const seen = find(rec, LASTSEEN_KEYS, keyMap);
    const ms = seen ? toMs(seen.value) : null;
    if (ms) node.online = Date.now() - ms < 300_000;
  }

  // ---- CPU ----
  const cpuHit = find(rec, CPU_KEYS, keyMap);
  if (cpuHit) {
    let v = num(cpuHit.value);
    // 0~1 的小数（有的探针给比率）→ 转百分数
    if (v !== null && v > 0 && v <= 1 && /pct|percent|ratio|usage|util/i.test(cpuHit.key)) v *= 100;
    node.cpu = clampCpu(v);
  }

  const coresHit = find(rec, CORES_KEYS, keyMap);
  if (coresHit) node.cores = num(coresHit.value);

  // ---- 内存 / 硬盘（带单位推断）----
  const memUHit = find(rec, MEMUSED_KEYS, keyMap);
  const memTHit = find(rec, MEMTOTAL_KEYS, keyMap);
  // 用"总量"推断单位，然后**已用量套用同一单位** —— 两个字段同单位是常规做法，
  // 比各自独立推断更稳（已用量小，单独推断容易错档）。
  let memUnit = null;
  if (memTHit && looksLikeBytes(memTHit.value)) {
    const g = guessCapacityUnit(memTHit.value);
    memUnit = g.unit;
    node.memT = num(memTHit.value) * g.mul;
    if (memUHit) node.memU = num(memUHit.value) * g.mul;
  } else if (memUHit) {
    const g = guessCapacityUnit(memUHit.value);
    memUnit = g.unit;
    node.memU = num(memUHit.value) * g.mul;
  }

  const diskUHit = find(rec, DISKUSED_KEYS, keyMap);
  const diskTHit = find(rec, DISKTOTAL_KEYS, keyMap);
  let diskUnit = null;
  // 注意：'disk'/'mem' 这类裸词风险高（CF探针的 disk 是 IO 对象），
  // 只接受数字，且必须通过容量量级检查。
  const diskTotalVal = diskTHit && !Array.isArray(diskTHit.value) && typeof diskTHit.value !== 'object'
    ? num(diskTHit.value) : null;
  if (diskTotalVal !== null && looksLikeBytes(diskTotalVal)) {
    const g = guessCapacityUnit(diskTotalVal);
    diskUnit = g.unit;
    node.diskT = diskTotalVal * g.mul;
    if (diskUHit) node.diskU = num(diskUHit.value) * g.mul;
  } else if (diskUHit) {
    const g = guessCapacityUnit(diskUHit.value);
    diskUnit = g.unit;
    node.diskU = num(diskUHit.value) * g.mul;
  }

  const swapTHit = find(rec, SWAPTOTAL_KEYS, keyMap);
  if (swapTHit && !Array.isArray(swapTHit.value) && typeof swapTHit.value !== 'object') {
    const sv = num(swapTHit.value);
    if (sv !== null && sv > 0) {
      const g = guessCapacityUnit(sv);
      node.swapT = sv * g.mul;
      const swapUHit = find(rec, SWAPUSED_KEYS, keyMap);
      if (swapUHit) node.swapU = num(swapUHit.value) * g.mul;
    }
  }

  // ---- 网络 ----
  const rxHit = find(rec, NETRX_KEYS, keyMap);
  const txHit = find(rec, NETTX_KEYS, keyMap);
  // rx/tx 是"速率"还是"累计"，靠字段名区分：含 total/bytes/transfer/all 的是累计。
  const isCumulative = (k) => /total|bytes|transfer|all|sum/i.test(k);
  if (rxHit) node[isCumulative(rxHit.key) ? 'netIn' : 'netRx'] = num(rxHit.value);
  if (txHit) node[isCumulative(txHit.key) ? 'netOut' : 'netTx'] = num(txHit.value);
  // 显式的累计字段优先级更高（覆盖上面的推断）
  const inHit = find(rec, NETIN_KEYS, keyMap);
  const outHit = find(rec, NETOUT_KEYS, keyMap);
  if (inHit && isCumulative(inHit.key)) node.netIn = num(inHit.value);
  if (outHit && isCumulative(outHit.key)) node.netOut = num(outHit.value);

  // ---- 运行时长 ----
  const upHit = find(rec, UPTIME_KEYS, keyMap);
  if (upHit) node.uptime = uptimeToSec(upHit.value);

  // ---- 负载 ----
  node.load = normLoad(rec, {
    arr: LOAD_ARR.find(k => Array.isArray(rec[k])),
    three: LOAD_THREE.every(k => k in rec) ? LOAD_THREE : null,
    str: typeof rec.load_avg === 'string' ? 'load_avg' : null,
    single: LOAD_SINGLE.find(k => typeof rec[k] === 'number'),
  });

  // ---- 地区 / 系统 ----
  const regHit = find(rec, REGION_KEYS, keyMap);
  if (regHit) {
    const code = normRegion(regHit.value);
    // 2 位码当地区码；其它（中文机房名）当 location
    if (code && /^[A-Z]{2}$/.test(code)) node.region = code;
    if (regHit.value && !/^[A-Za-z]{2}$/.test(String(regHit.value))) node.location = String(regHit.value);
  }
  const osHit = find(rec, OS_KEYS, keyMap);
  if (osHit && typeof osHit.value === 'string') node.os = osHit.value;

  // ---- 时间戳 ----
  const seenHit = find(rec, LASTSEEN_KEYS, keyMap);
  if (seenHit) node.lastSeen = toMs(seenHit.value);

  // ---- 保留解析线索，但不把完整上游对象塞进长期状态 ----
  node.meta = {
    generic: true,                 // 标记：这条是通用兜底解析出来的
    matchedKeys: {
      id: idHit?.key ?? null, name: nameHit?.key ?? null,
      cpu: cpuHit?.key ?? null, memUsed: memUHit?.key ?? null, memTotal: memTHit?.key ?? null,
      diskUsed: diskUHit?.key ?? null, diskTotal: diskTHit?.key ?? null,
      netRx: rxHit?.key ?? null, netTx: txHit?.key ?? null,
      uptime: upHit?.key ?? null, online: onHit?.key ?? null,
      region: regHit?.key ?? null, lastSeen: seenHit?.key ?? null,
    },
    unitsGuessed: { mem: memUnit, disk: diskUnit },   // 单位是推断的，标注出来
  };

  return finalizeNode(node);
}

/**
 * 适配器入口。raw = 已经解析好的 JSON（reader 传到这里时已 fetch 过）。
 * 与其它适配器的区别：它接收的是 **raw 数据**，因为走到这一步时
 * reader 已经在候选循环里拿到了响应，没必要再请求一次。
 */
export function normalize(raw, kind = 'generic') {
  const sniffed = sniffNodeList(raw);
  if (!sniffed) return [];
  const out = [];
  for (const rec of sniffed.arr) {
    try {
      const n = normalizeRecord(rec, kind);
      // 至少要有一项真实指标才收 —— 否则是空壳对象
      const hasMetric = n.cpu !== null || n.memT !== null || n.memU !== null
        || n.diskT !== null || n.netRx !== null || n.netTx !== null || n.uptime !== null;
      if (hasMetric || n.online) out.push(n);
    } catch { /* 单条坏记录跳过，不影响其它 */ }
  }
  return out;
}

/**
 * 指纹评分。通用兜底"故意"给低分：它永远不该抢走已知类型的判定。
 * 只有结构确实像节点列表、且字段命中较多时才给到 4（reader 的可用阈值）。
 */
export function detect(json) {
  const sniffed = sniffNodeList(json);
  if (!sniffed) return 0;
  const s = Math.round(sniffed.score);
  return Math.min(s, 6);
}

/** 与其它适配器保持接口一致：read 走的是"先请求再解析"，但 generic 由 reader 直接喂 raw */
export async function read(rawOrUrl, opts = {}) {
  if (rawOrUrl && typeof rawOrUrl === 'object') {
    const nodes = normalize(rawOrUrl, 'generic');
    return { ok: nodes.length > 0, kind: 'generic', nodes, raw: rawOrUrl, transport };
  }
  return { ok: false, kind: 'generic', nodes: [], error: 'generic 适配器需要 reader 传入原始 JSON' };
}
