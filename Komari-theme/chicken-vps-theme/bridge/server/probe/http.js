// 通用探针读取器 —— HTTP 底层
// 设计要点：
//  1. 先 text() 再 JSON.parse：探针挂掉时反代会返回 HTML 错误页，直接 res.json() 会抛
//     一个无信息量的错，我们要把「返回的不是 JSON」明确报出来。
//  2. HTTP 200 不等于成功 —— 哪吒在未认证时返回 200 + {"error":"ApiErrorUnauthorized"}，
//     必须把这种「伪成功」识别为失败。
//  3. 所有请求带超时，超时/网络错误统一成可读的中文消息。

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 这些 body 特征说明「这次响应虽然 2xx，但其实失败了」
const PSEUDO_ERROR_KEYS = ['error', 'code'];
const PSEUDO_ERROR_TEXT = /ApiError|Unauthorized|访问此接口需要认证|认证失败|not authorized/i;

export function describeError(e) {
  if (!e) return '未知错误';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return '请求超时';
  if (e.name === 'TypeError' && /fetch failed/i.test(e.message)) {
    return '网络不可达（DNS / TLS / 连接被拒）';
  }
  return e.message || String(e);
}

/**
 * 取回并解析 JSON。
 * @returns {{ok:true, data:any, status:number, ms:number, text:string}
 *          |{ok:false, error:string, status:number, ms:number, text?:string}}
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function readResponseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new Error(`响应体过大（超过 ${maxBytes} 字节）`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`响应体过大（超过 ${maxBytes} 字节）`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function fetchSameOrigin(url, { ms, headers, body, method }) {
  const deadline = Date.now() + ms;
  let current = String(url);
  for (let hop = 0; hop <= 3; hop += 1) {
    const remaining = Math.max(1, deadline - Date.now());
    const res = await fetch(current, {
      method,
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json,text/plain,*/*',
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(remaining),
      redirect: 'manual',
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    try { await res.body?.cancel(); } catch { /* ignore */ }
    let next;
    try { next = new URL(location, current); } catch { throw new Error('重定向地址无效'); }
    if (next.origin !== new URL(current).origin || next.username || next.password) {
      throw new Error('拒绝跨源重定向');
    }
    current = next.toString();
  }
  throw new Error('重定向次数过多');
}

export async function fetchJson(url, { ms = 10000, headers = {}, body, method = 'GET' } = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetchSameOrigin(url, { ms, headers, body, method });
  } catch (e) {
    return { ok: false, error: describeError(e), status: 0, ms: Date.now() - t0 };
  }

  let text;
  try {
    text = await readResponseText(res);
  } catch (e) {
    return { ok: false, error: `响应读取失败：${e.message}`, status: res.status, ms: Date.now() - t0 };
  }
  const elapsed = Date.now() - t0;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const head = text.slice(0, 60).replace(/\s+/g, ' ');
    return {
      ok: false,
      error: `返回的不是 JSON（HTTP ${res.status}${head ? '：' + head : ''}）`,
      status: res.status,
      ms: elapsed,
      text,
    };
  }

  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, status: res.status, ms: elapsed, text, data };
  }

  // 伪成功识别：HTTP 200 但 body 里带鉴权/错误标记
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const errVal = data.error;
    if (typeof errVal === 'string' && errVal) {
      return { ok: false, error: `接口报错：${errVal}`, status: res.status, ms: elapsed, text, data };
    }
    // {code:403,message:"..."} 这种
    if (typeof data.code === 'number' && data.code >= 400 && data.message) {
      return { ok: false, error: `${data.code}：${data.message}`, status: res.status, ms: elapsed, text, data };
    }
    if (PSEUDO_ERROR_TEXT.test(text.slice(0, 400)) && Object.keys(data).length <= 3) {
      return { ok: false, error: `接口拒绝：${text.slice(0, 80)}`, status: res.status, ms: elapsed, text, data };
    }
  }

  return { ok: true, data, status: res.status, ms: elapsed, text };
}

/** 站点根 URL 归一（去掉尾部斜杠、去掉 hash 路由） */
export function normalizeBase(url) {
  let u = String(url || '').trim();
  u = u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  u = u.replace(/\/#\/?$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// 已知的「端点后缀」——出现在 URL 末尾就说明调用方给的是具体端点而非站点根。
// 适配器内部要拼自己的路径，必须先剥掉这些后缀，否则会拼出
// /api/v1/service/api/v1/setting 这种重复路径（真实踩过的坑）。
const ENDPOINT_SUFFIXES = [
  '/api/v1/service', '/api/v1/server', '/api/v1/server/list', '/api/v1/servers',
  '/api/v1/setting', '/api/v1/nodes', '/api/v1/bootstrap',
  '/json/stats.json', '/api/servers', '/api/nodes', '/api/bootstrap',
  '/api/rpc2', '/api/nodes/latest', '/config.json',
  '/api/live/clients',   // CF VPS Monitor 实时快照（第 54 轮：漏掉它会导致 siteRoot 拼出重复路径，元数据合并 404）
];

/**
 * 取站点根 URL。
 * 无论调用方传的是站点根（https://a.com）还是具体端点（https://a.com/api/v1/service），
 * 都返回可用于拼接本站 API 路径的根。
 *
 * 只在 pathname **恰好等于**某个已知端点时才裁剪，避免误伤带子目录的反代站点
 * （例如 https://a.com/probe/api/nodes 里 /probe 是反代前缀，不能丢）。
 */
export function siteRoot(url) {
  const base = normalizeBase(url);
  let u;
  try {
    u = new URL(base);
  } catch {
    return base;
  }
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) return base;

  for (const suf of ENDPOINT_SUFFIXES) {
    if (path.toLowerCase().endsWith(suf)) {
      const kept = path.slice(0, path.length - suf.length).replace(/\/+$/, '');
      u.pathname = kept + '/';
      return u.toString().replace(/\/+$/, '').replace(/\/#\/?$/, '');
    }
  }
  return base;
}

export { DEFAULT_UA, ENDPOINT_SUFFIXES };
