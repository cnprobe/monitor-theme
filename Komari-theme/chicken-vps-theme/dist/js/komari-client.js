// 浏览器内同源 Komari 客户端：主题 ZIP 自己读取节点数据，不依赖 Bridge 探针轮询。
// 登录用户使用 session Cookie；私有站点的临时分享链接使用 temp_key Cookie。
// fetch(..., credentials: 'include') 会自动携带这些 Cookie，ZIP 内不保存任何凭据。

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;
const DEFAULT_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 2000;
const MAX_INTERVAL_MS = 60000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const STALE_MS = 5 * 60 * 1000;
const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

const safeText = (value, max = 160) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ').slice(0, max)
  : '';
const safeNumber = (value, min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

function hash32(value) {
  let hash = 2166136261;
  const source = String(value || '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function toRecord(value) {
  const out = new Map();
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 1000)) {
      if (!item || typeof item !== 'object') continue;
      const key = String(item.uuid || item.client || item.id || '');
      if (key) out.set(key, item);
    }
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [fallbackKey, item] of Object.entries(value).slice(0, 1000)) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.uuid || item.client || fallbackKey);
    if (key) out.set(key, item);
  }
  return out;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(safeNumber(seconds, 0, 10 ** 12, 0)));
  if (!total) return '—';
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

function pingValue(value) {
  if (value && typeof value === 'object') return safeNumber(value.latest ?? value.value ?? value.delay, 0, 1e9, 0);
  return safeNumber(value, 0, 1e9, 0);
}

/** 把 Komari RPC 的 Client + NodeStatus 合并成前端 Chicken 使用的 stats 形状。 */
export function normalizeKomariNodes(clients, statuses) {
  const clientMap = toRecord(clients);
  const statusMap = toRecord(statuses);
  const keys = new Set([...clientMap.keys(), ...statusMap.keys()]);
  const nodes = [];
  for (const key of keys) {
    const client = clientMap.get(key) || {};
    const status = statusMap.get(key) || {};
    // 主题 ZIP 永远不展示隐藏节点，避免登录管理员时把后台专属对象带进公开场景。
    if (client.hidden) continue;
    const time = timestampMs(status.time);
    const online = typeof status.online === 'boolean'
      ? status.online
      : time !== null && Date.now() - time < STALE_MS;
    const pingValues = status.ping && typeof status.ping === 'object'
      ? Object.values(status.ping).map(pingValue).filter(value => value > 0)
      : [];
    nodes.push({
      key: safeText(key, 256),
      name: safeText(client.name || status.name || key, 120),
      online,
      region: safeText(client.region || client.group, 16) || null,
      location: safeText(client.group || client.region, 120),
      type: safeText([client.os, client.arch].filter(Boolean).join(' / '), 160),
      os: safeText(client.os, 80),
      arch: safeText(client.arch, 80),
      cpu: safeNumber(status.cpu, 0, 100, 0),
      memU: +(safeNumber(status.ram, 0, 1e15, 0) / 1024).toFixed(1),
      memT: +(safeNumber(status.ram_total ?? client.mem_total, 0, 1e15, 0) / 1024).toFixed(1),
      hddU: +(safeNumber(status.disk, 0, 1e15, 0) / 1024 / 1024).toFixed(1),
      hddT: +(safeNumber(status.disk_total ?? client.disk_total, 0, 1e15, 0) / 1024 / 1024).toFixed(1),
      netRx: safeNumber(status.net_in, 0, 1e15, 0),
      netTx: safeNumber(status.net_out, 0, 1e15, 0),
      netIn: safeNumber(status.net_total_down, 0, 1e15, 0),
      netOut: safeNumber(status.net_total_up, 0, 1e15, 0),
      ping: pingValues.length ? Math.min(...pingValues) : null,
      uptime: formatUptime(status.uptime),
      uptimeSec: safeNumber(status.uptime, 0, 1e12, 0),
    });
  }
  return nodes;
}

/** 按名称或稳定随机种子选择节点；0 表示全部。相同 seed 的访客会选择相同的一批。 */
export function selectKomariNodes(nodes, { limit = DEFAULT_LIMIT, order = 'random', seed = '' } = {}) {
  const safe = (Array.isArray(nodes) ? nodes : []).filter(node => node && typeof node === 'object' && node.key);
  const requested = Number(limit);
  const count = Number.isFinite(requested) && requested > 0
    ? Math.min(MAX_LIMIT, Math.floor(requested))
    : Math.min(MAX_LIMIT, safe.length);
  const sorted = order === '按名称' || order === 'name'
    ? safe.slice().sort((a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key), 'zh-CN'))
    : safe.slice().sort((a, b) => {
      const difference = hash32(`${seed}:${a.key}`) - hash32(`${seed}:${b.key}`);
      return difference || String(a.key).localeCompare(String(b.key));
    });
  return sorted.slice(0, count);
}

