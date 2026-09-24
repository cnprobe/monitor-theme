// WebSocket 网络层：读取 Komari 公开主题设置，连接伴生服务并自动重连。

const STORAGE_KEY = 'cf.bridge.url';
const NAME_KEY = 'cf.name';
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_ROSTER_ENTITIES = 500;
const MAX_SNAPSHOT_ENTITIES = 500;
const MAX_OBSTACLES = 100;
const MAX_EVENTS = 100;
const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, '').slice(0, max)
  : '';
const safeNumber = (value, min, max, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const safeId = value => Number.isSafeInteger(Number(value)) ? Number(value) : 0;

function frameSize(data) {
  if (typeof data === 'string') return textEncoder ? textEncoder.encode(data).byteLength : data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data && typeof data.size === 'number') return data.size;
  return 0;
}

async function frameText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === 'function') return data.text();
  return '';
}

function sanitizeStats(stats) {
  if (!isObject(stats)) return null;
  return {
    cpu: safeNumber(stats.cpu, 0, 100, 0),
    memU: safeNumber(stats.memU, 0, 1e15, 0),
    memT: safeNumber(stats.memT, 0, 1e15, 0),
    hddU: safeNumber(stats.hddU, 0, 1e15, 0),
    hddT: safeNumber(stats.hddT, 0, 1e15, 0),
    netTx: safeNumber(stats.netTx, 0, 1e15, 0),
    netRx: safeNumber(stats.netRx, 0, 1e15, 0),
    netIn: safeNumber(stats.netIn, 0, 1e15, 0),
    netOut: safeNumber(stats.netOut, 0, 1e15, 0),
    latency: safeNumber(stats.latency, 0, 1e9, 0),
    uptime: safeText(stats.uptime, 64),
    region: safeText(stats.region, 16),
    type: safeText(stats.type, 160),
    site: !!stats.site,
    online: stats.online !== false,
    os: safeText(stats.os, 80),
    arch: safeText(stats.arch, 80),
    err: safeText(stats.err, 120),
  };
}

function sanitizeRosterInfo(info) {
  if (!isObject(info)) return null;
  const id = safeId(info.id);
  if (!id) return null;
  return {
    id,
    name: safeText(info.name, 120),
    color: safeNumber(info.color, 0, 32, 0),
    maxHp: safeNumber(info.maxHp, 1, 1000, 100),
    scale: safeNumber(info.scale, 0.5, 2, 1),
    score: safeNumber(info.score, 0, 1e9, 0),
    npc: !!info.npc,
    type: safeText(info.type, 16),
    offline: !!info.offline,
    flag: safeText(info.flag, 2),
    asn: info.asn === null || info.asn === undefined ? '' : safeText(String(info.asn), 32),
    asName: safeText(info.asName, 120),
    stats: sanitizeStats(info.stats),
  };
}

function sanitizeRoster(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_ROSTER_ENTITIES)
    .map(sanitizeRosterInfo).filter(Boolean);
}

function sanitizeProbe(probe) {
  if (!isObject(probe)) return null;
  return {
    ok: probe.ok !== false,
    error: safeText(probe.error, 160),
    sources: (Array.isArray(probe.sources) ? probe.sources : []).slice(0, 100).map(source => ({
      name: safeText(source?.name, 120),
      ok: source?.ok !== false,
      error: safeText(source?.error, 80),
      warning: safeText(source?.warning, 80),
      kept: safeNumber(source?.kept, 0, MAX_ROSTER_ENTITIES, 0),
    })),
  };
}

function sanitizeConf(conf) {
  if (!isObject(conf)) return {};
  return {
    koTime: safeNumber(conf.koTime, 0, 60, 5),
    maxHp: safeNumber(conf.maxHp, 1, 1000, 100),
    radius: safeNumber(conf.radius, 0.1, 10, 0.38),
    maxSpeed: safeNumber(conf.maxSpeed, 0.1, 100, 6),
    sprintSpeed: safeNumber(conf.sprintSpeed, 0.1, 100, 9),
    separation: safeNumber(conf.separation, 0, 100, 8),
  };
}

function sanitizeWelcome(message) {
  return {
    t: 'w',
    id: safeId(message.id),
    conf: sanitizeConf(message.conf),
    half: safeNumber(message.half, 10, 1000, 48),
    colors: safeNumber(message.colors, 1, 64, 5),
    obstacles: (Array.isArray(message.obstacles) ? message.obstacles : []).slice(0, MAX_OBSTACLES).map(obstacle => ({
      type: safeText(obstacle?.type, 16),
      x: safeNumber(obstacle?.x, -1000, 1000),
      z: safeNumber(obstacle?.z, -1000, 1000),
      w: safeNumber(obstacle?.w, 0.01, 1000, 1),
      d: safeNumber(obstacle?.d, 0.01, 1000, 1),
      h: safeNumber(obstacle?.h, 0.01, 1000, 1),
    })),
    token: typeof message.token === 'string' && message.token.length <= 128 ? message.token : undefined,
    resumed: !!message.resumed,
  };
}

function sanitizeSnapshot(message) {
  const ps = (Array.isArray(message.ps) ? message.ps : []).slice(0, MAX_SNAPSHOT_ENTITIES)
    .filter(row => Array.isArray(row) && row.length >= 8)
    .map(row => [
      safeId(row[0]),
      safeNumber(row[1], -1000, 1000),
      safeNumber(row[2], -1000, 1000),
      safeNumber(row[3], -1000, 1000),
      safeNumber(row[4], -Math.PI * 4, Math.PI * 4),
      safeNumber(row[5], 0, 255),
      safeNumber(row[6], 0, 1000),
      safeNumber(row[7], 0, 1e9),
    ]);
  const ev = (Array.isArray(message.ev) ? message.ev : []).slice(0, MAX_EVENTS).map(item => ({
    e: safeText(item?.e, 16),
    f: safeId(item?.f),
    t: safeId(item?.t),
    hp: safeNumber(item?.hp, 0, 1000),
  }));
  return {
    t: 's',
    tick: safeNumber(message.tick, 0, Number.MAX_SAFE_INTEGER, 0),
    ps,
    ev,
  };
}

