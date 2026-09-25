// Bridge 从受信的 Komari Origin 读取公开主题设置，并同步多人鹅数量。
// 这里不携带 Cookie、API Key 或其他凭据；只接受 /api/public 的非敏感设置。

import { canonicalOrigin } from './security.js';

export const THEME_SETTINGS_POLL_MS = 15000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isLoopbackOrigin(origin) {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 优先使用显式配置；否则仅在白名单中恰好有一个 HTTPS 公网 Origin 时自动选择。
 * 没有唯一公网 Origin 时不轮询，避免把多个 Komari 站点混淆。
 */
export function selectThemeSettingsOrigin(config = {}) {
  const explicit = canonicalOrigin(config.themeSettingsOrigin || '');
  if (explicit && explicit !== '*') {
    // 公网设置 Origin 必须使用 HTTPS；回环地址保留本地开发兼容性。
    if (isLoopbackOrigin(explicit) || new URL(explicit).protocol === 'https:') return explicit;
    return '';
  }
  const origins = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
  const publicOrigins = [];
  for (const value of origins) {
    const origin = canonicalOrigin(value);
    if (origin && origin !== '*' && !isLoopbackOrigin(origin) && new URL(origin).protocol === 'https:') {
      publicOrigins.push(origin);
    }
  }
  // 多 Komari Origin 没有隐式目标，必须由管理员显式指定 themeSettingsOrigin。
  return publicOrigins.length === 1 ? publicOrigins[0] : '';
}

/** 从 Komari /api/public 的响应中读取 geese；没有该字段时返回 undefined。 */
export function readGeeseSetting(payload) {
  const settings = payload?.data?.theme_settings;
  if (!settings || typeof settings !== 'object' || !hasOwn(settings, 'geese')) return undefined;
  const raw = settings.geese;
  const value = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && raw.trim() ? Number(raw) : NaN);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('theme_settings.geese must be an integer between 0 and 100');
  }
  return value;
}

async function readResponseText(response) {
  if (!response.body || typeof response.body.getReader !== 'function') return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Komari public settings response is too large');
      }
      if (value) chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export async function fetchGeeseSetting(origin, {
  fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null,
  timeoutMs = FETCH_TIMEOUT_MS,
  signal,
} = {}) {
  const normalized = canonicalOrigin(origin);
  if (!normalized || normalized === '*') return undefined;
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL('/api/public', normalized), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response || response.ok !== true) {
      throw new Error(`Komari public settings returned HTTP ${response?.status ?? 'unknown'}`);
    }
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new Error('Komari public settings response is too large');
    }
    const raw = await readResponseText(response);
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Komari public settings response is too large');
    }
    return readGeeseSetting(JSON.parse(raw));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 启动轻量轮询器。设置变化约在 15 秒内生效；网络失败时保留当前数量。
 * 返回停止函数，便于测试或优雅关闭。
 */
export function startThemeSettingsPoller({
  config = {},
  onGeese,
  fetchImpl,
  intervalMs = THEME_SETTINGS_POLL_MS,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const origin = selectThemeSettingsOrigin(config);
  if (!origin || typeof onGeese !== 'function') return () => {};

  const delay = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : THEME_SETTINGS_POLL_MS;
  let stopped = false;
  let running = false;
  let warned = false;
  let activeController = null;

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    const controller = new AbortController();
    activeController = controller;
    try {
      const value = await fetchGeeseSetting(origin, { fetchImpl, timeoutMs, signal: controller.signal });
      if (!stopped && value !== undefined) onGeese(value);
      if (!stopped) warned = false;
    } catch (error) {
      if (stopped) return;
      if (!warned) {
        console.warn(`[theme-settings] 无法读取 ${origin}/api/public：${error.message}`);
        warned = true;
      }
    } finally {
      if (activeController === controller) activeController = null;
      running = false;
    }
  };

  void poll();
  const timer = setInterval(poll, delay);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    activeController?.abort();
    clearInterval(timer);
  };
}
