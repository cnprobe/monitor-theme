// 通用探针读取器（门面）
//
// 用法：
//   const r = await readProbe('https://your-panel.example.com/json/stats.json');
//   r.kind      // 'serverstatus' | 'cf' | 'minimal' | 'komari' | 'nezha' | 'nodeget' | 'nodeflare' | 'cfvpsmon'
//   r.nodes     // 统一模型的节点数组
//   r.warning   // 降级/部分失败说明（有才给）
//
// 设计原则：
//   1. **自动识别类型**：调用方不必声明站点是哪一类。
//   2. **先试后判**：先按 URL 形态猜候选端点，再按响应指纹定类型，最后逐个复核。
//   3. **绝不静默失败**：拿不到数据时给出人能看懂的原因；部分失败走降级但保留 warning。
//   4. **纯函数归一化**：每个适配器可以只用 fixture 离线单测。

import * as serverstatus from './adapters/serverstatus.js';
import * as cf from './adapters/cf.js';
import * as minimal from './adapters/minimal.js';
import * as komari from './adapters/komari.js';
import * as nezha from './adapters/nezha.js';
import * as nodeget from './adapters/nodeget.js';
import * as nodeflare from './adapters/nodeflare.js';
import * as cfvpsmon from './adapters/cfvpsmon.js';
import * as generic from './adapters/generic.js';
import { fetchJson, normalizeBase, siteRoot, describeError, withTempShareCookie } from './http.js';
import { num } from './normalize.js';
import { isOriginAllowed, resolveProbeSecurity, withoutRemoteCredentials } from '../security.js';

export const ADAPTERS = { serverstatus, cf, minimal, komari, nezha, nodeget, nodeflare, cfvpsmon, generic };

/** 合并调用方 headers 与 token；显式 Authorization 头优先。 */
function requestHeaders(opts = {}) {
  let headers = { ...(opts.headers && typeof opts.headers === 'object' ? opts.headers : {}) };
  const hasAuthorization = Object.keys(headers).some(key => key.toLowerCase() === 'authorization');
  if (opts.token && !hasAuthorization) headers.Authorization = opts.token;
  headers = withTempShareCookie(headers, opts.shareKey);
  return Object.keys(headers).length ? headers : undefined;
}

// 按指纹强弱排序：越靠前越"专有"，越不容易误判。
// **generic 绝不参与指纹判定** —— 它靠结构嗅探，会误抢已知类型的响应。
const FINGERPRINT_ORDER = ['cfvpsmon', 'nodeflare', 'cf', 'minimal', 'komari', 'nezha', 'serverstatus'];

const SAFE_PLAIN_HTTP_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'user-agent', 'x-requested-with',
]);

function hasAuthorization(headers) {
  return Object.keys(headers || {}).some(key => /^authorization$/i.test(key));
}

