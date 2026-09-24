import net from 'node:net';

// 伴生服务的安全策略与纯函数帮助器。
//
// 这里不依赖 Node 专有 API，方便配置解析、探针读取器和 node:test 共同使用。
// 默认策略是保守的：远程 apiBase 和 NodeGet backend 都是关闭的，只有明确
// 配置为 true 才会跟随。

const LOCAL_DEV_PORTS = [3777, 4173, 8080];

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://localhost:3777',
  'http://127.0.0.1:3777',
  'http://[::1]:3777',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://[::1]:4173',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://[::1]:8080',
]);

function asPort(value, fallback = 3777) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

/** 返回规范化的 http(s) Origin；无效值返回 null。配置解析会把它转成清晰错误。 */
export function canonicalOrigin(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw === '*') return '*';

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  // Origin 不包含 path；只容忍 URL 常见的根斜杠。
  if (u.pathname && u.pathname !== '/') return null;
  return u.origin;
}

/** 解析配置里的单个 Origin，并在失败时给出字段名。* 仅作显式全开放配置。 */
export function requireOrigin(value, field = 'origin') {
  const origin = canonicalOrigin(value);
  if (!origin || origin === '*') throw new Error(`${field} must be an http(s) origin`);
  return origin;
}

/** 校验并去重 Origin allowlist；默认配置不会使用显式 wildcard。 */
export function normalizeAllowedOrigins(values, field = 'allowedOrigins') {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  const out = [];
  for (const value of values) {
    const origin = canonicalOrigin(value);
    if (!origin || origin === '*') {
      throw new Error(`${field} contains an invalid origin: ${JSON.stringify(value)}`);
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** 本地开发默认只绑定回环地址，不包含 wildcard 或公网地址。 */
export function defaultAllowedOrigins(port = 3777) {
  const ports = [...new Set([asPort(port), ...LOCAL_DEV_PORTS])];
  const out = [];
  for (const p of ports) {
    out.push(
      `http://localhost:${p}`,
      `http://127.0.0.1:${p}`,
      `http://[::1]:${p}`
    );
  }
  return [...new Set(out)];
}

/** WebSocket Origin 是否在 allowlist 中；默认无配置时只接受本机开发 Origin。 */
export function isOriginAllowed(origin, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  const candidate = canonicalOrigin(origin);
  if (!candidate || candidate === '*') return false;
  const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  return list.some(value => {
    const normalized = canonicalOrigin(value);
    return normalized !== '*' && normalized === candidate;
  });
}

export const DEFAULT_PROBE_SECURITY = Object.freeze({
  allowRemoteApiBase: false,
  allowNodegetBackends: false,
  apiBaseOrigins: Object.freeze([]),
  nodegetBackendOrigins: Object.freeze([]),
});

function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

/**
 * 统一探针安全策略。
 *
 * 规范字段是 allowRemoteApiBase / allowNodegetBackends；同时接受几个旧/直观
 * 拼写，方便升级时不被旧配置悄悄改变。嵌套 security 字段优先于外层字段。
 */
export function resolveProbeSecurity(input = {}, fallback = DEFAULT_PROBE_SECURITY) {
  let value = input && typeof input === 'object' ? input : {};
  if (value.probe && typeof value.probe === 'object') {
    value = { ...value, ...value.probe, ...(value.probe.security || {}) };
  }
  if (value.security && typeof value.security === 'object') {
    value = { ...value, ...value.security };
  }

  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_PROBE_SECURITY;
  const remoteApiBase = firstDefined(
    value.allowRemoteApiBase,
    value.allowApiBase,
    value.followRemoteApiBase,
    value.followApiBase,
    value.remoteApiBase?.allow,
    value.apiBase?.follow,
    base.allowRemoteApiBase
  );
  const nodegetBackends = firstDefined(
    value.allowNodegetBackends,
    value.allowNodegetBackendFollowing,
    value.allowNodegetBackend,
    value.followNodegetBackends,
    value.followNodegetBackend,
    value.nodegetBackends,
    base.allowNodegetBackends
  );

  const apiBaseOrigins = firstDefined(
    value.apiBaseOrigins,
    value.remoteApiBase?.origins,
    value.apiBase?.origins,
    base.apiBaseOrigins
  );
  const nodegetBackendOrigins = firstDefined(
    value.nodegetBackendOrigins,
    value.nodeget?.origins,
    base.nodegetBackendOrigins
  );

  return {
    allowRemoteApiBase: remoteApiBase === true,
    allowNodegetBackends: nodegetBackends === true,
    apiBaseOrigins: normalizeAllowedOrigins(apiBaseOrigins || []),
    nodegetBackendOrigins: normalizeAllowedOrigins(nodegetBackendOrigins || []),
  };
}

const SAFE_PROBE_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'x-requested-with',
]);

/** 跨 origin 只保留协议级头，避免把 Cookie/API-Key 等自定义凭据带走。 */
export function stripAuthorizationHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = {};
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    if (SAFE_PROBE_HEADERS.has(String(key).toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * 为 apiBase 跟随生成选项：不把源站 token / Authorization 头带到新 origin。
 * 直接配置的源不会经过这里，因此仍可正常使用自己的凭据。
 */
export function withoutRemoteCredentials(options = {}) {
  const out = { ...(options && typeof options === 'object' ? options : {}) };
  delete out.token;
  delete out.apiToken;
  delete out.tokenEnv;
  delete out.authorization;
  if (Object.prototype.hasOwnProperty.call(out, 'headers')) {
    out.headers = stripAuthorizationHeaders(out.headers);
  }
  return out;
}

/** 比较两个 URL 是否同源；路径不参与比较，无法解析时返回 false。 */
export function isSameOrigin(a, b) {
  const originOf = value => {
    if (typeof value !== 'string') return null;
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch {
      return null;
    }
  };
  const ua = originOf(a);
  const ub = originOf(b);
  return !!ua && !!ub && ua === ub;
}

function ipv4Number(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

/** 只在明确的代理 CIDR 列表命中时信任转发头。IPv6 使用精确地址匹配。 */
export function isTrustedProxy(ip, cidrs) {
  if (!Array.isArray(cidrs) || !cidrs.length || net.isIP(ip) === 0) return false;
  for (const entry of cidrs) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const [network, prefixRaw] = entry.trim().split('/');
    if (net.isIP(network) !== net.isIP(ip)) continue;
    if (net.isIP(ip) === 4) {
      const address = ipv4Number(ip);
      const base = ipv4Number(network);
      const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
      if (address === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      if ((address & mask) === (base & mask)) return true;
    } else if (prefixRaw === undefined && ip === network) {
      return true;
    }
  }
  return false;
}
