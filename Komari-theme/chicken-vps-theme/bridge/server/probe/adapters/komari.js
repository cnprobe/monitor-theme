// 适配器：Komari
//
// ★ 最容易误判的一类。
//   REST `GET /api/nodes` **只返回静态元数据，完全没有实时指标**。
//   如果只看它，会以为 Komari 读不到 CPU/RAM，从而错误地归为"不支持"。
//
//   真实数据通道 = `wss://<host>/api/rpc2`（WebSocket JSON-RPC 2.0），
//   并且**公开方法匿名可用**（实测无需 token）：
//     common:getNodes               → { uuid: 静态信息 }
//     common:getNodesLatestStatus   → { uuid: 实时指标 }   ← 关联键是 client 字段
//     common:getVersion / common:getMe / common:getRecords
//     public:queryMetrics / public:getPublicPingTasks
//
//   REST `/api/nodes` 仍然保留为兜底：能给出机器清单，便于 WS 不可达时至少显示名字与在线状态。

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { fetchJson, siteRoot } from '../http.js';
import { num, normLoad, pick, uptimeToSec, toMs, normRegion, gb, bool } from '../normalize.js';
import { RpcClient } from '../ws.js';

export const kind = 'komari';
export const transport = 'ws';

const STALE_MS = 5 * 60 * 1000;
const META_METHOD = 'common:getNodes';
const LIVE_METHOD = 'common:getNodesLatestStatus';

/** 把 getNodes（静态） 与 getNodesLatestStatus（实时）按 uuid 合并 */
export function merge(meta, live, host) {
  const metaMap = toMap(meta);
  const liveMap = toMap(live);
  const keys = new Set([...metaMap.keys(), ...liveMap.keys()]);

  const out = [];
  for (const uuid of keys) {
    const m = metaMap.get(uuid) || {};
    const l = liveMap.get(uuid) || {};
    if (bool(m.hidden) === true) continue; // 前端不展示的节点也跳过

    const node = emptyNode(m.uuid || uuid, kind);
    node.name = String(m.name || l.name || uuid);

    // 在线判据：实时记录里的 online；退化用 time 新鲜度
    const t = toMs(pick(l, 'time'));
    node.online = bool(l.online) ?? (t !== null && Date.now() - t < STALE_MS);

    node.region = normRegion(pick(m, 'region', 'group'));
    node.location = String(pick(m, 'group', 'region') || '');
    node.os = m.os ? String(m.os) : null;
    node.virt = m.virtualization ? String(m.virtualization) : null;

    node.cpu = clampCpu(pick(l, 'cpu'));
    node.cores = num(pick(m, 'cpu_cores'));
    node.load = normLoad(l, { three: ['load', 'load5', 'load15'] });

    // 单位：字节
    node.memU = num(pick(l, 'ram'));
    node.memT = num(pick(l, 'ram_total') ?? m.mem_total);
    node.swapU = num(pick(l, 'swap'));
    node.swapT = num(pick(l, 'swap_total') ?? m.swap_total);
    node.diskU = num(pick(l, 'disk'));
    node.diskT = num(pick(l, 'disk_total') ?? m.disk_total);

    node.netRx = num(pick(l, 'net_in'));
    node.netTx = num(pick(l, 'net_out'));
    node.netIn = num(pick(l, 'net_total_down'));
    node.netOut = num(pick(l, 'net_total_up'));

    // ping 是对象 {任务id: 延迟}，取最小非零
    const pings = l.ping && typeof l.ping === 'object'
      ? Object.values(l.ping).slice(0, 1000).map(num).filter(v => v !== null && v > 0)
      : [];
    let minPing = Infinity;
    for (const value of pings) if (value < minPing) minPing = value;
    node.ping = minPing === Infinity ? null : minPing;

    node.uptime = uptimeToSec(pick(l, 'uptime'));
    node.lastSeen = t;

    node.meta = {
      host,
      group: m.group || '',
      tags: m.tags || '',
      cpuName: m.cpu_name || '',
      arch: m.arch || '',
      kernel: m.kernel_version || '',
      gpu: m.gpu_name && m.gpu_name !== 'None' ? m.gpu_name : '',
      physicalCores: num(m.cpu_physical_cores),
      price: num(m.price),
      currency: m.currency || '',
      billingCycle: num(m.billing_cycle),
      expiredAt: m.expired_at || '',
      trafficLimit: num(m.traffic_limit),
      trafficLimitType: m.traffic_limit_type || '',
      temp: num(l.temp),
      process: num(l.process),
      connections: num(pick(l, 'connections')),
      connectionsUdp: num(pick(l, 'connections_udp')),
      hasMeta: !!metaMap.get(uuid),
      hasLive: !!liveMap.get(uuid),
    };
    out.push(finalizeNode(node));
  }
  return out;
}

