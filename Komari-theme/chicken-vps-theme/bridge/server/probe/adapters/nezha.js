// 适配器：哪吒（Nezha）— 仅支持 v1 面板
//
// ⚠ 兼容性说明（重要）：本适配器按 **哪吒 v1 面板** 实测实现。
//   哪吒 v0 系 / 魔改版 / v2（TSDB 版）接口路径与认证信封都不同，**不保证可用**。
//   遇到读不到数据的哪吒站点，先确认面板版本是否为 v1。
//
// 实测结论（nezha v1 面板）：
//   GET /api/v1/server          🔒 需 token → 200 + {"error":"ApiErrorUnauthorized"}
//   GET /api/v1/server/list     🔒 需 token → 200 + {"code":403,...}（旧版路径）
//   GET /api/v1/setting         ✅ 公开 → {success, data:{config, tsdb_enabled}}
//   GET /api/v1/service         ✅ 公开 → 监控任务 30 点时序
//   WSS /api/v1/ws/server       ✅ 公开 → {now, online, servers:[...]} 实时推送全部机器
//                               （面板前端实时页同款通道，host/state 全量，无需 token）
//
// 所以本适配器有「三模式」：
//   1. 公开 WS 机器流（优先）：无 token 也能读到全部真实机器
//      （CPU/内存/硬盘/流量齐全）。
//      ⚠ 顶层 online 计数不可信（实测 23 台 state 全在实时跳动、它却报 2），
//        机器在线与否用 last_active 新鲜度判定（agent 一死它就冻结）。
//   2. 有 token → REST 机器列表（数据最全，含 tag 等管理字段）
//   3. 都不行 → 用 /api/v1/service 造出「服务监控」型节点（降级但可用，
//      总比整个站点判为不可用强；游戏侧 keepGameNodes 会把它们筛掉）
//
// ⚠ 认证失败返回 HTTP 200，必须靠 body 判断（已在 http.js 里统一处理）。

import { emptyNode, finalizeNode, clampCpu } from '../model.js';
import { fetchJson, siteRoot } from '../http.js';
import { num, bestPing, toMs, normRegion } from '../normalize.js';
import WebSocket from 'ws';

export const kind = 'nezha';
export const transport = 'http';

// 新版与旧版路径都要试
const SERVER_PATHS = ['/api/v1/server', '/api/v1/server/list', '/api/v1/servers'];
const PUBLIC_PATHS = ['/api/v1/setting', '/api/v1/service'];
// 公开机器流：面板前端实时页用的就是它（无 token 可读）
const WS_PATH = '/api/v1/ws/server';
// 首条消息可能是缓存快照（实测会旧约 2 分钟），多收几条、用最后一条
const WS_GATHER_MS = 4500;
// last_active 新鲜度阈值：agent 停报超过 90s 视为离线
const WS_ONLINE_MS = 90 * 1000;

/**
 * 从 CPU 描述里抠核数。agent 上报的 host.cpu 是「型号字符串数组」
 * （如 ["Intel(R) Xeon(R) Platinum 2 Virtual Core"]），数组长度 ≠ 核数。
 * 优先匹配 "N (virtual|v)? core"，其次 "N vCPU"；实在没有才看数组长度（>1 时）。
 */
export function parseCores(cpuField) {
  if (typeof cpuField === 'number') return cpuField > 0 ? cpuField : null;
  if (typeof cpuField === 'string') {
    const n0 = num(cpuField);
    return n0 !== null && n0 > 0 ? n0 : null;
  }
  if (!Array.isArray(cpuField) || !cpuField.length) return null;
  const joined = cpuField.map(String).join(' ');
  const m1 = joined.match(/(\d+)\s*-?\s*(?:v(?:irtual)?\s*)?cores?\b/i);
  if (m1) return num(m1[1]);
  const m2 = joined.match(/(\d+)\s*v?cpu\b/i);
  if (m2) return num(m2[1]);
  return cpuField.length > 1 ? cpuField.length : null;
}

