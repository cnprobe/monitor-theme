// 适配器：Nodeget
//
// ★ 协议已完全实测确认（不是猜的）—— 逆向自前端 bundle `assets/index-*.js`：
//
//   config.json:
//     { user_preferences:{site_name,…},
//       site_tokens:[ { name, backend_url:"wss://master-xxx", token:"id:secret" } ] }
//   → 数据源与凭据都是**公开可读**的，读取器可自动发现，无需用户手填。
//     一个站点可能有多个 backend（多 master），全部聚合。
//
//   JSON-RPC 2.0，token 放在 params.token（不是 Authorization 头）：
//     nodeget-server_list_all_agent_uuid      {}                    → { uuids:[…] }
//     agent_static_data_multi_last_query      {uuids, fields}       → [{ uuid, cpu:{logical_cores,
//                                                                       physical_cores,per_core[]},
//                                                                       system:{arch,system_name,
//                                                                       virtualization,system_host_name,
//                                                                       distribution_id,
//                                                                       system_kernel,…}, timestamp }]
//     agent_dynamic_summary_multi_last_query  {uuids, fields}       → [{ uuid, timestamp, cpu_usage,
//                                                                       used_memory, total_memory,
//                                                                       available_memory, used_swap,
//                                                                       total_swap, total_space,
//                                                                       available_space, read_speed,
//                                                                       write_speed, receive_speed,
//                                                                       transmit_speed, total_received,
//                                                                       total_transmitted, load_one,
//                                                                       load_five, load_fifteen, uptime,
//                                                                       boot_time, process_count,
//                                                                       tcp_connections, udp_connections }]
//     kv_get_multi_value                      {namespace_key:[{namespace,key}]}
//                                                                 → [{ namespace, key, value }]
//     agent_query_dynamic_summary             {query:{fields,condition:[{uuid},{timestamp_from_to}]}}
//                                                                 → 历史点（画图用，读取器不取）
//
//   ★ fields: [] （空数组）会返回**全部**字段 —— 比逐个枚举更省心、更抗版本升级。
//
//   ★ 传输：官方前端**优先 HTTP POST**（wss:// → https://，同一个 URL），
//     fetch 失败才回退 WebSocket。所以这里用 DualRpcClient（先 POST 再 WS）；
//     实测 POST 稳定（~70ms），WS 走 Cloudflare 时常被拦。
//
//   单位（实测）：容量=字节，速率=B/s，uptime=秒，boot_time=秒，timestamp=epoch ms。
//   ★ 磁盘只有 total_space / available_space —— 没有 "used_space"，
//     已用 = total - available（前端也是这么算的）。
//   ★ 刻意**不发** `nodeget-server_list_all_agent`（只给 uuid 清单的另一个方法），
//     list_all_agent_uuid 就够，少一次往返。

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { fetchJson, siteRoot } from '../http.js';
import { num, normLoad, pick, uptimeToSec, toMs, normRegion } from '../normalize.js';
import { DualRpcClient } from '../ws.js';
import { resolveProbeSecurity, isOriginAllowed } from '../../security.js';

export const kind = 'nodeget';
export const transport = 'rpc';   // 实际为 POST JSON-RPC，失败回退 WS

// ---- 已确认的方法名 ----
const M_LIST = 'nodeget-server_list_all_agent_uuid';
const M_STATIC = 'agent_static_data_multi_last_query';
const M_DYNAMIC = 'agent_dynamic_summary_multi_last_query';
const M_KV = 'kv_get_multi_value';

// 动态字段清单（实测可用）。留空数组也能拿全字段，这里显式列出便于阅读与降级。
const DYNAMIC_FIELDS = [
  'cpu_usage', 'used_memory', 'total_memory', 'available_memory',
  'used_swap', 'total_swap', 'total_space', 'available_space',
  'read_speed', 'write_speed', 'receive_speed', 'transmit_speed',
  'total_received', 'total_transmitted',
  'load_one', 'load_five', 'load_fifteen',
  'uptime', 'boot_time', 'process_count', 'tcp_connections', 'udp_connections',
];

// 静态字段：只取 cpu / system 两棵子树（含核心数与虚拟化、系统名）
const STATIC_FIELDS = ['cpu', 'system'];
const STATIC_LIGHT_FIELDS = ['system'];

