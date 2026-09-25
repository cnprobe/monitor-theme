// 服务器配置：读取项目根目录的 config.json（不存在则用默认值）。
// 修改后 systemctl restart chicken-vps 生效。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_PROBE_SECURITY,
  defaultAllowedOrigins,
  normalizeAllowedOrigins,
  resolveProbeSecurity,
  validateTrustedProxyCidrs,
} from './security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function asConfigPort(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}

function fail(field, message) {
  throw new Error(`[config] ${field} ${message}`);
}

function numberField(value, field, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, 'must be a finite number');
  if (integer && !Number.isInteger(value)) fail(field, 'must be an integer');
  if (value < min || value > max) fail(field, `must be between ${min} and ${max}`);
  return value;
}

function boolField(value, field) {
  if (typeof value !== 'boolean') fail(field, 'must be a boolean');
  return value;
}

function stringField(value, field, { allowEmpty = false, max = 4096 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    fail(field, 'must be a non-empty string');
  }
  if (value.length > max) fail(field, `must be at most ${max} characters`);
  return value;
}

function targetUrl(value, field, { allowEmpty = false, protocols = ['http:', 'https:', 'ws:', 'wss:'] } = {}) {
  const raw = stringField(value, field, { allowEmpty, max: 2048 });
  if (!raw) return raw;
  let url;
  try { url = new URL(raw); } catch { fail(field, 'must be a valid URL'); }
  if (!protocols.includes(url.protocol)) fail(field, `protocol must be one of: ${protocols.join(', ')}`);
  if (url.username || url.password) fail(field, 'must not contain URL credentials');
  return raw;
}

function validateSources(sources, field) {
  const list = Array.isArray(sources) ? sources : [sources];
  if (!Array.isArray(sources) && typeof sources !== 'string' && !isObject(sources)) {
    fail(field, 'must be an array, string, or object');
  }
  if (list.length > 32) fail(field, 'must contain at most 32 sources');
  for (let i = 0; i < list.length; i++) {
    const source = list[i];
    const at = `${field}[${i}]`;
    if (typeof source === 'string') {
      targetUrl(source, at);
      continue;
    }
    if (!isObject(source)) fail(at, 'must be a string or an object');
    for (const key of ['url', 'endpoint', 'base']) {
      if (has(source, key)) targetUrl(source[key], `${at}.${key}`);
    }
    for (const key of ['name', 'kind']) {
      if (has(source, key)) stringField(source[key], `${at}.${key}`, { max: 160 });
    }
    if (has(source, 'tokenEnv')) {
      stringField(source.tokenEnv, `${at}.tokenEnv`, { max: 64 });
      if (!/^[A-Z][A-Z0-9_]*$/.test(source.tokenEnv)) fail(`${at}.tokenEnv`, 'must be an environment variable name');
    }
    if (has(source, 'shareUrlEnv')) {
      stringField(source.shareUrlEnv, `${at}.shareUrlEnv`, { max: 64 });
      if (!/^[A-Z][A-Z0-9_]*$/.test(source.shareUrlEnv)) fail(`${at}.shareUrlEnv`, 'must be an environment variable name');
    }
    if (has(source, 'tokenEnv') && has(source, 'shareUrlEnv')) {
      fail(at, 'must use only one of tokenEnv or shareUrlEnv');
    }
    if (has(source, 'headers')) {
      if (!isObject(source.headers)) fail(`${at}.headers`, 'must be an object');
      const headerEntries = Object.entries(source.headers);
      if (headerEntries.length > 32) fail(`${at}.headers`, 'must contain at most 32 headers');
      for (const [key, value] of headerEntries) {
        stringField(key, `${at}.headers key`, { max: 128 });
        stringField(value, `${at}.headers.${key}`, { max: 4096 });
        if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) fail(`${at}.headers.${key}`, 'must not contain CR/LF');
      }
    }
    for (const key of ['timeout', 'totalMs', 'backendMs', 'reqMs']) {
      if (has(source, key)) numberField(source[key], `${at}.${key}`, { min: 100, max: 120000, integer: true });
    }
    if (has(source, 'concurrency')) numberField(source.concurrency, `${at}.concurrency`, { min: 1, max: 8, integer: true });
    if (!has(source, 'url') && !has(source, 'endpoint') && !has(source, 'base')) {
      fail(at, 'must include url, endpoint, or base');
    }
    if (has(source, 'token') && source.token !== null) stringField(source.token, `${at}.token`, { max: 4096 });
    if (has(source, 'site') && typeof source.site !== 'boolean') fail(`${at}.site`, 'must be a boolean');
  }
  return list;
}