export class KomariBrowserError extends Error {
  constructor(message, { status = 0, code = 0, unauthorized = false } = {}) {
    super(message);
    this.name = 'KomariBrowserError';
    this.status = status;
    this.code = code;
    this.unauthorized = unauthorized;
  }
}

export class KomariBrowserClient {
  constructor({ endpoint = '/api/rpc2', fetchImpl, timeoutMs = 10000 } = {}) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.timeoutMs = timeoutMs;
    this.limit = DEFAULT_LIMIT;
    this.order = 'random';
    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.seed = typeof location === 'object' ? location.host : 'komari';
    this.handlers = new Map();
    this.requestId = 0;
    this.timer = null;
    this.running = false;
    this.refreshing = false;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  emit(event, ...args) {
    for (const handler of this.handlers.get(event) || []) {
      try { handler(...args); } catch (error) { console.error(`[komari] ${event} handler failed`, error); }
    }
  }

  configure(settings = {}) {
    const rawLimit = Number(settings.probe_limit);
    this.limit = Number.isFinite(rawLimit) && rawLimit >= 0
      ? Math.min(MAX_LIMIT, Math.floor(rawLimit))
      : DEFAULT_LIMIT;
    this.order = settings.probe_order === '按名称' || settings.probe_order === 'name' ? '按名称' : '随机';
    const seconds = Number(settings.probe_refresh_seconds);
    const interval = Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_INTERVAL_MS;
    this.intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, interval));
    this.seed = safeText(settings.seed || this.seed, 200);
    if (this.running) {
      clearInterval(this.timer);
      this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  async call(method, params = {}) {
    if (!this.fetchImpl) throw new KomariBrowserError('当前浏览器不支持 fetch');
    if (typeof location === 'object') {
      let endpointUrl;
      try { endpointUrl = new URL(this.endpoint, location.href); } catch { throw new KomariBrowserError('Komari RPC 地址无效'); }
      if (endpointUrl.origin !== location.origin) throw new KomariBrowserError('Komari RPC 必须使用同源地址');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const id = ++this.requestId;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new KomariBrowserError('需要登录 Komari 或使用有效的临时分享链接', {
          status: response.status,
          unauthorized: true,
        });
      }
      if (!response.ok) throw new KomariBrowserError(`Komari RPC HTTP ${response.status}`, { status: response.status });
      const advertised = Number(response.headers.get('content-length'));
      if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
        throw new KomariBrowserError('Komari RPC 响应过大');
      }
      const raw = await response.text();
      if ((textEncoder ? textEncoder.encode(raw).byteLength : raw.length) > MAX_RESPONSE_BYTES) {
        throw new KomariBrowserError('Komari RPC 响应过大');
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new KomariBrowserError('Komari RPC 返回的不是 JSON'); }
      if (payload?.error) {
        const message = safeText(payload.error.message || 'Komari RPC 请求失败', 200);
        throw new KomariBrowserError(message, {
          code: safeNumber(payload.error.code, 0, 1e9, 0),
          unauthorized: /private site|login|permission|auth|认证|登录|权限/i.test(message),
        });
      }
      if (!payload || payload.id !== id) throw new KomariBrowserError('Komari RPC 响应 ID 不匹配');
      return payload.result;
    } catch (error) {
      if (error instanceof KomariBrowserError) throw error;
      if (error?.name === 'AbortError') throw new KomariBrowserError('Komari RPC 请求超时');
      throw new KomariBrowserError(error?.message || String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // 只用 public 元数据方法，避免把管理员可见的 Agent Token 暴露给主题 JavaScript。
      const clients = await this.call('public:getNodesInformation');
      const metadata = normalizeKomariNodes(clients, {});
      const selectedMetadata = selectKomariNodes(metadata, {
        limit: this.limit,
        order: this.order,
        seed: this.seed,
      });
      const uuids = selectedMetadata.map(node => node.key);
      const statuses = uuids.length
        ? await this.call('common:getNodesLatestStatus', { uuids })
        : {};
      const selectedKeys = new Set(uuids);
      const selected = normalizeKomariNodes(clients, statuses)
        .filter(node => selectedKeys.has(node.key));
      this.emit('nodes', selected, metadata.length);
      this.emit('health', { ok: true, error: null });
    } catch (error) {
      const message = error instanceof KomariBrowserError ? error.message : String(error?.message || error);
      this.emit('health', {
        ok: false,
        error: message,
        unauthorized: error?.unauthorized === true,
      });
    } finally {
      this.refreshing = false;
    }
  }
}
