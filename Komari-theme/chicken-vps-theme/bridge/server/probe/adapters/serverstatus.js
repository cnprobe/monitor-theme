// 适配器：ServerStatus（/json/stats.json）
//
// 实测三站点差异：
//   基础版：load（单值）、无 cpu_cores
//   ssr.rs          扩展版：load_1/5/15、cpu_cores、labels、last_network_in/out
//   tz.cloudcpp.com 超集：再加 cpu_model、os、io_read/write、sslcerts
// 适配器必须对字段缺失全面容错。

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { fetchJson, siteRoot } from '../http.js';
import { num, num0, kb, mb, normLoad, pick, uptimeToSec, toMs, normRegion, bestPing, bool } from '../normalize.js';

export const kind = 'serverstatus';
export const transport = 'http';

/** 从 `labels`（"ndd=2027/03/05;spec=1C/2G/20G;;os=debian"）与 `custom` 里取键值 */
function parseKv(s) {
  const out = Object.create(null);
  if (!s || typeof s !== 'string') return out;
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function normalize(j) {
  const servers = Array.isArray(j?.servers) ? j.servers.filter(s => s && typeof s === 'object').slice(0, 1000) : [];
  return servers.map(s => {
    const node = emptyNode(s.name ?? s.host ?? 'unknown', kind);

    node.online = bool(pick(s, 'online4', 'online6')) ?? (!!s.online4 || !!s.online6);
    node.name = String(s.name || s.host || node.key);

    node.region = normRegion(pick(s, 'region', 'location'));
    node.location = String(pick(s, 'location', 'host') || '');
    node.os = s.os ? String(s.os) : null;

    node.cpu = clampCpu(s.cpu);
    node.cores = num(pick(s, 'cpu_cores'));
    node.load = normLoad(s, { three: ['load_1', 'load_5', 'load_15'], single: 'load' });

    // 单位：内存 KB、硬盘 MB（跨类型最容易错的两处）
    node.memU = kb(pick(s, 'memory_used'));
    node.memT = kb(pick(s, 'memory_total'));
    node.swapU = kb(pick(s, 'swap_used'));
    node.swapT = kb(pick(s, 'swap_total'));
    node.diskU = mb(pick(s, 'hdd_used'));
    node.diskT = mb(pick(s, 'hdd_total'));

    node.netRx = num(pick(s, 'network_rx'));
    node.netTx = num(pick(s, 'network_tx'));
    node.netIn = num(pick(s, 'network_in'));
    node.netOut = num(pick(s, 'network_out'));

    node.ping = bestPing(s.ping_10010, s.ping_189, s.ping_10086);
    node.uptime = uptimeToSec(pick(s, 'uptime'));
    node.lastSeen = toMs(pick(s, 'latest_ts', 'updated'));

    node.meta = {
      type: s.type || '',
      alias: s.alias || '',
      cpu_model: s.cpu_model || '',
      labels: parseKv(s.labels),
      custom: parseKv(s.custom),
      tcp: num(s.tcp_count), udp: num(s.udp_count),
      process: num(s.process_count), thread: num(s.thread_count),
      ioRead: num(s.io_read), ioWrite: num(s.io_write),
      // 保留原始网络字段，便于上层需要时对照
      raw: { network_in: num0(s.network_in), network_out: num0(s.network_out) },
    };
    return finalizeNode(node);
  });
}

export async function read(url, opts = {}) {
  // 本适配器「直接吃端点」：优先用调用方探测到的确切端点，退化时才自己拼。
  const target = opts.endpoint || opts.foundEndpoint
    || (/\.json(\?|$)/i.test(url) ? url : siteRoot(url) + '/json/stats.json');
  const r = await fetchJson(target, { ms: opts.ms ?? 10000, headers: opts.headers });
  if (!r.ok) return { ok: false, error: r.error, kind, endpoint: target };
  if (!r.data || !Array.isArray(r.data.servers)) {
    return { ok: false, error: '响应里没有 servers 数组', kind, endpoint: target };
  }
  return { ok: true, kind, nodes: normalize(r.data), raw: r.data, ms: r.ms, endpoint: target };
}

/** 指纹：ServerStatus 的 servers 一定带 online4/online6 */
export function detect(j) {
  const servers = j?.servers;
  if (!Array.isArray(servers) || !servers.length) return 0;
  const s = servers[0];
  if (!s || typeof s !== 'object') return 0;
  let score = 0;
  if ('online4' in s || 'online6' in s) score += 6;
  if ('memory_total' in s) score += 2;
  if ('hdd_total' in s) score += 1;
  if ('network_rx' in s) score += 1;
  // 与 CF探针区分：CF 有 latestReportUpdates / sysConfig
  if (j.latestReportUpdates || j.sysConfig) score -= 5;
  return score;
}
