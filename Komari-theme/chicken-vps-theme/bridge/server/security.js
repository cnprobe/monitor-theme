import net from 'node:net';

// 多人 Bridge 的 Origin 与反向代理信任策略。
// 默认只允许本机开发 Origin；公网 Origin 必须由管理员显式配置。

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

function ipv4Number(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

/** 校验可信代理列表：IPv4 支持 CIDR，IPv6 当前只接受精确地址。 */
export function validateTrustedProxyCidrs(values, field = 'trustedProxyCidrs') {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  return values.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${field}[${index}] must be a non-empty IP address or CIDR`);
    }
    const parts = entry.trim().split('/');
    if (parts.length > 2) throw new Error(`${field}[${index}] has too many '/' separators`);
    const [network, prefixRaw] = parts;
    const version = net.isIP(network);
    if (!version) throw new Error(`${field}[${index}] must contain a valid IP address`);
    if (prefixRaw !== undefined) {
      if (!/^\d+$/.test(prefixRaw)) throw new Error(`${field}[${index}] prefix must be an integer`);
      const prefix = Number(prefixRaw);
      const max = version === 4 ? 32 : 128;
      if (prefix > max) throw new Error(`${field}[${index}] prefix must be between 0 and ${max}`);
      if (version === 6) {
        throw new Error(`${field}[${index}] IPv6 trusted proxies must be exact addresses, not CIDR ranges`);
      }
    }
    return entry.trim();
  });
}

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

function normalizeIp(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const candidate = raw.toLowerCase().startsWith('::ffff:') ? raw.slice(7) : raw;
  return net.isIP(candidate) ? candidate : null;
}

function firstHeaderValue(headers, name) {
  const value = headers?.[name.toLowerCase()] ?? headers?.[name];
  return String(value ?? '').split(',')[0].trim();
}

/**
 * 从请求中得到用于访客身份和限流的地址。
 *
 * 只有直连 peer 明确位于 trustedProxyCidrs 时才读取转发头；CF 头还需要
 * trustCloudflareIp，X-Forwarded-For 还需要 trustProxy。这样 game 和握手限流
 * 使用完全相同的信任边界，不会因为某一条路径漏检环境变量而放大限流桶。
 */
export function resolveClientIp(peer, headers = {}, options = {}) {
  const direct = normalizeIp(peer) || 'unknown';
  if (!isTrustedProxy(direct, options.trustedProxyCidrs || [])) return direct;

  if (options.trustCloudflareIp === true) {
    const value = normalizeIp(firstHeaderValue(headers, 'cf-connecting-ip'));
    if (value) return value;
  }
  if (options.trustProxy === true) {
    const value = normalizeIp(firstHeaderValue(headers, 'x-forwarded-for'));
    if (value) return value;
  }
  return direct;
}