function validateSites(sites, field) {
  const list = Array.isArray(sites) ? sites : [sites];
  if (!Array.isArray(sites) && typeof sites !== 'string' && !isObject(sites)) {
    fail(field, 'must be an array, string, or object');
  }
  if (list.length > 100) fail(field, 'must contain at most 100 sites');
  return list.map((site, i) => {
    const at = `${field}[${i}]`;
    if (typeof site === 'string') {
      targetUrl(site, at, { protocols: ['http:', 'https:'] });
      return { url: site };
    }
    if (!isObject(site)) fail(at, 'must be a string or an object');
    if (!has(site, 'url')) fail(at, 'must include url');
    targetUrl(site.url, `${at}.url`, { protocols: ['http:', 'https:'] });
    if (has(site, 'key')) stringField(site.key, `${at}.key`, { allowEmpty: true, max: 256 });
    if (has(site, 'name')) stringField(site.name, `${at}.name`, { allowEmpty: true, max: 120 });
    if (has(site, 'region') && site.region !== null) stringField(site.region, `${at}.region`, { allowEmpty: true, max: 16 });
    if (has(site, 'timeout')) numberField(site.timeout, `${at}.timeout`, { min: 100, max: 120000, integer: true });
    return site;
  });
}

function validateSecurity(security, field) {
  if (!isObject(security)) fail(field, 'must be an object');
  const aliases = [
    'allowRemoteApiBase', 'allowApiBase', 'followRemoteApiBase', 'followApiBase',
    'allowNodegetBackends', 'allowNodegetBackendFollowing', 'allowNodegetBackend',
    'followNodegetBackends', 'followNodegetBackend', 'nodegetBackends',
  ];
  for (const key of aliases) {
    if (has(security, key)) boolField(security[key], `${field}.${key}`);
  }
  if (has(security, 'remoteApiBase')) {
    if (!isObject(security.remoteApiBase)) fail(`${field}.remoteApiBase`, 'must be an object');
    if (has(security.remoteApiBase, 'allow')) boolField(security.remoteApiBase.allow, `${field}.remoteApiBase.allow`);
    if (has(security.remoteApiBase, 'origins')) normalizeAllowedOrigins(security.remoteApiBase.origins, `${field}.remoteApiBase.origins`);
  }
  if (has(security, 'apiBase')) {
    if (!isObject(security.apiBase)) fail(`${field}.apiBase`, 'must be an object');
    if (has(security.apiBase, 'follow')) boolField(security.apiBase.follow, `${field}.apiBase.follow`);
    if (has(security.apiBase, 'origins')) normalizeAllowedOrigins(security.apiBase.origins, `${field}.apiBase.origins`);
  }
  if (has(security, 'nodeget')) {
    if (!isObject(security.nodeget)) fail(`${field}.nodeget`, 'must be an object');
    if (has(security.nodeget, 'origins')) normalizeAllowedOrigins(security.nodeget.origins, `${field}.nodeget.origins`);
  }
  for (const key of ['apiBaseOrigins', 'nodegetBackendOrigins']) {
    if (has(security, key)) normalizeAllowedOrigins(security[key], `${field}.${key}`);
  }
}

function validateGeo(geo, field) {
  if (!isObject(geo)) fail(field, 'must be an object');
  if (has(geo, 'externalLookup')) boolField(geo.externalLookup, `${field}.externalLookup`);
  if (has(geo, 'providers')) {
    if (!Array.isArray(geo.providers)) fail(`${field}.providers`, 'must be an array');
    const allowed = new Set(['ipwho.is', 'ipapi.co']);
    for (const [i, provider] of geo.providers.entries()) {
      if (typeof provider !== 'string' || !allowed.has(provider)) {
        fail(`${field}.providers[${i}]`, 'must be one of: ipwho.is, ipapi.co');
      }
    }
  }
}

