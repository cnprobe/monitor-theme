// 适配器：CF探针（Cloudflare Server Monitor，/api/servers）
//
// 特征：顶层 {servers, latestReportUpdates, stats, regionStats, sysConfig}
// 单位与 ServerStatus **完全不同**：内存/硬盘是 MB，不是 KB。
// 最新时序在 latestReportUpdates[].samples[30].data 里。

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { fetchJson, siteRoot } from '../http.js';
import { num, mb, normLoad, pick, toMs, normRegion, bestPing, gb, bool } from '../normalize.js';

export const kind = 'cf';
export const transport = 'http';

/** 无显式 online 字段：用 last_updated / reportAgeMs 判新鲜度 */
const STALE_MS = 5 * 60 * 1000;

function isOnline(s, report) {
  const ts = toMs(pick(s, 'last_updated', 'timestamp'));
  if (report && num(report.reportAgeMs) !== null) {
    return num(report.reportAgeMs) < STALE_MS;
  }
  if (ts === null) return false;
  return Date.now() - ts < STALE_MS;
}

export function normalize(j) {
  const servers = Array.isArray(j?.servers) ? j.servers.filter(s => s && typeof s === 'object').slice(0, 1000) : [];
  const reports = Array.isArray(j?.latestReportUpdates) ? j.latestReportUpdates.filter(r => r && typeof r === 'object').slice(0, 1000) : [];
  const reportById = new Map();
  for (const r of reports) {
    if (r && r.serverId) reportById.set(String(r.serverId), r);
  }

  return servers.map(s => {
    const report = reportById.get(String(s.id)) || null;
    const node = emptyNode(pick(s, 'id', 'name', 'server_group') ?? 'unknown', kind);

    node.online = isOnline(s, report);
    node.name = String(s.name || node.key);

    node.region = normRegion(pick(s, 'region'));
    node.location = String(pick(s, 'region', 'server_group') || '');
    node.os = s.os ? String(s.os) : null;
    node.virt = s.arch ? String(s.arch) : null;

    node.cpu = clampCpu(s.cpu);
    node.cores = num(s.cpu_cores);
    node.load = normLoad(s, { str: 'load_avg' });

    // ★ 单位：MB（ServerStatus 是 KB，差 1024 倍）
    node.memU = mb(pick(s, 'ram_used'));
    node.memT = mb(pick(s, 'ram_total'));
    node.swapU = mb(pick(s, 'swap_used'));
    node.swapT = mb(pick(s, 'swap_total'));
    node.diskU = mb(pick(s, 'disk_used'));
    node.diskT = mb(pick(s, 'disk_total'));

    node.netRx = num(pick(s, 'net_in_speed'));
    node.netTx = num(pick(s, 'net_out_speed'));
    node.netIn = num(pick(s, 'net_rx'));
    node.netOut = num(pick(s, 'net_tx'));
    node.netMonthIn = num(pick(s, 'net_rx_monthly'));
    node.netMonthOut = num(pick(s, 'net_tx_monthly'));

    // ping_xx / loss_xx 可能是布尔 false，bestPing 已过滤
    node.ping = bestPing(s.ping_ct, s.ping_cu, s.ping_cm);
    // CF 不给 uptime，改由 boot_time 推
    const boot = toMs(s.boot_time);
    node.uptime = boot !== null ? Math.max(0, Math.round((Date.now() - boot) / 1000)) : null;
    node.lastSeen = toMs(pick(s, 'last_updated', 'timestamp'));

    node.meta = {
      group: s.server_group || '',
      tags: s.tags || '',
      price: num(s.price),
      currency: s.currency || '',
      billing: s.billing_cycle || '',
      expire: s.expire_date || '',
      // traffic_limit 是 GB 字符串，转成字节便于和别家对齐
      trafficLimit: gb(pick(s, 'traffic_limit')),
      cpuInfo: s.cpu_info || '',
      gpuInfo: s.gpu_info || '',
      kernel: s.kernel_version || '',
      agent: s.agent_version || '',
      processes: num(s.processes),
      tcp: num(s.tcp_conn), udp: num(s.udp_conn),
      diskIo: s.disk && typeof s.disk === 'object' ? {
        readBps: num(s.disk.read_bps), writeBps: num(s.disk.write_bps),
        readIops: num(s.disk.read_iops), writeIops: num(s.disk.write_iops),
        awaitMs: num(s.disk.await_ms), util: num(s.disk.util),
      } : null,
      // 30 点历史时序（cpu / 内存 / 网速）
      history: report && Array.isArray(report.samples)
        ? report.samples.filter(x => x && typeof x === 'object').slice(-64).map(x => ({
          ts: toMs(x.ts),
          cpu: clampCpu(x.data?.cpu),
          netRx: num(x.data?.net_in_speed),
          netTx: num(x.data?.net_out_speed),
          memU: mb(x.data?.ram_used),
          memT: mb(x.data?.ram_total),
        }))
        : [],
      reportAgeMs: num(report?.reportAgeMs),
      ipv4: bool(s.ip_v4), ipv6: bool(s.ip_v6),
    };
    return finalizeNode(node);
  });
}

export { normalize as normalizeCf };

export async function read(url, opts = {}) {
  const target = opts.endpoint || opts.foundEndpoint
    || (/\/api\/servers$/i.test(url) ? url : siteRoot(url) + '/api/servers');
  const r = await fetchJson(target, { ms: opts.ms ?? 12000, headers: opts.headers });
  if (!r.ok) return { ok: false, error: r.error, kind, endpoint: target };
  if (!r.data || !Array.isArray(r.data.servers)) {
    return { ok: false, error: '响应里没有 servers 数组', kind, endpoint: target };
  }
  return {
    ok: true, kind, nodes: normalize(r.data), raw: r.data, ms: r.ms, endpoint: target,
    // 顶层汇总可直接给 HUD 用
    summary: r.data.stats || null,
    regions: r.data.regionStats || null,
  };
}

export function detect(j) {
  if (!j || typeof j !== 'object') return 0;
  let score = 0;
  if (Array.isArray(j.latestReportUpdates)) score += 6;
  if (j.sysConfig && typeof j.sysConfig === 'object') score += 3;
  if (j.regionStats && typeof j.regionStats === 'object') score += 2;
  const s = Array.isArray(j.servers) ? j.servers[0] : null;
  if (s && typeof s === 'object') {
    if ('net_in_speed' in s) score += 3;
    if ('ram_total' in s) score += 2;
    if ('server_group' in s) score += 2;
  }
  return score;
}
