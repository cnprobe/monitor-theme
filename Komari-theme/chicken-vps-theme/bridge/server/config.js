// 精简多人 Bridge 配置：主题 ZIP 自行读取 Komari，这里只管理多人游戏安全与资源限制。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  defaultAllowedOrigins,
  normalizeAllowedOrigins,
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

function validateGeo(geo, field) {
  if (!isObject(geo)) fail(field, 'must be an object');
  if (has(geo, 'externalLookup')) boolField(geo.externalLookup, `${field}.externalLookup`);
  if (has(geo, 'providers')) {
    if (!Array.isArray(geo.providers)) fail(`${field}.providers`, 'must be an array');
    const allowed = new Set(['ipwho.is', 'ipapi.co']);
    for (const [index, provider] of geo.providers.entries()) {
      if (typeof provider !== 'string' || !allowed.has(provider)) {
        fail(`${field}.providers[${index}]`, 'contains an unsupported provider');
      }
    }
  }
}

function defaultOriginsForPort(port) {
  const origins = defaultAllowedOrigins(port);
  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort !== port && envPort >= 0 && envPort <= 65535) {
    origins.push(...defaultAllowedOrigins(envPort));
  }
  return [...new Set(origins)];
}

function freshDefaults(port = 3777) {
  return {
    port,
    trustCloudflareIp: false,
    exposeVisitorGeo: false,
    trustedProxyCidrs: [],
    allowedOrigins: defaultOriginsForPort(port),
    geese: 2,
    maxPlayers: 60,
    maxHandshakesPerMinute: 60,
    geo: {
      externalLookup: false,
      providers: ['ipwho.is', 'ipapi.co'],
    },
  };
}

export function defaultConfig() {
  return freshDefaults(3777);
}

export const DEFAULTS = Object.freeze(freshDefaults());

export function normalizeConfig(raw, sourcePath = 'config.json') {
  if (!isObject(raw)) fail(sourcePath, 'must contain a JSON object');

  const port = has(raw, 'port')
    ? numberField(raw.port, `${sourcePath}.port`, { min: 0, max: 65535, integer: true })
    : DEFAULTS.port;
  if (has(raw, 'trustCloudflareIp')) boolField(raw.trustCloudflareIp, `${sourcePath}.trustCloudflareIp`);
  if (has(raw, 'exposeVisitorGeo')) boolField(raw.exposeVisitorGeo, `${sourcePath}.exposeVisitorGeo`);
  if (has(raw, 'trustedProxyCidrs')) {
    try {
      validateTrustedProxyCidrs(raw.trustedProxyCidrs, `${sourcePath}.trustedProxyCidrs`);
    } catch (error) {
      fail(`${sourcePath}.trustedProxyCidrs`, error.message.replace(/^.*?trustedProxyCidrs\s*/, ''));
    }
  }

  let allowedOrigins;
  if (has(raw, 'allowedOrigins')) {
    try {
      allowedOrigins = normalizeAllowedOrigins(raw.allowedOrigins, `${sourcePath}.allowedOrigins`);
    } catch (error) {
      fail(`${sourcePath}.allowedOrigins`, error.message.replace(/^.*?allowedOrigins\s*/, ''));
    }
  } else {
    allowedOrigins = defaultOriginsForPort(port);
  }

  if (has(raw, 'geese')) numberField(raw.geese, `${sourcePath}.geese`, { min: 0, max: 100, integer: true });
  if (has(raw, 'maxPlayers')) numberField(raw.maxPlayers, `${sourcePath}.maxPlayers`, { min: 1, max: 200, integer: true });
  if (has(raw, 'maxHandshakesPerMinute')) {
    numberField(raw.maxHandshakesPerMinute, `${sourcePath}.maxHandshakesPerMinute`, {
      min: 10, max: 600, integer: true,
    });
  }
  if (has(raw, 'geo') && !isObject(raw.geo)) fail(`${sourcePath}.geo`, 'must be an object');
  const rawGeo = has(raw, 'geo') ? raw.geo : {};
  const geo = {
    externalLookup: has(rawGeo, 'externalLookup') ? rawGeo.externalLookup : DEFAULTS.geo.externalLookup,
    providers: has(rawGeo, 'providers') ? rawGeo.providers : [...DEFAULTS.geo.providers],
  };
  validateGeo(geo, `${sourcePath}.geo`);

  // 只返回多人 Bridge 的已知字段；其他配置不会进入运行状态。
  return {
    port,
    trustCloudflareIp: has(raw, 'trustCloudflareIp') ? raw.trustCloudflareIp : DEFAULTS.trustCloudflareIp,
    exposeVisitorGeo: has(raw, 'exposeVisitorGeo') ? raw.exposeVisitorGeo : DEFAULTS.exposeVisitorGeo,
    trustedProxyCidrs: Array.isArray(raw.trustedProxyCidrs) ? [...raw.trustedProxyCidrs] : [...DEFAULTS.trustedProxyCidrs],
    allowedOrigins,
    geese: has(raw, 'geese') ? raw.geese : DEFAULTS.geese,
    maxPlayers: has(raw, 'maxPlayers') ? raw.maxPlayers : DEFAULTS.maxPlayers,
    maxHandshakesPerMinute: has(raw, 'maxHandshakesPerMinute') ? raw.maxHandshakesPerMinute : DEFAULTS.maxHandshakesPerMinute,
    geo,
  };
}

export const parseConfig = normalizeConfig;

export function loadConfig(configPath = CONFIG_PATH) {
  let text;
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile()) throw new Error('配置路径不是普通文件');
    if (stat.size > 1024 * 1024) throw new Error('配置文件不能超过 1 MiB');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      console.warn(`[config] 警告：${configPath} 对 group/other 可读，建议 chmod 600`);
    }
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log(`[config] 未找到 ${configPath}，使用默认配置`);
      return defaultConfig();
    }
    throw new Error(`[config] 无法读取 ${configPath}: ${error.message}`, { cause: error });
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`[config] ${configPath} 不是有效 JSON: ${error.message}`, { cause: error });
  }
  const config = normalizeConfig(raw, configPath);
  console.log(`[config] 已加载 ${configPath}`);
  return config;
}

let loadedConfig;
try {
  loadedConfig = loadConfig();
} catch (error) {
  console.error(error.message);
  throw error;
}

export { CONFIG_PATH };
export default loadedConfig;
export {
  DEFAULT_ALLOWED_ORIGINS,
  canonicalOrigin,
  defaultAllowedOrigins,
  isOriginAllowed,
  normalizeAllowedOrigins,
  requireOrigin,
  validateTrustedProxyCidrs,
} from './security.js';
export const ROOT_DIR = ROOT;