/** 有 token：解析机器列表（不同版本字段差异较大，做了多层兜底） */
export function normalizeServers(j) {
  const list = Array.isArray(j?.data) ? j.data
    : Array.isArray(j?.servers) ? j.servers
      : Array.isArray(j?.data?.servers) ? j.data.servers
        : Array.isArray(j?.data?.list) ? j.data.list
          : [];
  return list
    .filter(s => s && typeof s === 'object')
    .slice(0, 1000)
    .map(s => {
    const h = s.host && typeof s.host === 'object' ? s.host : {};
    const st = s.state && typeof s.state === 'object' ? s.state : {};
    const node = emptyNode(s.id != null ? `nz-${s.id}` : (s.name || 'unknown'), kind);
    node.name = String(s.name || node.key);
    node.online = (st.online ?? st.status ?? s.online) !== false && !!s.id;
    // 新版把状态放在 state 里
    if (typeof st.online === 'boolean') node.online = st.online;
    node.os = h.platform ? String(h.platform) : null;
    node.cores = parseCores(h.cpu);
    node.cpu = clampCpu(st.cpu);
    node.load = Array.isArray(st.load) ? st.load.map(num) : (num(st.load) !== null ? [num(st.load), num(st.load), num(st.load)] : null);
    node.memU = num(st.mem_used);
    node.memT = num(h.mem_total ?? st.mem_total);
    node.swapU = num(st.swap_used);
    node.swapT = num(h.swap_total ?? st.swap_total);
    node.diskU = num(st.disk_used ?? h.disk_used);
    node.diskT = num(h.disk_total ?? st.disk_total);
    node.netRx = num(st.net_in_speed ?? st.net_in_transfer);
    node.netTx = num(st.net_out_speed ?? st.net_out_transfer);
    node.netIn = num(st.net_in_transfer);
    node.netOut = num(st.net_out_transfer);
    node.ping = bestPing(st.ping ?? h.ping, st.tcp_ping);
    node.uptime = num(st.uptime);   // 秒（WS 机器流带 uptime；REST 老代码一直漏了它）
    // WS 机器流给的是 last_active（ISO 字符串）；REST 给的是 updated_at
    node.lastSeen = toMs(st.updated_at ?? s.updated_at ?? s.last_active);
    if (node.lastSeen !== null) node.online = node.online && Date.now() - node.lastSeen < 5 * 60 * 1000;
    node.region = normRegion(s.country_code);
    node.meta = {
      platform: h.platform || '', version: h.version || '', tag: s.tag || '',
      arch: h.arch || '',
      country: s.country_code || '',
      cpuName: Array.isArray(h.cpu) ? String(h.cpu[0] || '') : '',
      note: typeof s.public_note === 'string' ? s.public_note : '',
    };
    return finalizeNode(node);
  });
}

/**
 * 无 token：把 /api/v1/service 的监控任务转成"服务节点"。
 * 这类节点没有 CPU/RAM，但有延迟与可用性时序 —— 对"网络质量"展示仍然有价值。
 */
export function normalizeServices(j) {
  const svcs = j?.data?.services;
  if (!svcs || typeof svcs !== 'object') return [];
  const out = [];
  for (const id of Object.keys(svcs).slice(0, 1000)) {
    const s = svcs[id];
    if (!s || typeof s !== 'object') continue;
    const node = emptyNode(`svc-${id}`, kind);
    node.name = String(s.service_name || `服务 ${id}`);
    // current_up > 0 且有延迟即视为可用
    const cur = num(s.current_up);
    node.online = cur !== null ? cur > 0 : true;
    node.ping = bestPing(s.current_down, s.current_up) ?? null;
    // 取 delay 里最后一个非零值作为代表延迟
    if (Array.isArray(s.delay)) {
      const last = s.delay.slice(-128).reverse().map(num).find(v => v !== null && v > 0);
      if (last !== undefined) node.ping = last;
    }
    node.uptime = null;
    node.meta = {
      isService: true,           // 标记：这是监控服务，不是机器
      currentUp: cur,
      currentDown: num(s.current_down),
      totalUp: num(s.total_up),
      totalDown: num(s.total_down),
      delay: Array.isArray(s.delay) ? s.delay.slice(-128).map(num) : [],
      upSeries: Array.isArray(s.up) ? s.up.slice(-128).map(num) : [],
      downSeries: Array.isArray(s.down) ? s.down.slice(-128).map(num) : [],
    };
    out.push(finalizeNode(node));
  }
  return out;
}