function readStorage(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function readSession(key) {
  try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
}

function writeSession(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* ignore */ }
}

function isLocalDevelopmentHost() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
}

async function loadPublicSettings() {
  try {
    const response = await fetch('/api/public', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.text();
    if (frameSize(raw) > MAX_FRAME_BYTES) return {};
    const payload = JSON.parse(raw);
    return payload && payload.data && typeof payload.data === 'object' ? payload.data : {};
  } catch {
    return {};
  }
}

export function normalizeBridgeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw, location.href);
  } catch {
    return '';
  }
  const pageIsSecure = location.protocol === 'https:';
  if (url.protocol === 'http:') {
    if (pageIsSecure) return '';
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
  const loopbackHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'ws:' && !loopbackHost) return '';
  if (pageIsSecure && url.protocol !== 'wss:') return '';
  if (url.username || url.password || url.hash) return '';
  for (const key of url.searchParams.keys()) {
    if (/(token|secret|password|api[_-]?key|auth)/i.test(key)) return '';
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
  return url.toString();
}

export class Net {
  constructor() {
    this.handlers = {};
    this.ws = null;
    this.connected = false;
    const savedSession = readSession('cf.session');
    try {
      const parsed = JSON.parse(savedSession);
      this.token = typeof parsed?.token === 'string' ? parsed.token : '';
      this.tokenOrigin = typeof parsed?.origin === 'string' ? parsed.origin : '';
    } catch {
      this.token = '';
      this.tokenOrigin = '';
    }
    this.name = readStorage(NAME_KEY);
    this.retry = 0;
    this.reconnectTimer = null;
    this.closing = false;
    this.maxDelay = 10000;
    this.endpoint = '';
    this.publicSettings = {};
    this.ready = this.resolveEndpoint();
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
  emit(evt, ...data) { (this.handlers[evt] || []).forEach(fn => fn(...data)); }

  async resolveEndpoint() {
    this.publicSettings = await loadPublicSettings();
    this.emit('settings', this.publicSettings);

    const queryOverride = new URLSearchParams(location.search).get('bridge');
    const settings = this.publicSettings.theme_settings || {};
    const configured = settings.bridge_url || settings.bridgeUrl || '';
    // 只允许本机开发页使用 ?bridge= 或旧的本地存储覆盖，避免恶意链接把
    // 访客的本地游戏会话令牌转发到任意 WebSocket。
    const localOverride = isLocalDevelopmentHost() ? (queryOverride || readStorage(STORAGE_KEY)) : '';
    this.endpoint = normalizeBridgeUrl(localOverride || configured);
    return this.endpoint;
  }

  connect() {
    this.connectPromise = this.ready.then((endpoint) => {
      if (!endpoint) {
        this.emit('bridge', 'missing', '尚未配置伴生服务 WebSocket 地址');
        this.emit('bridge-unavailable');
        return;
      }
      this.open(endpoint);
    });
    return this.connectPromise;
  }

  open(endpoint) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closing = false;
    this.emit('bridge', 'connecting', endpoint);
    const ws = new WebSocket(endpoint);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.emit('bridge', 'connected', endpoint);
      if (this.token && this.tokenOrigin === endpoint) this.send({ t: 'hello', token: this.token });
      if (this.name) this.send({ t: 'profile', name: this.name });
    };

    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.closing) return;
      const delay = wasConnected
        ? Math.min(this.maxDelay, 600 * Math.pow(1.7, this.retry++))
        : Math.min(this.maxDelay, 800 * Math.pow(1.5, this.retry++));
      this.emit('bridge', 'reconnecting', `${Math.round(delay / 1000)} 秒后重连`);
      if (wasConnected) this.emit('drop', delay);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.open(endpoint), delay);
    };

    ws.onerror = () => {
      this.emit('bridge', 'error', '无法连接伴生服务');
    };

    ws.onmessage = async (event) => {
      if (frameSize(event.data) > MAX_FRAME_BYTES) {
        try { ws.close(1009, 'frame-too-large'); } catch { /* ignore */ }
        return;
      }
      let raw;
      try { raw = await frameText(event.data); } catch { return; }
      if (frameSize(raw) > MAX_FRAME_BYTES) {
        try { ws.close(1009, 'frame-too-large'); } catch { /* ignore */ }
        return;
      }
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.t === 'w') {
        const welcome = sanitizeWelcome(message);
        if (welcome.token) {
          this.token = welcome.token;
          this.tokenOrigin = endpoint;
          writeSession('cf.session', JSON.stringify({ origin: endpoint, token: welcome.token }));
        }
        this.emit('welcome', welcome);
      } else if (message.t === 'r') {
        this.emit('roster', sanitizeRoster(message.list), sanitizeProbe(message.probe), sanitizeRoster(message.left));
      } else if (message.t === 's') {
        this.emit('snapshot', sanitizeSnapshot(message));
      } else if (message.t === 'resume') {
        this.emit('resume', { t: 'resume', id: safeId(message.id), name: safeText(message.name, 120) });
      } else if (message.t === 'error') {
        this.emit('bridge-error', { t: 'error', message: safeText(message.message, 240) });
      }
    };
  }

  sendProfile(name) {
    const clean = String(name || '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean || [...clean].length > 12) return false;
    this.name = clean;
    writeStorage(NAME_KEY, clean);
    this.send({ t: 'profile', name: clean });
    return true;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }
}