// kv 里的元数据键（名称/地区/计费/流量）
const META_KEYS = [
  'metadata_name', 'metadata_region', 'metadata_tags', 'metadata_hidden',
  'metadata_virtualization', 'metadata_latitude', 'metadata_longitude',
  'metadata_order', 'metadata_price', 'metadata_price_unit', 'metadata_price_cycle',
  'metadata_expire_time', 'metadata_traffic_limit_gb', 'metadata_traffic_price_per_gb',
  'metadata_traffic_period', 'metadata_traffic_start_date',
];
const KV_TRAFFIC_BASELINE = 'traffic_baseline';

/** NodeGet backend 只接受 TLS URL；回环地址保留明文协议以便本地开发。 */
export function isSupportedBackendUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    return loopback || u.protocol === 'wss:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function backendAllowed(value, origins) {
  try {
    const url = new URL(String(value));
    const origin = url.origin.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    return isOriginAllowed(origin, origins);
  } catch {
    return false;
  }
}

function publicBackendUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'configured-backend';
  }
}

/** 读 config.json，得出全部数据源（含凭据） */
export async function readConfig(base, opts = {}) {
  const r = await fetchJson(base + '/config.json', { ms: opts.ms ?? 10000 });
  if (!r.ok) return { ok: false, error: r.error };
  const tokens = Array.isArray(r.data?.site_tokens) ? r.data.site_tokens : [];
  const allowedOrigins = resolveProbeSecurity(opts).nodegetBackendOrigins;
  return {
    ok: true,
    prefs: r.data?.user_preferences || {},
    backends: tokens
      .filter(t => t && typeof t === 'object' && t.backend_url && isSupportedBackendUrl(t.backend_url) && backendAllowed(t.backend_url, allowedOrigins))
      .slice(0, 32)
      .map(t => ({ name: t.name || '', url: String(t.backend_url), token: t.token || null })),
    raw: r.data,
  };
}

/** 把 kv 的扁平 [{namespace,key,value}] 折成 { uuid: {key: value} } */
function kvToMap(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || r.namespace == null || r.value == null) continue;
    const ns = String(r.namespace);
    if (!out.has(ns)) out.set(ns, Object.create(null));
    out.get(ns)[String(r.key)] = r.value;
  }
  return out;
}

// 有的站点没填 metadata_region，但主机名/节点名里带机房线索。
// 只认「独立成词」的三字母机场码，避免误伤（如 "web01" 不该命中）。
const HOST_REGION_HINTS = [
  'HKG', 'HK', 'TPE', 'TW', 'TYO', 'JP', 'NRT', 'KIX', 'OSA',
  'SIN', 'SG', 'LAX', 'SJC', 'SEA', 'NYC', 'ASH', 'CHI', 'DFW', 'MIA', 'PHX',
  'RBX', 'PAR', 'FRA', 'AMS', 'LON', 'LHR', 'MAD', 'MIL', 'WAW', 'MOW',
  'SHA', 'PEK', 'CAN', 'SZX', 'CTU', 'HGH', 'TSN',
  'SYD', 'MEL', 'BOM', 'DXB', 'ICN', 'SEL', 'YYZ', 'GRU', 'JNB', 'FRA',
];
const REGION_ALIAS = { HK: 'HK', HKG: 'HK', TPE: 'TW', TW: 'TW', TYO: 'JP', JP: 'JP',
  NRT: 'JP', KIX: 'JP', OSA: 'JP', SIN: 'SG', SG: 'SG', LAX: 'US', SJC: 'US', SEA: 'US',
  NYC: 'US', ASH: 'US', CHI: 'US', DFW: 'US', MIA: 'US', PHX: 'US',
  RBX: 'FR', PAR: 'FR', FRA: 'DE', AMS: 'NL', LON: 'GB', LHR: 'GB', MAD: 'ES',
  MIL: 'IT', WAW: 'PL', MOW: 'RU', SHA: 'CN', PEK: 'CN', CAN: 'CN', SZX: 'CN',
  CTU: 'CN', HGH: 'CN', TSN: 'CN', SYD: 'AU', MEL: 'AU', BOM: 'IN', DXB: 'AE',
  ICN: 'KR', SEL: 'KR', YYZ: 'CA', GRU: 'BR', JNB: 'ZA' };

