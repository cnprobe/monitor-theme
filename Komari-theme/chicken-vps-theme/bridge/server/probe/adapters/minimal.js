// 适配器：极简探针（/api/nodes）
//
// 特征：顶层 {admin, nodes}
// ★ 关键：静态信息在顶层，实时指标全在 `metrics` 子对象里。
//   只看顶层会误判为"没有 CPU/RAM"。
// 单位：字节（比 ServerStatus 的 KB/MB 友好）

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { fetchJson, siteRoot } from '../http.js';
import { num, normLoad, pick, uptimeToSec, toMs, normRegion, bool } from '../normalize.js';

export const kind = 'minimal';
export const transport = 'http';

const STALE_MS = 5 * 60 * 1000;

export function normalize(j) {
  const nodes = Array.isArray(j?.nodes) ? j.nodes.filter(n => n && typeof n === 'object').slice(0, 1000) : [];
  return nodes.map(s => {
    const m = (s.metrics && typeof s.metrics === 'object') ? s.metrics : {};
    const node = emptyNode(pick(s, 'id', 'name') ?? 'unknown', kind);

    const seen = toMs(pick(s, 'last_seen'));
    node.online = bool(s.online) ?? (seen !== null && Date.now() - seen < STALE_MS);
    node.name = String(s.name || node.key);

    // country 承担了别家的 region 角色
    node.region = normRegion(pick(s, 'country', 'region'));
    node.location = String(pick(s, 'country', 'region') || '');
    node.os = s.os ? String(s.os) : null;
    node.virt = s.virt ? String(s.virt) : null;

    node.cpu = clampCpu(m.cpu ?? s.cpu);
    node.cores = num(pick(s, 'cpu_cores'));
    // ★ load 是 array[3]，全类型里独一份
    node.load = normLoad(m, { arr: 'load' }) || normLoad(s, { arr: 'load' });

    // 单位已是字节：顶层与 metrics 有重复，metrics 优先（更实时）
    node.memU = num(pick(m, 'mem_used', 'memUsed') ?? s.mem_used);
    node.memT = num(pick(m, 'mem_total') ?? s.mem_total);
    node.swapU = num(pick(m, 'swap_used') ?? s.swap_used);
    node.swapT = num(pick(m, 'swap_total') ?? s.swap_total);
    node.diskU = num(pick(m, 'disk_used') ?? s.disk_used);
    node.diskT = num(pick(m, 'disk_total') ?? s.disk_total);

    node.netRx = num(pick(m, 'net_rx') ?? s.net_rx);
    node.netTx = num(pick(m, 'net_tx') ?? s.net_tx);
    node.netIn = num(pick(m, 'total_rx', 'totalRx') ?? s.total_rx);
    node.netOut = num(pick(m, 'total_tx', 'totalTx') ?? s.total_tx);
    node.netMonthIn = num(pick(m, 'month_rx', 'monthRx') ?? s.month_rx);
    node.netMonthOut = num(pick(m, 'month_tx', 'monthTx') ?? s.month_tx);

    node.ping = null; // 极简探针不提供延迟
    node.uptime = uptimeToSec(pick(m, 'uptime') ?? s.uptime);
    node.lastSeen = seen;

    node.meta = {
      agent: s.agent_version || '',
      arch: s.arch || '',
      kernel: s.kernel || '',
      cpuName: s.cpu_name || '',
      price: num(s.price), currency: s.currency || '', billing: s.billing_cycle || '',
      expiresAt: s.expires_at || '',
      trafficLimit: num(s.traffic_limit),
      trafficMode: s.traffic_mode || '',
      trafficResetDay: num(s.traffic_reset_day),
      monthStart: s.month_start || '',
      dayRx: num(s.day_rx), dayTx: num(s.day_tx),
      monthUsed: num(s.month_used),
      procs: num(m.procs), tcp: num(m.tcp), udp: num(m.udp),
    };
    return finalizeNode(node);
  });
}

export async function read(url, opts = {}) {
  const target = opts.endpoint || opts.foundEndpoint
    || (/\/api\/nodes$/i.test(url) ? url : siteRoot(url) + '/api/nodes');
  const r = await fetchJson(target, { ms: opts.ms ?? 10000, headers: opts.headers });
  if (!r.ok) return { ok: false, error: r.error, kind, endpoint: target };
  if (!r.data || !Array.isArray(r.data.nodes)) {
    return { ok: false, error: '响应里没有 nodes 数组', kind, endpoint: target };
  }
  return { ok: true, kind, nodes: normalize(r.data), raw: r.data, ms: r.ms, endpoint: target };
}

export function detect(j) {
  if (!j || typeof j !== 'object') return 0;
  let score = 0;
  if (Array.isArray(j.nodes) && typeof j.admin === 'boolean') score += 6;
  const n = Array.isArray(j.nodes) ? j.nodes[0] : null;
  if (n && typeof n === 'object') {
    if (n.metrics && typeof n.metrics === 'object') score += 6;
    if ('day_rx' in n || 'day_tx' in n) score += 2;
    if ('country' in n) score += 2;
    // 排除 Komari：Komari 是 {data}, 不是 {nodes}
    if ('uuid' in n) score -= 4;
  }
  return score;
}