function validateProbe(probe, field) {
  if (!isObject(probe)) fail(field, 'must be an object');
  if (has(probe, 'url')) targetUrl(probe.url, `${field}.url`, { allowEmpty: true });
  if (has(probe, 'interval')) {
    numberField(probe.interval, `${field}.interval`, { min: 1000, max: 3600000, integer: true });
  }
  const sources = has(probe, 'sources') ? validateSources(probe.sources, `${field}.sources`) : undefined;
  const sites = has(probe, 'sites') ? validateSites(probe.sites, `${field}.sites`) : undefined;
  if (has(probe, 'security')) validateSecurity(probe.security, `${field}.security`);
  // 允许旧配置把策略字段直接写在 probe 下；统一解析时仍归入 security。
  for (const key of [
    'allowRemoteApiBase', 'allowApiBase', 'followRemoteApiBase', 'followApiBase',
    'allowNodegetBackends', 'allowNodegetBackendFollowing', 'allowNodegetBackend',
    'followNodegetBackends', 'followNodegetBackend', 'nodegetBackends',
  ]) {
    if (has(probe, key)) boolField(probe[key], `${field}.${key}`);
  }
  return { sources, sites };
}

function freshDefaults(port = 3777) {
  const actualPort = asConfigPort(port, 3777);
  return {
    port: actualPort,
    // 只有部署在 Cloudflare 后面才设 true；IP 直连时必须 false，
    // 否则访客能伪造 CF-Connecting-IP 头换假国旗。
    trustCloudflareIp: false,
    exposeVisitorGeo: false,
    trustedProxyCidrs: [],
    // 未显式配置时只接受回环开发 Origin；公网部署请在 config.json 中列出站点 Origin。
    allowedOrigins: defaultAllowedOrigins(actualPort),
    geese: 2,
    maxPlayers: 60,
    maxProbeChicks: 200,
    maxNpcEntities: 500,
    maxHandshakesPerMinute: 60,
    // 默认不把访客 IP 发送到任何第三方 GeoIP 服务。
    geo: {
      externalLookup: false,
      providers: ['ipwho.is', 'ipapi.co'],
    },
    probe: {
      url: '',                     // 探针机器源（留空则只跑网站探测；用 install.sh config 来配）
      interval: 15000,             // 轮询间隔 ms
      sites: [],                   // 网站鸡列表：留空；用 install.sh config 添加
      security: {
        ...DEFAULT_PROBE_SECURITY,
        apiBaseOrigins: [...DEFAULT_PROBE_SECURITY.apiBaseOrigins],
        nodegetBackendOrigins: [...DEFAULT_PROBE_SECURITY.nodegetBackendOrigins],
      }
    }
  };
}

/** 新的默认对象，避免调用方修改 DEFAULTS 后污染后续加载。 */
export function defaultConfig() {
  const cfg = freshDefaults(DEFAULTS.port);
  cfg.allowedOrigins = defaultOriginsForConfig(cfg.port);
  return cfg;
}

/** 兼容需要直接读取默认值的调用方。 */
export const DEFAULTS = Object.freeze(freshDefaults());

function defaultOriginsForConfig(port) {
  const origins = defaultAllowedOrigins(port);
  const envPort = asConfigPort(process.env.PORT, null);
  if (envPort !== null && envPort !== port) {
    origins.push(...defaultAllowedOrigins(envPort));
  }
  return [...new Set(origins)];
}

/**
 * 校验并合并配置。未知字段保留，兼容现有安装；已知字段错误则立即失败。
 */