function toMap(v) {
  const map = new Map();
  if (!v || typeof v !== 'object') return map;
  // ★ Komari 返回的是「对象（uuid → 记录）」，不是数组。勿用 Array.isArray 判断。
  if (Array.isArray(v)) {
    for (const r of v.slice(0, 1000)) if (r && typeof r === 'object') map.set(String(r.uuid || r.client || r.id), r);
    return map;
  }
  for (const k of Object.keys(v).slice(0, 1000)) {
    const r = v[k];
    if (!r || typeof r !== 'object') continue;
    // 实时记录的关联键是 `client`；静态记录是 `uuid`。统一以 map 的键为准。
    map.set(String(r.uuid || r.client || k), r);
  }
  return map;
}

/** 只走 REST 的降级读取：能拿到清单与静态信息，但没有 CPU/RAM */
export function normalizeRest(j) {
  const data = Array.isArray(j?.data) ? j.data.filter(m => m && typeof m === 'object').slice(0, 1000) : [];
  return data.map(m => {
    if (bool(m.hidden) === true) return null;
    const node = emptyNode(m.uuid || m.name || 'unknown', kind);
    node.name = String(m.name || node.key);
    node.online = false;                 // REST 不给在线状态
    node.region = normRegion(pick(m, 'region', 'group'));
    node.location = String(pick(m, 'group', 'region') || '');
    node.os = m.os ? String(m.os) : null;
    node.virt = m.virtualization ? String(m.virtualization) : null;
    node.cores = num(m.cpu_cores);
    node.memT = num(m.mem_total);
    node.swapT = num(m.swap_total);
    node.diskT = num(m.disk_total);
    node.meta = {
      group: m.group || '', tags: m.tags || '', cpuName: m.cpu_name || '',
      arch: m.arch || '', kernel: m.kernel_version || '',
      price: num(m.price), currency: m.currency || '',
      billingCycle: num(m.billing_cycle), expiredAt: m.expired_at || '',
      trafficLimit: num(m.traffic_limit), trafficLimitType: m.traffic_limit_type || '',
      restOnly: true,
    };
    return finalizeNode(node);
  }).filter(Boolean);
}

// WS 握手单独给一个较短的预算：
// 有的站点 WS 会被网关吞掉，握手要挂到超时才失败（实测 status.sunver.de 单是握手就 60s+）。
// WS 只是「拿实时指标」的加分项，不该独占整个读取预算 —— 超时就用 REST 结果。
const WS_HANDSHAKE_MS = 8000;

