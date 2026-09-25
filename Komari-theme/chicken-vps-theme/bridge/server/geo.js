// IP → 国家/ASN 查询。默认完全离线；管理员显式开启 externalLookup 后才使用 HTTPS GeoIP。

import fs from 'fs';
import net from 'node:net';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const cache = new Map();
let cityDb = null, asnDb = null, mmdbTried = false;

async function initMmdb() {
  if (mmdbTried) return;
  mmdbTried = true;
  const cityPath = path.join(DATA_DIR, 'GeoLite2-City.mmdb');
  const asnPath = path.join(DATA_DIR, 'GeoLite2-ASN.mmdb');
  if (!fs.existsSync(cityPath) && !fs.existsSync(asnPath)) return;
  try {
    const mod = await import('maxmind');
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const maxmind = mod?.open ? mod : (require('maxmind') || mod.default || mod);
    if (fs.existsSync(cityPath)) cityDb = await maxmind.open(cityPath);
    if (fs.existsSync(asnPath)) asnDb = await maxmind.open(asnPath);
    console.log('[geo] 已加载本地 GeoLite2 数据库');
  } catch (e) {
    console.log('[geo] GeoLite2 数据库加载失败:', e.message);
  }
}

function canonicalIp(value) {
  let ip = String(value || '').trim();
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

export function isPrivate(ip) {
  const value = canonicalIp(ip);
  if (!value) return true;
  if (value === '::1' || value === '::') return true;
  if (net.isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return false;
  }
  const lower = value.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('2001:db8')) return true;
  return false;
}

const LOCAL = Object.freeze({ code: null, label: '本地', asn: null, asName: null });
const UNKNOWN = Object.freeze({ code: null, label: null, asn: null, asName: null });

function fromMmdb(ip) {
  const result = { code: null, label: null, asn: null, asName: null };
  const city = cityDb?.get(ip);
  if (city?.country?.iso_code) result.code = city.country.iso_code;
  const asn = asnDb?.get(ip);
  if (asn?.autonomous_system_number) {
    result.asn = asn.autonomous_system_number;
    result.asName = asn.autonomous_system_organization || null;
  }
  return result;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

const has = result => result && (result.code || result.asn);

async function readLimitedText(response, maxBytes = 64 * 1024) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new Error('response too large');
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
        throw new Error('response too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function getJson(url, ms = 3000) {
  const timeout = withTimeout(ms);
  try {
    const response = await fetch(url, {
      signal: timeout.signal,
      headers: { 'User-Agent': 'chicken-vps/1.0' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(await readLimitedText(response));
  } finally {
    timeout.done();
  }
}

async function fromIpWhoIs(ip) {
  const data = await getJson(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,connection`);
  if (!data || data.success === false) return null;
  const asn = data.connection?.asn;
  return {
    code: data.country_code || null,
    label: null,
    asn: typeof asn === 'number' ? asn : (asn ? +String(asn).replace(/^AS/i, '') || null : null),
    asName: data.connection?.isp || data.connection?.org || null,
  };
}

async function fromIpApiCo(ip) {
  const data = await getJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
  if (!data || data.error) return null;
  return {
    code: data.country_code || data.country || null,
    label: null,
    asn: data.asn ? +String(data.asn).replace(/^AS/i, '') || null : null,
    asName: data.org || null,
  };
}

const PROVIDERS = Object.freeze({
  'ipwho.is': fromIpWhoIs,
  'ipapi.co': fromIpApiCo,
});

function providerNames(options) {
  const configured = Array.isArray(options?.providers) ? options.providers : [];
  const names = configured.filter(name => Object.prototype.hasOwnProperty.call(PROVIDERS, name));
  return names.length ? names : Object.keys(PROVIDERS);
}

async function fromProviders(ip, options) {
  for (const name of providerNames(options)) {
    try {
      const result = await PROVIDERS[name](ip);
      if (has(result)) return result;
    } catch (error) {
      // 不记录 IP；只记录服务名和错误类型，避免把访客地址写入日志。
      console.log(`[geo] ${name} 查询失败:`, error.message);
    }
  }
  return UNKNOWN;
}

export async function lookup(ip, options = {}) {
  await initMmdb();
  const normalizedIp = canonicalIp(ip);
  if (!normalizedIp) return UNKNOWN;
  const external = options?.externalLookup === true;
  const cacheKey = `${external ? 'external' : 'local'}:${normalizedIp}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let result;
  if (isPrivate(normalizedIp)) {
    result = LOCAL;
  } else if (cityDb || asnDb) {
    result = fromMmdb(normalizedIp);
    if (!result.asn && external) {
      const extra = await fromProviders(normalizedIp, options);
      result = { ...result, asn: extra.asn, asName: extra.asName, code: result.code || extra.code };
    }
  } else {
    result = external ? await fromProviders(normalizedIp, options) : UNKNOWN;
  }

  cache.set(cacheKey, result);
  if (cache.size > 10000) cache.clear();
  return result;
}