function hasNonProtocolHeader(headers) {
  return Object.keys(headers || {}).some(key => !SAFE_PLAIN_HTTP_HEADERS.has(String(key).toLowerCase()));
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * 按响应指纹判定类型。返回 { kind, score, all }。
 * score < 4 视为不可信，调用方应继续尝试其它端点。
 */
export function detectKind(json) {
  const all = [];
  for (const name of FINGERPRINT_ORDER) {
    const a = ADAPTERS[name];
    if (typeof a.detect !== 'function') continue;
    let score = 0;
    try { score = a.detect(json) || 0; } catch { score = 0; }
    if (score > 0) all.push({ kind: name, score });
  }
  all.sort((a, b) => b.score - a.score);
  return { kind: all[0]?.kind || null, score: all[0]?.score || 0, all };
}

/** 按 URL 形态生成候选端点（按可能性排序） */
export function candidateEndpoints(input) {
  const base = normalizeBase(input);
  let path = '';
  try { path = new URL(base).pathname.replace(/\/+$/, ''); } catch { /* ignore */ }

  // 已经给了具体端点 → 只用它
  if (/\.json(\?|$)/.test(path) || /\/api\/v1\//.test(path) || /\/api\/nodes$/.test(path)
    || /\/api\/servers$/.test(path) || /\/api\/bootstrap$/.test(path)) {
    return [base];
  }

  const root = siteRoot(base);
  const paths = [
    '/json/stats.json',   // ServerStatus（最常见）
    '/api/servers',       // CF探针
    '/api/live/clients',  // CF VPS Monitor（实时快照，无需鉴权）
    '/api/nodes',         // 极简探针 / Komari REST / CF VPS Monitor 元数据
    '/api/bootstrap',     // NodeFlare
    '/api/v1/service',    // 哪吒 v1（公开降级；仅兼容 v1 面板）
    '/config.json',       // Nodeget
  ];
  const out = paths.map(p => root + p);

  // 未知程序兜底：用户给的可能是「一个具体路径」（如 /myown/monitor），
  // siteRoot() 认不出它（不在后缀表里）于是原样保留，拼出来全是错路径。
  // 这种情况额外把「根 + 常见通用路径」也试一遍 —— 只要站点是常规部署就能命中。
  try {
    const u = new URL(base);
    const basePath = u.pathname.replace(/\/+$/, '');
    if (basePath) {
      const origin = u.origin;
      const extra = [
        origin + basePath,               // 用户给的原路径本身（可能就是对的）
        origin + '/json/stats.json',
        origin + '/api/servers',
        origin + '/api/live/clients',
        origin + '/api/nodes',
        origin + '/api/v1/service',
        origin + '/config.json',
      ];
      for (const e of extra) if (!out.includes(e)) out.push(e);
    }
  } catch { /* ignore */ }

  return out;
}

/**
 * 读取任意探针站点。
 * @param {string} input 站点根或具体端点
 * @param {object} opts  { token, ms, kind, timeout, security }
 * @returns {Promise<object>} { ok, kind, nodes, endpoint, transport, warning, error, ... }
 */
export async function readProbe(input, opts = {}) {
  const base = normalizeBase(input);
  const root = siteRoot(base);
  const security = resolveProbeSecurity(opts);
  if (opts.token || opts.shareKey || hasAuthorization(opts.headers) || hasNonProtocolHeader(opts.headers)) {
    try {
      const target = new URL(base);
      if (target.protocol === 'http:' && !isLoopbackHost(target.hostname)) {
        return { ok: false, kind: null, nodes: [], endpoint: base, error: '拒绝在非回环 HTTP 地址发送探针凭据；请使用 HTTPS' };
      }
    } catch {
      return { ok: false, kind: null, nodes: [], endpoint: base, error: '探针地址不是有效 URL' };
    }
  }
  const ms = opts.ms ?? opts.timeout ?? 10000;
  // WS 握手单独给较小预算：WS 只是拿实时指标的加分项，不该独占整个读取预算。
  const wsMs = Math.min(opts.wsMs ?? 8000, ms);
  const errors = [];

  // 0. 显式指定类型 → 直接交给对应适配器
  //    ⚠ 传 root 而不是 base：适配器内部会自己拼路径，传具体端点会拼出重复路径。
  if (opts.kind && Object.hasOwn(ADAPTERS, opts.kind)) {
    return finalizeResult(await ADAPTERS[opts.kind].read(root, {
      ...opts,
      ms,
      security,
      headers: requestHeaders(opts),
    }), root);
  }

  // 1. Nodeget 特殊：靠 config.json 识别，不是 JSON 指纹
  //    （SPA 站点所有路径都返回同一个 HTML，猜路径必然失败）
  const cfgProbe = await fetchJson(root + '/config.json', { ms });
  if (cfgProbe.ok && Array.isArray(cfgProbe.data?.site_tokens) && cfgProbe.data.site_tokens.length) {
    if (security.allowNodegetBackends) {
      const r = await nodeget.read(root, { ...opts, ms, security });
      if (r.ok && r.nodes && r.nodes.length) return finalizeResult({ ...r, endpoint: root + '/config.json' }, root);
      errors.push(`Nodeget：${r.warning || r.error}`);
    } else {
      errors.push('Nodeget backend 跟随已按 probe 安全策略禁用；如确有需要请显式打开 allowNodegetBackends');
    }
  }

  // 2. 逐个候选端点探测
  const candidates = candidateEndpoints(input);
  const tried = [];
  // Komari 的 REST 端点只给「静态信息、无实时指标」——这不是失败，是 Komari 的
  // 正常形态（实时指标在 WS 上）。但只有**确实拿到了节点**才值得记下来短路；
  // 若 REST 本身超时/出错（0 节点），必须继续走下面的 WS 通道，不能就此放弃。
  let komariRest = null;
  // 通用兜底备选：记录"结构最像节点列表"的响应，等已知适配器全部失败后再用。
  let genericBest = null;

  for (const url of candidates) {
    const res = await fetchJson(url, { ms, headers: requestHeaders(opts) || {} });
    tried.push({ url, ok: res.ok, status: res.status, error: res.error });

    if (!res.ok) continue;

    // ⚠ 通用兜底候选先记下来（不急着返回）：已知适配器优先。
    //    这里只是"登记"，判定留到最后 —— 避免 generic 抢走已知类型的响应。
    if (!opts.kind) {
      try {
        const gNodes = generic.normalize(res.data, 'generic');
        const gScore = generic.detect(res.data);
        if (gNodes.length && (!genericBest || gScore > genericBest.score)) {
          genericBest = { url, nodes: gNodes, score: gScore };
        }
      } catch { /* 嗅探失败不影响主流程 */ }
    }

    const det = detectKind(res.data);
    if (det.kind && det.score >= 4) {
      const a = ADAPTERS[det.kind];
      // ⚠ 同样传 root：适配器只认「站点根 + 自己拼路径」这一个契约。
      //    对 serverstatus / cf / minimal 这三个「直接吃端点」的适配器，
      //    这里额外把探测到的端点透传给它们（endpoint 选项），兼顾两种风格。
      //    Komari 再额外给 WS 一个较小预算（wsMs），别让握手挂满整个超时。
      const r = await a.read(root, {
        ...opts,
        ms,
        wsMs,
        security,
        endpoint: url,
        foundEndpoint: url,
        headers: requestHeaders(opts),
      });
      if (r.ok && r.nodes && r.nodes.length) {
        return finalizeResult({ ...r, endpoint: r.endpoint || url, detectedScore: det.score }, root);
      }
      if (det.kind === 'komari' && r.ok && r.nodes) komariRest = { url, r };
      errors.push(`${det.kind}@${url}：${r.error || r.warning || '解析后无节点'}`);
    } else {
      // 指纹不足：仍给最可能的适配器一次机会（例如哪吒的 setting-only 响应）
      const a = ADAPTERS[det.kind || 'serverstatus'];
      const r = await a.read(root, {
        ...opts,
        ms,
        wsMs,
        security,
        endpoint: url,
        foundEndpoint: url,
        headers: requestHeaders(opts),
      });
      if (r.ok && r.nodes && r.nodes.length) {
        return finalizeResult({ ...r, endpoint: r.endpoint || url, weakFingerprint: true }, root);
      }
      tried[tried.length - 1].detect = det.all;
    }
  }

  // 2.5. apiBase 跟随：SPA 面板可能把 API 部署在**另一个域**——面板 HTML 里
  //      <meta name="apiBase" content="https://api.example.com">（CF-Server-Monitor
  //      实测如此，逗号可写多个）。默认关闭，避免未受信 HTML 变成 SSRF/凭据转发点；
  //      确认部署关系后，operator 可在 probe.security 中显式打开。
  if (!opts._apiBaseDepth && security.allowRemoteApiBase) {
    const bases = await discoverApiBases(root, ms, security.apiBaseOrigins);
    if (bases.length) {
      const followErrors = [];
      for (const b of bases) {
        try {
          const followOpts = withoutRemoteCredentials({ ...opts, security, _apiBaseDepth: 1 });
          // 这些是源 origin 的连接参数，不能带到新 origin。
          delete followOpts.client;
          delete followOpts.rpcUrl;
          const r = await readProbe(b, followOpts);
          if (r.ok && r.nodes && r.nodes.length) {
            return finalizeResult({
              ...r,
              warning: [r.warning, `面板 API 不在 ${root} 上（HTML apiBase），已自动跟随到 ${b}`]
                .filter(Boolean).join('；'),
            }, root);
          }
          if (r.error) followErrors.push(r.error);
        } catch (e) {
          followErrors.push(describeError(e));
        }
      }
      if (followErrors.length) {
        errors.push(`apiBase 跟随（${bases.join(' , ')}）失败：${followErrors.join('；')}`);
      }
    }
  }

  // 3. WS 通道兜底：Komari 的实时指标只在这里能拿到。
  //    候选循环里若 Komari 的 REST **已经**给出了节点，直接用（省一轮 WS 握手）；
  //    否则跑一次 Komari read（内部 WS/REST 并行，且受 wsMs 约束）。
  if (!komariRest) {
    const komariTry = await komari.read(root, { ...opts, ms, wsMs, security });
    if (komariTry.ok && komariTry.nodes && komariTry.nodes.length) {
      return finalizeResult({ ...komariTry, endpoint: komariTry.endpoint || (root.replace(/^http/, 'ws') + '/api/rpc2') }, root);
    }
    if (komariTry.error) errors.push(`Komari WS：${komariTry.error}`);
  } else {
    return finalizeResult({
      ...komariRest.r,
      endpoint: komariRest.r.endpoint || komariRest.url,
      detectedScore: 4,
    }, root);
  }

  // 3b. 通用兜底：已知 8 类全部失败 → 用结构嗅探 + 同义字段匹配再试一次。
  //     **不需要额外请求**，用的是候选循环里已经拿到的响应体。
  //     门槛故意设高（必须有身份字段 + 足够指标），宁可读不出来也不瞎认。
  if (genericBest && genericBest.nodes.length) {
    return finalizeResult({
      ok: true,
      kind: 'generic',
      nodes: genericBest.nodes,
      endpoint: genericBest.url,
      transport: 'http',
      warning: `未知程序，已按通用规则解析出 ${genericBest.nodes.length} 台（字段名与单位均为推断，请核对）`,
    }, root);
  }

  return {
    ok: false,
    kind: null,
    nodes: [],
    endpoint: base,
    error: errors.length ? errors.join('；') : describeAllFailed(root, tried),
    tried,
  };
}

/**
 * 从面板 HTML 里提取 <meta name="apiBase"> 声明的 API 根（可逗号分隔多个）。
 * SPA 面板把 API 放在另一个域时（CF-Server-Monitor 实测），这是唯一的线索。
 */
export function extractApiBases(html) {
  const out = [];
  if (!html || typeof html !== 'string') return out;
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/name\s*=\s*["']apiBase["']/i.test(tag)) continue;
    const m = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (m && m[1]) {
      for (const s of m[1].split(',')) {
        const v = s.trim();
        if (v) out.push(normalizeBase(v));
      }
    }
  }
  return [...new Set(out)];
}

/** 抓面板根 HTML 并解析 apiBase；只返回与面板域不同源、协议安全的候选（≤3 个） */
async function discoverApiBases(root, ms, allowedOrigins = []) {
  let html = '';
  try {
    const res = await fetchJson(root + '/', { ms: Math.min(ms ?? 10000, 10000) });
    // JSON 根响应（ok:true）不会有 HTML；HTML 会落在这里的 text 字段
    html = res.text || '';
  } catch { /* 根 HTML 拿不到就没有线索，正常走失败路径 */ }
  const sameOrigin = (() => { try { return new URL(root).origin; } catch { return ''; } })();
  const out = [];
  for (const b of extractApiBases(html)) {
    try {
      const u = new URL(b);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (u.origin === sameOrigin) continue;   // 同域没有跟随价值（候选已全试过）
      if (!isOriginAllowed(u.origin, allowedOrigins)) continue; // 必须由 operator 明确批准远程 Origin
      out.push(u.origin + (u.pathname.replace(/\/+$/, '') === '' ? '' : u.pathname.replace(/\/+$/, '')));
    } catch { /* 非法 URL 忽略 */ }
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 全部候选端点失败时的兜底诊断：按「响应特征」给出可行动的原因，而不是一句空话。
 * tried: [{ url, ok, status, error }] —— status 缺席多为超时/连接失败。
 */function describeAllFailed(root, tried) {
  const paths = tried.map(t => t.url.replace(root, '') || '/').join(', ');
  const st = tried.map(t => t.status).filter(Boolean);
  const timeoutCount = tried.filter(t => !t.status && /timeout|timed out|abort/i.test(t.error || '')).length;
  let hint;
  if (st.length && st.every(s => s === 403)) {
    hint = `所有接口都返回 403 —— 多半被防护拦截（Cloudflare 盾 / WAF / bot 校验）。` +
      `把本服务器 IP 加入面板或 CDN 白名单，或临时关掉对应防护再试`;
  } else if (st.length && st.every(s => s === 401 || s === 404)) {
    hint = `接口存在但拒绝访问（${[...new Set(st)].join('/')}）—— 面板开了鉴权，` +
      `请在配置里补 token，或改用面板的公开接口`;
  } else if (tried.length && st.length === 0 && timeoutCount === tried.length) {
    hint = `所有接口都超时 —— 面板地址可能没写对，或本机出网到面板被拦` +
      `（防火墙 / 出网限制 / IPv6 半死）。可先在服务器上 curl 面板地址验证`;
  } else {
    hint = `请确认：① 面板地址能在浏览器打开；② 面板类型在支持列表内` +
      `（ServerStatus / 哪吒V1 / Komari / 极简 / NodeGet / CF探针 / CF-Monitor，哪吒仅 v1 兼容）；` +
      `③ 若面板有鉴权，补 token 或显式指定 kind`;
  }
  return `无法自动识别接口（试过：${paths}）。${hint}`;
}

function finalizeResult(r, base) {
  if (!r) return { ok: false, kind: null, nodes: [], endpoint: base, error: '适配器无返回' };
  const nodes = Array.isArray(r.nodes) ? r.nodes : [];
  return {
    ok: !!r.ok,
    kind: r.kind || null,
    nodes,
    online: nodes.filter(n => n.online).length,
    offline: nodes.filter(n => !n.online).length,
    endpoint: r.endpoint || base,
    transport: r.transport || (Object.hasOwn(ADAPTERS, r.kind) ? ADAPTERS[r.kind]?.transport : null) || 'http',
    warning: r.warning || null,
    error: r.error || null,
    meta: {
      mode: r.mode || null,
      setting: r.setting || null,
      config: r.config || null,
      backends: r.backends || null,
      ms: r.ms ?? null,
    },
  };
}

/**
 * 批量读取多个站点，单个失败不影响其它。
 * @returns {Promise<Array>} 与输入等长的结果数组
 */
export async function readAll(sources, opts = {}) {
  const list = (sources || []).map(s => (typeof s === 'string' ? { url: s } : s));
  const out = await Promise.all(list.map(s => {
    // security 是 operator 的全局策略，不能被某个 source 的同名字段覆盖。
    const sourceOpts = { ...opts, ...s };
    if (opts.security !== undefined) sourceOpts.security = opts.security;
    return readProbe(s.url || s.endpoint || s.base, sourceOpts).catch(e => ({
      ok: false, kind: null, nodes: [], endpoint: s.url || s.endpoint || s.base || '',
      error: describeError(e),
    }));
  }));
  return out;
}

/** 把多站点结果拍平成一个节点数组（key 加站点前缀防冲突） */
export function flatten(results, { prefix = true, maxNodes = 2000 } = {}) {
  const out = [];
  const limit = Math.max(1, Math.min(10000, Number(maxNodes) || 2000));
  for (const r of results || []) {
    if (!r || !Array.isArray(r.nodes)) continue;
    let host = '';
    try { host = new URL(r.endpoint || '').host; } catch { /* ignore */ }
    for (const n of r.nodes) {
      if (out.length >= limit) return out;
      if (!n || typeof n !== 'object') continue;
      out.push(prefix && host ? { ...n, key: `${host}/${n.key}`, sourceHost: host, sourceKind: r.kind } : n);
    }
  }
  return out;
}

export { normalizeBase, siteRoot, describeError, num };