export async function read(url, opts = {}) {
  const base = siteRoot(url);
  let host = base;
  try { host = new URL(base).host; } catch { /* ignore */ }
  const rpcUrl = opts.rpcUrl || base.replace(/^http/, 'ws') + '/api/rpc2';

  // ---- WS 与 REST **并行** ----
  // 原来先 WS 后 REST：WS 一挂（握手超时），整个读取就被拖到 60–120s。
  // 两者互不依赖，并行既保留了「有实时指标就用实时指标」的语义，
  // 又保证最坏情况下只花 max(ws, rest) 而不是 ws + rest。
  const wsPromise = (async () => {
    try {
      const client = opts.client || new RpcClient(rpcUrl, {
        origin: base,
        timeout: Math.min(opts.wsMs ?? WS_HANDSHAKE_MS, opts.ms ?? WS_HANDSHAKE_MS),
        ttl: opts.ttl ?? 5000,
      });
      const res = await client.call([
        { method: META_METHOD, id: 'meta' },
        { method: LIVE_METHOD, id: 'live' },
      ]);
      const meta = res[META_METHOD];
      const live = res[LIVE_METHOD];
      const metaErr = meta && meta.__error;
      const liveErr = live && live.__error;
      if (metaErr && liveErr) return { err: metaErr, nodes: [] };
      const nodes = merge(metaErr ? {} : meta, liveErr ? {} : live, host);
      return { err: null, nodes, partial: metaErr || liveErr || null, raw: { meta: metaErr ? null : meta, live: liveErr ? null : live } };
    } catch (e) {
      return { err: e.message, nodes: [] };
    }
  })();

  const restPromise = readRest(base, opts);

  const [ws, rest] = await Promise.all([wsPromise, restPromise.catch(e => ({ ok: false, error: e.message }))]);

  // 1. WS 拿到节点 → 首选
  if (ws.nodes.length) {
    return {
      ok: true, kind, nodes: ws.nodes, ms: 0, transport: 'ws', host,
      warning: ws.partial ? `部分 RPC 失败：${ws.partial}` : null,
      raw: ws.raw,
      endpoint: rpcUrl,
    };
  }

  // 2. WS 没拿到 → 退 REST（无实时指标，但至少能列出机器）
  if (rest && rest.ok) {
    return {
      ...rest,
      warning: ws.err
        ? `WS 不可用（${ws.err}），已降级为 REST（无实时指标）`
        : 'WS 未返回数据，已降级为 REST（无实时指标）',
    };
  }

  // 3. 两条都不通
  return {
    ok: false, kind,
    error: `WS 失败：${ws.err || '无数据'}；REST 也失败：${rest?.error || '无数据'}`,
  };
}

async function readRest(base, opts) {
  // REST 偶发超时（实测 status.sunver.de 有时 1.8s，有时直接超时）→ 重试一次。
  // 这条通道是「WS 不可用时的唯一退路」，多花一次请求换可用性是划算的。
  let r = await fetchJson(base + '/api/nodes', { ms: opts.restMs ?? Math.min(opts.ms ?? 10000, 8000) });
  if (!r.ok && /超时|timeout/i.test(r.error || '')) {
    r = await fetchJson(base + '/api/nodes', { ms: opts.restMs ?? Math.min(opts.ms ?? 10000, 8000) });
  }
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.data || !Array.isArray(r.data.data)) {
    return { ok: false, error: '响应里没有 data 数组' };
  }
  return {
    ok: true, kind, nodes: normalizeRest(r.data), raw: r.data, ms: r.ms, transport: 'rest',
    endpoint: base + '/api/nodes',
  };
}

/** 指纹：{data:[...], status:"success"} 且元素带 uuid 与 mem_total */
export function detect(j) {
  if (!j || typeof j !== 'object') return 0;
  let score = 0;
  if (Array.isArray(j.data) && typeof j.status === 'string') score += 4;
  const d = Array.isArray(j.data) ? j.data[0] : null;
  if (d && typeof d === 'object') {
    if ('uuid' in d) score += 3;
    if ('virtualization' in d) score += 3;
    if ('mem_total' in d && 'swap_total' in d) score += 2;
    if ('traffic_limit_type' in d) score += 2;
    if ('region_override' in d || 'deployment_status' in d) score += 2; // sunver 风格
    // 排除哪吒/极简
    if ('metrics' in d) score -= 4;
  }
  return score;
}

export { gb };