export function normalizeConfig(raw, sourcePath = 'config.json') {
  if (!isObject(raw)) fail(sourcePath, 'must contain a JSON object');

  const port = has(raw, 'port') ? numberField(raw.port, `${sourcePath}.port`, {
    min: 0, max: 65535, integer: true
  }) : DEFAULTS.port;
  if (has(raw, 'trustCloudflareIp')) boolField(raw.trustCloudflareIp, `${sourcePath}.trustCloudflareIp`);
  if (has(raw, 'exposeVisitorGeo')) boolField(raw.exposeVisitorGeo, `${sourcePath}.exposeVisitorGeo`);
  if (has(raw, 'trustedProxyCidrs')) {
    try {
      validateTrustedProxyCidrs(raw.trustedProxyCidrs);
    } catch (e) {
      fail(`${sourcePath}.trustedProxyCidrs`, e.message.replace(/^trustedProxyCidrs\s*/, ''));
    }
  }
  if (has(raw, 'geese')) numberField(raw.geese, `${sourcePath}.geese`, { min: 0, max: 100, integer: true });
  if (has(raw, 'maxPlayers')) numberField(raw.maxPlayers, `${sourcePath}.maxPlayers`, { min: 1, max: 200, integer: true });
  if (has(raw, 'maxProbeChicks')) numberField(raw.maxProbeChicks, `${sourcePath}.maxProbeChicks`, { min: 1, max: 1000, integer: true });
  if (has(raw, 'maxNpcEntities')) numberField(raw.maxNpcEntities, `${sourcePath}.maxNpcEntities`, { min: 1, max: 2000, integer: true });
  if (has(raw, 'maxHandshakesPerMinute')) numberField(raw.maxHandshakesPerMinute, `${sourcePath}.maxHandshakesPerMinute`, { min: 10, max: 600, integer: true });

  let allowedOrigins;
  if (has(raw, 'allowedOrigins')) {
    try {
      allowedOrigins = normalizeAllowedOrigins(raw.allowedOrigins, `${sourcePath}.allowedOrigins`);
    } catch (e) {
      fail(`${sourcePath}.allowedOrigins`, e.message.replace(/^.*?allowedOrigins\s*/, ''));
    }
  } else {
    allowedOrigins = defaultOriginsForConfig(port);
  }

  const rawProbe = has(raw, 'probe') ? raw.probe : {};
  const validatedProbe = validateProbe(rawProbe, `${sourcePath}.probe`);
  const rawGeo = has(raw, 'geo') ? raw.geo : {};
  validateGeo(rawGeo, `${sourcePath}.geo`);
  const probe = {
    ...DEFAULTS.probe,
    ...rawProbe,
    ...(validatedProbe.sources !== undefined ? { sources: validatedProbe.sources } : {}),
    ...(validatedProbe.sites !== undefined ? { sites: validatedProbe.sites } : {}),
    security: {
      ...(isObject(rawProbe.security) ? rawProbe.security : {}),
      ...resolveProbeSecurity(rawProbe)
    }
  };
  const geo = {
    ...DEFAULTS.geo,
    ...rawGeo
  };

  return {
    ...DEFAULTS,
    ...raw,
    port,
    allowedOrigins,
    geo,
    probe
  };
}

// 与 normalizeConfig 同义，保留一个更像解析器的名字给测试/运维脚本使用。
export const parseConfig = normalizeConfig;

/**
 * 读取配置文件。文件不存在是正常的；文件存在但损坏则抛出带路径的错误，
 * 绝不把 JSON/类型错误静默降级成默认配置。
 */
export function loadConfig(configPath = CONFIG_PATH) {
  let text;
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile()) throw new Error('配置路径不是普通文件');
    if (stat.size > 1024 * 1024) throw new Error('配置文件不能超过 1 MiB');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      console.warn(`[config] 警告：${configPath} 对 group/other 可读，含凭据时建议 chmod 600`);
    }
    text = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') {
      console.log(`[config] 未找到 ${configPath}，使用默认配置`);
      return defaultConfig();
    }
    throw new Error(`[config] 无法读取 ${configPath}: ${e.message}`, { cause: e });
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`[config] ${configPath} 不是有效 JSON: ${e.message}`, { cause: e });
  }

  const cfg = normalizeConfig(raw, configPath);
  console.log(`[config] 已加载 ${configPath}`);
  return cfg;
}

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  // Node 启动时会把这个清晰错误打印出来并以非零状态退出。
  console.error(e.message);
  throw e;
}

export { CONFIG_PATH };
export default cfg;
export {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_PROBE_SECURITY,
  canonicalOrigin,
  defaultAllowedOrigins,
  isOriginAllowed,
  normalizeAllowedOrigins,
  requireOrigin,
  resolveProbeSecurity,
  validateTrustedProxyCidrs,
} from './security.js';
export const ROOT_DIR = ROOT;
