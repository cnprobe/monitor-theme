// 适配器：CF VPS Monitor（基于 Cloudflare Workers 的服务器监控探针）
//
// 特征：GET /api/live/clients →
//   { online: [uuid...], count, clients: [{ uuid, name, cpu, ram, ram_total, swap,
//       disk, disk_total, net_in, net_out, net_total_up, net_total_down, uptime, ... }] }
//   另有 GET /api/nodes 提供静态元数据（cpu_name / virtualization / os / region / 价格），
//   与 live 数据按 uuid 合并 —— 合并失败不影响指标（只是少点说明信息）。
// ⚠ /api/ws/live 需要 token（实测 401），REST 快照足够，不必碰 WS。
// 单位：字节 / B·s⁻¹ / 秒（与读取器契约一致，游戏侧再转 KB/MB）

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { fetchJson, siteRoot } from '../http.js';
import { num, pick, uptimeToSec, toMs, normRegion, bool } from '../normalize.js';

export const kind = 'cfvpsmon';
export const transport = 'http';

export function normalize(j, metaByUuid = new Map()) {
  const clients = Array.isArray(j?.clients) ? j.clients.filter(c => c && typeof c === 'object').slice(0, 1000) : [];
  const onlineSet = new Set(Array.isArray(j?.online) ? j.online.slice(0, 5000) : []);
  return clients.map(c => {
    const node = emptyNode(pick(c, 'uuid', 'name') ?? 'unknown', kind);
    const meta = metaByUuid.get(String(c.uuid)) || {};

    // online 数组是权威来源；个别版本没有时退化为 lastReportTime 新鲜度
    const seen = toMs(c.lastReportTime);
    node.online = onlineSet.has(c.uuid) ||
      (bool(c.online) === true) ||
      (seen !== null && Date.now() - seen < 5 * 60 * 1000);
    // ★ 名字优先用 /api/nodes 里的显示名（用户在面板里自定义的，如 Dartnode2C）；
    //   live 快照里的 name 是 agent 上报的主机名，可能与面板名不一致（第 54 轮用户实测）。
    node.name = String(meta.name || c.name || node.key);

    node.region = normRegion(meta.region);
    node.location = String(meta.region || '');
    node.os = meta.os ? String(meta.os) : null;
    node.virt = meta.virtualization ? String(meta.virtualization) : null;

    node.cpu = clampCpu(c.cpu);
    node.cores = num(meta.cpu_cores);
    node.load = null; // 标量负载，不拼成数组（模型里 load 是 [1m,5m,15m]）

    node.memU = num(c.ram);
    node.memT = num(c.ram_total);
    node.swapU = num(c.swap);
    node.swapT = num(c.swap_total);
    node.diskU = num(c.disk);
    node.diskT = num(c.disk_total);

    // net_in / net_out 是瞬时网速（B/s）；net_total_* 是累计流量（字节）
    node.netRx = num(c.net_in);
    node.netTx = num(c.net_out);
    node.netIn = num(c.net_total_down);
    node.netOut = num(c.net_total_up);
    node.netMonthIn = null;
    node.netMonthOut = null;

    node.ping = null;
    node.uptime = uptimeToSec(c.uptime);
    node.lastSeen = seen;

    node.meta = {
      cpuName: meta.cpu_name || '',
      arch: meta.arch || '',
      kernel: meta.kernel_version || '',
      gpu: meta.gpu_name || '',
      price: num(meta.price), currency: meta.currency || '', billing: meta.billing_cycle || '',
      expiresAt: meta.expired_at || '',
      trafficLimit: num(meta.traffic_limit), trafficMode: meta.traffic_limit_type || '',
      agent: c.version || '',
      procs: num(c.process_count), tcp: num(c.connections), udp: num(c.connections_udp),
      temp: c.temp ?? null,
    };
    return finalizeNode(node);
  });
}

export async function read(url, opts = {}) {
  const target = opts.endpoint || opts.foundEndpoint
    || (/\/api\/live\/clients$/i.test(url) ? url : siteRoot(url) + '/api/live/clients');
  const r = await fetchJson(target, { ms: opts.ms ?? 10000, headers: opts.headers });
  if (!r.ok) return { ok: false, error: r.error, kind, endpoint: target };
  if (!r.data || !Array.isArray(r.data.clients)) {
    return { ok: false, error: '响应里没有 clients 数组', kind, endpoint: target };
  }

  // 静态元数据：尽力合并（/api/nodes），失败只少说明信息、不影响指标
  const metaByUuid = new Map();
  try {
    const m = await fetchJson(siteRoot(target) + '/api/nodes', {
      ms: Math.min(opts.ms ?? 10000, 8000), headers: opts.headers
    });
    if (m.ok && Array.isArray(m.data)) {
      for (const it of m.data.slice(0, 5000)) if (it && typeof it === 'object' && it.uuid) metaByUuid.set(String(it.uuid), it);
    }
  } catch { /* 元数据拿不到就只用 live 数据 */ }

  const nodes = normalize(r.data, metaByUuid);
  if (!nodes.length) return { ok: false, error: 'clients 为空', kind, endpoint: target };
  return { ok: true, kind, nodes, raw: r.data, ms: r.ms, endpoint: target };
}

export function detect(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.clients)) return 0;
  let score = 0;
  if (Array.isArray(j.online)) score += 4;
  if (typeof j.count === 'number') score += 2;
  const c = j.clients[0];
  if (c && typeof c === 'object') {
    if ('uuid' in c) score += 2;
    if ('ram_total' in c && 'net_total_up' in c) score += 6;
    if ('net_in' in c && 'net_out' in c) score += 2;
  }
  return score;
}
