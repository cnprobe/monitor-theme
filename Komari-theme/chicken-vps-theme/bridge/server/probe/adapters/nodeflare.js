// 适配器：NodeFlare
//
// 无公开线上实例，契约来自仓库源码（elysia62/NodeFlare，Rust/Axum）：
//   backend/src/routes/public.rs
//   backend/src/models.rs
//
// 匿名读取入口：`GET /api/bootstrap`
//   响应 BootstrapResponse {
//     config: PublicConfig,          // 站点配置
//     access: "ok" | "login" | "turnstile",   // ← 关键：决定 servers 是否为空
//     servers: ServerView[],         // access=="ok" 时才有内容
//     exchange_rates: {...} | null,
//   }
//
// NodeFlare 的字段命名和别家最接近 CF探针（`net_in/net_out`、`mem_used` 等），
// 单位按 models.rs 推断为字节 / B/s（与 Agent 上报一致），并在 meta 里标注未实测确认。
//
// 另有 `GET /api/history/{id}?hours=24` → {points:[HistoryPoint]} 提供历史时序；
// 但注意它受 require_dashboard 保护（公开看板模式下 access=="ok" 才可读）。

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { fetchJson, siteRoot } from '../http.js';
import { num, normLoad, pick, uptimeToSec, toMs, normRegion } from '../normalize.js';

export const kind = 'nodeflare';
export const transport = 'http';

const PUBLIC_FIELDS_REMOVED = [
  'hidden', 'last_ip', 'ip_v4', 'ip_v6', 'network_interface', 'reset_day',
  'report_interval', 'collect_interval', 'rx_correction', 'tx_correction',
  'agent_mirror', 'offline_notify_disabled', 'auto_update',
];

/** ServerView → 统一模型。字段名取自 models.rs，单位按字节/B/s 处理。 */
export function normalize(j) {
  const servers = Array.isArray(j?.servers) ? j.servers.filter(s => s && typeof s === 'object').slice(0, 1000) : [];
  const offlineThreshold = num(j?.config?.offline_threshold_seconds) ?? 300;

  return servers.map(s => {
    const node = emptyNode(pick(s, 'id', 'name') ?? 'unknown', kind);
    node.name = String(s.name || node.key);

    node.region = normRegion(pick(s, 'region'));
    node.location = String(pick(s, 'group_name', 'region') || '');
    node.os = s.os ? String(s.os) : null;
    node.virt = s.virtualization ? String(s.virtualization) : null;

    node.cpu = clampCpu(s.cpu);
    node.cores = num(s.cpu_cores);
    node.load = normLoad(s, { three: ['load1', 'load5', 'load15'] });

    node.memU = num(s.mem_used);
    node.memT = num(s.mem_total);
    node.swapU = num(s.swap_used);
    node.swapT = num(s.swap_total);
    node.diskU = num(s.disk_used);
    node.diskT = num(s.disk_total);

    node.netRx = num(s.net_in);
    node.netTx = num(s.net_out);
    node.netIn = num(s.net_rx_total);
    node.netOut = num(s.net_tx_total);

    node.uptime = uptimeToSec(s.uptime);
    // ServerView.timestamp 是上报时刻
    node.lastSeen = toMs(s.timestamp);

    // 有 timestamp 就能判在线：超过站点配置的离线阈值即离线
    const ts = node.lastSeen;
    node.online = ts !== null && (Date.now() - ts) < offlineThreshold * 1000;

    // 延迟：取 latency 数组里最新的非零值
    let ping = null;
    if (Array.isArray(s.latency) && s.latency.length) {
      const sorted = s.latency.filter(x => x && typeof x === 'object' && num(x.latency_ms) !== null).slice(-128)
        .sort((a, b) => num(b.timestamp) - num(a.timestamp));
      if (sorted.length) ping = num(sorted[0].latency_ms);
    }
    node.ping = ping;

    node.meta = {
      group: s.group_name || '',
      tags: s.tags || '',
      cpuModel: s.cpu_model || '',
      kernel: s.kernel || '',
      arch: s.arch || '',
      gpuModel: s.gpu_model || '',
      gpuUsage: num(s.gpu_usage),
      agent: s.agent_version || '',
      price: num(s.price),
      currency: s.currency || '',
      billingCycle: num(s.billing_cycle),
      trafficLimit: num(s.traffic_limit),
      trafficLimitType: s.traffic_limit_type || '',
      process: num(s.processes),
      tcp: num(s.tcp_connections),
      udp: num(s.udp_connections),
      diskIo: {
        readBps: num(s.disk_read_bps), writeBps: num(s.disk_write_bps),
        readIops: num(s.disk_read_iops), writeIops: num(s.disk_write_iops),
        awaitMs: num(s.disk_await_ms), util: num(s.disk_utilization),
      },
      latency: Array.isArray(s.latency) ? s.latency.slice(-128) : [],
      // 明确标注：本适配器的字段单位未在真实实例上验证过
      unitsUnverified: true,
    };
    return finalizeNode(node);
  });
}

export async function read(url, opts = {}) {
  const base = siteRoot(url);
  const r = await fetchJson(base + '/api/bootstrap', { ms: opts.ms ?? 10000, headers: opts.headers });
  if (!r.ok) return { ok: false, error: r.error, kind };

  const access = r.data?.access;
  const config = r.data?.config || null;

  if (access && access !== 'ok') {
    // 站点开启了登录或人机验证 → 拿不到机器列表，但配置仍可读
    const why = access === 'turnstile' ? '站点开启了人机验证' : '站点需要登录后查看';
    return {
      ok: true, kind, nodes: [], raw: r.data, config, ms: r.ms,
      mode: 'gated', warning: `${why}（access=${access}），无法读取机器数据`,
    };
  }

  return {
    ok: true, kind, nodes: normalize(r.data), raw: r.data, config, ms: r.ms,
    mode: 'bootstrap',
  };
}

/** 指纹：BootstrapResponse = {config, access, servers, exchange_rates} */
export function detect(j) {
  if (!j || typeof j !== 'object') return 0;
  let score = 0;
  if (typeof j.access === 'string' && /^(ok|login|turnstile)$/.test(j.access)) score += 8;
  if (Array.isArray(j.servers)) score += 2;
  if ('exchange_rates' in j) score += 2;
  const c = j.config;
  if (c && typeof c === 'object') {
    if ('offline_threshold_seconds' in c) score += 4;
    if ('public_dashboard' in c) score += 3;
    if ('show_latency' in c || 'show_uptime' in c) score += 2;
  }
  return score;
}

export { PUBLIC_FIELDS_REMOVED };