/**
 * 公开机器流：连 ws(s)://<host>/api/v1/ws/server，收几条推送、用最后一条。
 * 这是面板前端实时页的同款通道，无 token 可读 —— 机器的 host/state 全在里面。
 *
 * 为什么收多条：实测首条消息可能是缓存快照（state 旧约 2 分钟），之后每 2s 一条；
 * 到点（4.5s）或超时就用「最后一条」，避免拿旧数据。
 * 为什么不用顶层 online 字段：实测 23 台 state 全在实时跳动、它却报 2 ——
 * 机器在线与否改用 last_active 新鲜度（agent 一死它就冻结）。
 */
export async function readWsMachines(base, { ms = 9000 } = {}) {
  let u;
  try { u = new URL(base); } catch (e) { return { ok: false, error: 'URL 无法解析：' + e.message }; }
  const wsUrl = (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + u.pathname.replace(/\/+$/, '') + WS_PATH;

  return await new Promise(resolve => {
    let ws = null;
    let settled = false;
    let last = null;              // 最后收到的完整机器推送
    const t0 = Date.now();
    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(gatherTimer);
      try { ws && ws.close(); } catch { /* ignore */ }
      resolve(r);
    };
    const settleWith = () => {
      if (!last) return finish({ ok: false, error: 'WS 连接超时且未收到机器数据' });
      try {
        const nodes = normalizeServers(last);
        // 在线判据：last_active 距今 < 90s（比 normalizeServers 的 5 分钟阈值更紧，
        // 面板 2s 一推，90s 没动静基本就是 agent 挂了）
        for (const n of nodes) n.online = n.lastSeen !== null && (Date.now() - n.lastSeen) < WS_ONLINE_MS;
        finish({ ok: true, nodes, raw: last, ms: Date.now() - t0, transport: 'ws' });
      } catch (error) {
        finish({ ok: false, error: `WS 数据解析失败：${error.message}` });
      }
    };
    const totalTimer = setTimeout(settleWith, ms);
    const gatherTimer = setTimeout(settleWith, Math.min(ms - 500, WS_GATHER_MS));

    try {
      ws = new WebSocket(wsUrl, {
        headers: { Origin: u.origin, 'User-Agent': 'Mozilla/5.0' },
        handshakeTimeout: Math.min(ms, 8000),
        maxPayload: 2 * 1024 * 1024,
      });
    } catch (e) {
      return finish({ ok: false, error: 'WS 创建失败：' + e.message });
    }

    ws.on('message', d => {
      try {
        const j = JSON.parse(d.toString());
        if (j && Array.isArray(j.servers)) last = j;   // 只认机器推送，别的帧忽略
      } catch { /* 非 JSON 帧（心跳等）忽略 */ }
    });
    ws.on('error', e => {
      if (last) return settleWith();    // 已经拿到数据就不算失败
      finish({ ok: false, error: 'WS 错误：' + (e.message || 'websocket error') });
    });
    ws.on('close', () => {
      if (settled) return;
      if (last) return settleWith();
      finish({ ok: false, error: 'WS 连接被关闭且未收到机器数据' });
    });
  });
}