/** 从主机名/节点名里猜地区码（仅在 metadata 缺失时兜底） */
export function guessRegion(...names) {
  for (const raw of names) {
    const s = String(raw || '').toUpperCase();
    if (!s) continue;
    // 先试 3 字母机场码（带分隔符或出现在开头）
    for (const code of HOST_REGION_HINTS) {
      const re = new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`);
      if (re.test(s)) return REGION_ALIAS[code] || null;
    }
  }
  return null;
}

function numOrNull(v) {
  const x = num(v);
  return x === null ? null : x;
}

/**
 * 把 list/static/dynamic/kv 四份数据合并成统一节点。
 * 纯函数，可离线单测。
 */
export function mergeNodeget({ uuids = [], statics = [], dynamics = [], kv = [], baseline = [], backendName = '' } = {}) {
  const byUuid = a => {
    const m = new Map();
    for (const r of (Array.isArray(a) ? a : [])) if (r && r.uuid) m.set(String(r.uuid), r);
    return m;
  };
  const sMap = byUuid(statics);
  const dMap = byUuid(dynamics);
  const kMap = kvToMap(kv);
  const bMap = kvToMap(baseline);

  const keys = [...new Set([...uuids.map(String), ...sMap.keys(), ...dMap.keys(), ...kMap.keys()])];
  const out = [];

  for (const u of keys) {
    const s = sMap.get(u) || {};
    const d = dMap.get(u) || {};
    const meta = kMap.get(u) || {};

    const node = emptyNode(u, kind);
    if (meta.metadata_hidden === true || meta.metadata_hidden === 'true') continue; // 隐藏节点跳过

    const host = s.system?.system_host_name || '';
    node.name = String(meta.metadata_name || host || u);

    // 在线判定：拿到动态摘要且时间戳足够新
    const ts = toMs(d.timestamp ?? s.timestamp);
    node.lastSeen = ts;
    node.online = ts !== null && Date.now() - ts < 90 * 1000;

    // 地区：优先 metadata_region（实测是 HK/TW 这种干净码，也可能是 emoji 国旗）；
    //       缺失时从节点名/主机名里猜（很多站点不填 region）。
    node.region = normRegion(meta.metadata_region) || guessRegion(meta.metadata_name, host, u);
    node.location = String(meta.metadata_region || '');

    // 系统
    node.os = s.system?.system_name ? String(s.system.system_name) : null;
    node.virt = (meta.metadata_virtualization || s.system?.virtualization)
      ? String(meta.metadata_virtualization || s.system.virtualization) : null;

    // CPU / 负载
    node.cpu = clampCpu(d.cpu_usage);
    node.cores = numOrNull(s.cpu?.logical_cores) ?? numOrNull(s.cpu?.physical_cores);
    node.load = normLoad(d, { three: ['load_one', 'load_five', 'load_fifteen'] });

    // 内存 / swap（字节直通）
    node.memU = numOrNull(d.used_memory);
    node.memT = numOrNull(d.total_memory);
    node.swapU = numOrNull(d.used_swap);
    node.swapT = numOrNull(d.total_swap);

    // 磁盘：只有 total_space / available_space → used = total - available
    const dTotal = numOrNull(d.total_space);
    const dAvail = numOrNull(d.available_space);
    node.diskT = dTotal;
    node.diskU = (dTotal !== null && dAvail !== null) ? Math.max(0, dTotal - dAvail) : null;

    // 网络：速率 B/s
    node.netRx = numOrNull(d.receive_speed);
    node.netTx = numOrNull(d.transmit_speed);
    // 累计流量：total_received / total_transmitted 是累计值；
    // 若 kv 里有 traffic_baseline（计费周期起点），减掉得到本周期用量。
    const b = bMap.get(u)?.traffic_baseline;
    const baseRx = numOrNull(b?.rx);
    const baseTx = numOrNull(b?.tx);
    const adjRx = numOrNull(b?.adjust_rx) || 0;
    const adjTx = numOrNull(b?.adjust_tx) || 0;
    const cumRx = numOrNull(d.total_received);
    const cumTx = numOrNull(d.total_transmitted);
    node.netIn = cumRx;
    node.netOut = cumTx;
    if (cumRx !== null) node.netMonthIn = Math.max(0, cumRx - (baseRx ?? 0) + adjRx);
    if (cumTx !== null) node.netMonthOut = Math.max(0, cumTx - (baseTx ?? 0) + adjTx);

    // 延迟：Nodeget 不提供 ICMP/抓取延迟（它的 "延迟" 语义是 agent 上报延迟，不含在内）
    node.ping = null;

    // 运行时长：uptime 秒；boot_time 秒也可换算，优先 uptime
    node.uptime = uptimeToSec(d.uptime) ?? (numOrNull(d.boot_time) !== null
      ? Math.max(0, Math.floor(Date.now() / 1000) - numOrNull(d.boot_time))
      : null);

    node.meta = {
      backend: backendName,
      protocol: 'nodeget-jsonrpc2',
      tags: Array.isArray(meta.metadata_tags) ? meta.metadata_tags.filter(Boolean) : [],
      host,
      arch: s.system?.arch || '',
      kernel: s.system?.system_kernel || '',
      distribution: s.system?.distribution_id || '',
      cpuBrand: s.cpu?.per_core?.[0]?.brand || '',
      physicalCores: numOrNull(s.cpu?.physical_cores),
      processCount: numOrNull(d.process_count),
      tcp: numOrNull(d.tcp_connections), udp: numOrNull(d.udp_connections),
      readSpeed: numOrNull(d.read_speed), writeSpeed: numOrNull(d.write_speed),
      bootTime: numOrNull(d.boot_time),
      price: numOrNull(meta.metadata_price), priceUnit: meta.metadata_price_unit || '$',
      priceCycle: numOrNull(meta.metadata_price_cycle),
      expireTime: meta.metadata_expire_time || '',
      trafficLimitGb: numOrNull(meta.metadata_traffic_limit_gb),
      trafficPeriod: meta.metadata_traffic_period || '',
      trafficStartDate: meta.metadata_traffic_start_date || '',
      trafficBaseline: b || null,
    };
    out.push(finalizeNode(node));
  }
  return out;
}

/** 读单个 backend 的全部数据。
 *
 *  ★ 关键设计：**单 backend 总预算**（deadline），而不是「每个请求各自超时」。
 *    实测有 master 会偶发抽风（同样的请求 39ms → 8002ms 超时，反复出现），
 *    若每个请求各自可超时，4 个请求 × 8s = 32s 全花在它身上。
 *    改为「这个 backend 总共只给 X 秒」：一旦超预算就立刻收手，
 *    用已经拿到的部分数据（通常是 list + 静态 + 实时，已足够渲染），
 *    其余标记为缺失。宁可少一个 backend 的元数据，也不能让整站卡住。
 */
async function readBackend(be, opts) {
  const budget = Math.min(opts.backendMs ?? 8000, opts.ms ?? 8000);
  const deadline = Date.now() + budget;
  const left = () => Math.max(1000, deadline - Date.now());
  const over = () => Date.now() >= deadline;

  const client = new DualRpcClient(be.url, {
    token: be.token,
    tokenIn: 'params',
    timeout: Math.min(opts.reqMs ?? 6000, budget),
    ttl: opts.ttl ?? 5000,
    allowWsFallback: opts.allowWsFallback ?? true,
  });

  const first = await client.call([{ method: M_LIST, params: {} }]);
  const listRes = first[M_LIST];
  if (listRes && listRes.__error) return { ok: false, error: `列节点失败：${listRes.__error}` };
  const uuids = Array.isArray(listRes?.uuids) ? listRes.uuids.map(String).slice(0, 256) : [];
  if (!uuids.length) return { ok: true, nodes: [], uuids, warning: '该 backend 没有节点' };

  // ⚠ `traffic_baseline` 是需要额外权限的 kv 键，很多站点会拒绝
  //   （实测 Permission denied）。它只影响「本月流量」的准确性，
  //   不该拖慢或拖垮主流程 → 放在最后，且预算不足就跳过。
  const nsKey = uuids.flatMap(u => META_KEYS.map(k => ({ namespace: u, key: k })));

  const batch = await client.call([
    { method: M_STATIC, params: { uuids, fields: STATIC_FIELDS } },
    { method: M_DYNAMIC, params: { uuids, fields: DYNAMIC_FIELDS } },
    { method: M_KV, params: { namespace_key: nsKey } },
  ]);

  const unwrap = m => {
    const v = batch[m];
    if (v && v.__error) return { err: v.__error, data: [] };
    return { err: null, data: Array.isArray(v) ? v : [] };
  };
  let st = unwrap(M_STATIC);
  const dy = unwrap(M_DYNAMIC);
  const kvRes = unwrap(M_KV);

  // 静态字段降级：若带 cpu 子树失败，退一步只取 system（预算不够就不试）
  if (st.err && st.data.length === 0 && !over()) {
    const retry = await client.call([{ method: M_STATIC, params: { uuids, fields: STATIC_LIGHT_FIELDS } }]);
    const rv = retry[M_STATIC];
    if (rv && !rv.__error && Array.isArray(rv)) st = { err: null, data: rv };
  }

  // 本月流量基线：独立、尽力而为，且受 deadline 约束。
  const baseline = [];
  if (!over()) {
    const nsBase = uuids.map(u => ({ namespace: u, key: KV_TRAFFIC_BASELINE }));
    try {
      client.invalidate();
      const rb = await client.call([{ method: M_KV, params: { namespace_key: nsBase } }]);
      const bv = rb[M_KV];
      if (bv && !bv.__error && Array.isArray(bv)) baseline.push(...bv);
    } catch { /* 忽略：仅影响本月流量 */ }
  }

  const nodes = mergeNodeget({
    uuids, statics: st.data, dynamics: dy.data, kv: kvRes.data, baseline, backendName: be.name || be.url,
  });

  const errs = [];
  if (st.err) errs.push(`静态：${st.err}`);
  if (dy.err) errs.push(`实时：${dy.err}`);
  if (kvRes.err) errs.push(`元数据：${kvRes.err}`);
  if (over()) errs.push(`超出该 backend 的 ${budget}ms 预算，已用部分数据`);

  return {
    ok: true, nodes, uuids,
    warning: errs.length ? `部分数据缺失（${errs.join('；')}）` : null,
    raw: { statics: st.data, dynamics: dy.data, kv: kvRes.data, baseline },
  };
}

/** 并发闸门：限制同时进行的 backend 请求数 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function read(url, opts = {}) {
  const base = siteRoot(url);
  const security = resolveProbeSecurity(opts);
  // site_tokens 中的 backend_url 是远端配置声明的目标；默认不连接，避免
  // 被篡改的面板配置变成 SSRF 或凭据转发点。直接配置的其它源不受影响；
  // operator 明确打开开关后才跟随 NodeGet backend。
  if (!security.allowNodegetBackends) {
    return {
      ok: false, kind,
      error: 'NodeGet backend 跟随已按 probe 安全策略禁用；如确有需要请显式打开 allowNodegetBackends',
      endpoint: base + '/config.json',
    };
  }
  const cfg = await readConfig(base, opts);
  if (!cfg.ok) return { ok: false, error: `读不到 config.json：${cfg.error}`, kind };
  if (!cfg.backends.length) {
    return { ok: false, error: 'config.json 里没有 site_tokens（无数据源）', kind };
  }

  const allNodes = [];
  const warnings = [];
  const backends = [];

  // 一个站点可能有 6+ 个 backend。实测每个 backend 约 0.1–2s。
  // ⚠ 但**不能并发**：这些 master 常挂在同一批 CDN/网关后，并发打过去会被限流，
  //   表现为请求排到 10s+ 超时，总耗时反而从 5s 恶化到 40s（实测）。
  //   → 默认串行（concurrency=1），必要时可用 opts.concurrency 调高。
  const limit = Math.max(1, Math.min(opts.concurrency ?? 1, cfg.backends.length));

  // 整站总预算：单个 backend 有 deadline 还不够 —— 6 个 backend 各超一次就是 48s。
  // 给整站一个封顶，超了就把剩下的 backend 跳过（已拿到多少算多少）。
  const totalBudget = opts.totalMs ?? Math.max(15000, limit * (opts.backendMs ?? 8000));
  const siteDeadline = Date.now() + totalBudget;

  const results = await mapLimit(cfg.backends, limit, async (be, idx) => {
    if (Date.now() >= siteDeadline) {
      return { be, r: { ok: false, error: `超出整站 ${totalBudget}ms 预算，已跳过` } };
    }
    try {
      const r = await readBackend(be, opts);
      return { be, r };
    } catch (e) {
      return { be, r: { ok: false, error: e.message } };
    }
  });

  for (const { be, r } of results) {
    const label = be.name || publicBackendUrl(be.url);
    if (!r.ok) {
      warnings.push(`${label}：${r.error}`);
      backends.push({ name: be.name, url: publicBackendUrl(be.url), nodes: 0, error: 'unavailable' });
      continue;
    }
    allNodes.push(...r.nodes);
    if (r.warning) warnings.push(`${label}：${r.warning}`);
    backends.push({ name: be.name, url: publicBackendUrl(be.url), nodes: r.nodes?.length || 0 });
  }

  return {
    ok: allNodes.length > 0,
    kind, nodes: allNodes, transport,
    endpoint: base + '/config.json',
    config: { siteName: cfg.prefs.site_name || '', siteLogo: cfg.prefs.site_logo || '', footer: cfg.prefs.footer || '' },
    backends,
    warning: warnings.length ? warnings.join('；') : null,
    error: allNodes.length ? null : (warnings.join('；') || '未取到节点'),
  };
}

/** 指纹：Nodeget 站点靠 config.json 里的 site_tokens 识别（不走 JSON 指纹） */
export function detect() { return 0; }

export { M_LIST, M_STATIC, M_DYNAMIC, M_KV, META_KEYS, DYNAMIC_FIELDS, STATIC_FIELDS };