export async function read(url, opts = {}) {
  const base = siteRoot(url);
  const token = opts.token || opts.apiToken || null;
  const headers = token ? { Authorization: token } : {};
  const ms = opts.ms ?? 10000;

  // ---- 有 token：REST 机器路径优先（数据最全，含 tag 等管理字段）----
  // 面板就算禁用了公开 WS，token 模式也不受影响。
  if (token) {
    for (const p of SERVER_PATHS) {
      const r = await fetchJson(base + p, { ms, headers });
      if (r.ok) {
        const nodes = normalizeServers(r.data);
        if (nodes.length) {
          return { ok: true, kind, nodes, raw: r.data, setting: null, ms: r.ms, transport: 'http', mode: 'servers' };
        }
      }
    }
  }

  // ---- 公开机器流（无 token 的主通道）+ 公开配置 + 监控任务，三路并行 ----
  // 老代码串行试 PUBLIC_PATHS，service 一可读就提前返回 —— 机器永远读不到
  // （有 token 也一样，token 路径根本走不到，这是个隐藏 bug）。
  // 并行之后最坏耗时 = max(三路)，而不是累加。
  const wsP = readWsMachines(base, { ms: Math.min(ms, 9000) });
  const settingP = fetchJson(base + '/api/v1/setting', { ms, headers });
  const serviceP = fetchJson(base + '/api/v1/service', { ms });
  // 走别的分支时别让还没落定的 promise 变成 unhandled rejection
  settingP.catch(() => {});
  serviceP.catch(() => {});

  const wsR = await wsP;
  if (wsR.ok && wsR.nodes.length) {
    return {
      ok: true, kind, nodes: wsR.nodes, raw: wsR.raw, setting: null,
      ms: wsR.ms, transport: 'ws', mode: 'ws-servers',
    };
  }
  const wsErr = wsR.error || '无数据';

  const [settingR, serviceR] = await Promise.all([
    settingP.catch(e => ({ ok: false, error: e?.message || String(e) })),
    serviceP.catch(e => ({ ok: false, error: e?.message || String(e) })),
  ]);
  const setting = settingR.ok && settingR.data?.data?.config ? settingR.data : null;
  const svcNodes = serviceR.ok ? normalizeServices(serviceR.data) : [];

  // ---- 服务监控任务（降级展示；游戏侧 keepGameNodes 会筛掉）----
  if (svcNodes.length) {
    return {
      ok: true, kind, nodes: svcNodes, raw: serviceR.data, setting, ms: serviceR.ms, transport: 'http',
      mode: 'services',
      warning: `WS 机器流不可用（${wsErr}）；${token ? '机器列表读取失败，已降级为服务监控视图'
        : '未提供 token，仅能读取公开的监控服务（无机器 CPU/内存）'}`,
    };
  }

  // ---- 连公开接口都没有 ----
  if (setting) {
    return {
      ok: true, kind, nodes: [], raw: setting, setting, ms: settingR.ms, transport: 'http',
      mode: 'setting-only',
      warning: `WS 机器流不可用（${wsErr}）；该哪吒站点未开放机器列表与监控服务，只能读到站点配置`,
    };
  }
  return { ok: false, error: serviceR.error || wsErr || '未找到可读的哪吒接口', kind };
}

/** 指纹：{error:"ApiErrorUnauthorized"} / {code:403,...} / {success,data:{services}} */
export function detect(j) {
  if (!j || typeof j !== 'object') return 0;
  let score = 0;
  if (typeof j.error === 'string' && /ApiError/i.test(j.error)) score += 8;
  if (typeof j.code === 'number' && /认证|Unauthorized/i.test(String(j.message || ''))) score += 8;
  if (j.success === true && j.data && typeof j.data === 'object') {
    if (j.data.services) score += 7;
    if (j.data.config && j.data.config.site_name !== undefined) score += 5;
    if ('tsdb_enabled' in j.data) score += 3;
  }
  return score;
}

export { SERVER_PATHS, PUBLIC_PATHS, WS_PATH, WS_ONLINE_MS };
