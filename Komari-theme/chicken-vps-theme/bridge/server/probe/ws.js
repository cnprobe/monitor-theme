// WebSocket JSON-RPC 客户端
//
// 为什么不用 Node 22 内置的 WebSocket（undici）：
//   Komari 站点普遍挂在 Cloudflare 后面，实测内置 WebSocket 握手失败
//   （error: "Received network error or non-101 status code"），
//   而 `ws` 库 + 显式 Origin 头可以成功升级。
//   → 本项目已依赖 `ws`（游戏服务器在用），直接复用，不引入新依赖。
//
// 职责：连接 → 发一批 JSON-RPC 请求 → 按 id 收集响应 → 关闭。
// 带请求超时、错误归一、以及 TTL 结果缓存（Komari 官方前端本身也缓存 2 分钟）。

import WebSocket from 'ws';
import { readResponseText } from './http.js';

const DEFAULT_TTL = 5_000;

export class RpcClient {
  /**
   * @param {string} url  ws:// 或 wss:// 端点
   * @param {object} opts { origin, headers, timeout, ttl, heartbeat }
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.origin = opts.origin || (() => {
      try { return new URL(url).origin; } catch { return undefined; }
    })();
    this.headers = opts.headers || {};
    this.timeout = opts.timeout ?? 12000;
    this.ttl = opts.ttl ?? DEFAULT_TTL;
    this.maxPayload = opts.maxPayload ?? 2 * 1024 * 1024;
    this._cache = new Map();   // method -> { ts, value }
    this._inflight = null;
  }

  /** 调一批方法，返回 { method: result | {__error} } */
  async call(calls) {
    const now = Date.now();
    const result = {};
    const todo = [];

    for (const c of calls) {
      const hit = this._cache.get(c.method);
      if (hit && now - hit.ts < this.ttl) {
        result[c.method] = hit.value;
      } else {
        todo.push(c);
      }
    }
    if (!todo.length) return result;

    // 合并并发调用：同一时刻只维持一条连接
    if (this._inflight) {
      const inflightRes = await this._inflight.catch(() => ({}));
      for (const c of todo) {
        if (c.method in inflightRes) result[c.method] = inflightRes[c.method];
        else {
          const hit = this._cache.get(c.method);
          if (hit) result[c.method] = hit.value;
        }
      }
      const missing = todo.filter(c => !(c.method in result));
      if (!missing.length) return result;
      const second = await this._round(missing);
      Object.assign(result, second);
      return result;
    }

    this._inflight = this._round(todo);
    try {
      const r = await this._inflight;
      for (const c of todo) {
        if (c.method in r) {
          result[c.method] = r[c.method];
          this._cache.set(c.method, { ts: Date.now(), value: r[c.method] });
        }
      }
    } finally {
      this._inflight = null;
    }
    return result;
  }

  _round(calls) {
    return new Promise(resolve => {
      // ⚠ 结果必须以 **方法名** 为键返回，调用方（call()）是按方法名取值的。
      //   早期版本以 JSON-RPC 的 id 为键，导致 call() 里 `c.method in r` 永远 false，
      //   表现为「连接成功但拿不到任何数据」。
      const out = {};
      const idOf = c => c.id ?? c.method;
      let ws;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws && ws.close(); } catch { /* ignore */ }
        resolve(out);
      };
      const timer = setTimeout(finish, this.timeout);

      try {
        ws = new WebSocket(this.url, {
          headers: { Origin: this.origin, 'User-Agent': 'Mozilla/5.0', ...this.headers },
          handshakeTimeout: this.timeout,
          maxPayload: this.maxPayload,
        });
      } catch (e) {
        clearTimeout(timer);
        for (const c of calls) out[c.method] = { __error: e.message };
        return resolve(out);
      }

      const byId = new Map(calls.map(c => [String(idOf(c)), c]));

      ws.on('open', () => {
        for (const c of calls) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: c.method, params: c.params || {}, id: idOf(c) }));
        }
      });
      ws.on('message', d => {
        let j;
        try { j = JSON.parse(d.toString()); } catch { return; }
        if (!j || typeof j !== 'object' || Array.isArray(j)) return;
        const hit = byId.get(String(j.id));
        if (!hit) return;                       // 通知帧 / 心跳回包，忽略
        if (j.error) out[hit.method] = { __error: j.error.message || JSON.stringify(j.error), __code: j.error.code };
        else out[hit.method] = j.result;
        if (calls.every(c => c.method in out)) finish();
      });
      ws.on('error', e => {
        for (const c of calls) if (!(c.method in out)) out[c.method] = { __error: e.message || 'websocket error' };
        finish();
      });
      ws.on('close', () => {
        for (const c of calls) if (!(c.method in out)) out[c.method] = { __error: '连接被关闭' };
        finish();
      });
    });
  }

  invalidate() { this._cache.clear(); }
}

/**
 * JSON-RPC 2.0 over HTTP POST —— 同一份协议走 http(s)，不需要 WS 升级。
 *
 * 为什么需要它：Nodeget 的官方前端**优先**用 POST 打同一个 URL
 * （把 wss:// 换成 https://），只有 fetch 失败（TypeError / Failed to fetch）
 * 才回退到 WebSocket。很多探针后端在 Cloudflare 后面 WS 握手会被拦，
 * POST 反而稳，所以这条通道值得单独支持。
 *
 * @param {string} url  ws(s):// 或 http(s):// 端点
 * @param {object} opts { token, timeout, ttl, headers, tokenIn } 
 *        tokenIn: 'params'(默认，Nodeget 风格) | 'header'(Bearer)
 */
export class HttpRpcClient {
  constructor(url, opts = {}) {
    this.url = String(url).replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    this.token = opts.token || null;
    this.tokenIn = opts.tokenIn || 'params';
    this.timeout = opts.timeout ?? 12000;
    this.ttl = opts.ttl ?? DEFAULT_TTL;
    this.headers = opts.headers || {};
    this.retry = opts.retry ?? 1;          // 瞬时失败重试次数
    this.retryDelay = opts.retryDelay ?? 400;
    this._cache = new Map();
    this._seq = 0;
  }

  async call(calls) {
    const now = Date.now();
    const result = {};
    const todo = [];
    for (const c of calls) {
      const hit = this._cache.get(c.method);
      if (hit && now - hit.ts < this.ttl) result[c.method] = hit.value;
      else todo.push(c);
    }
    if (!todo.length) return result;

    await Promise.all(todo.map(async c => {
      let r = await this._one(c);
      // 瞬时失败重试一次：上游偶发超时/连接重置时，重试比直接放弃划算得多
      // （尤其能避免"超时 → 回退 WS → 再超时一轮"的雪崩）。
      if (r && r.__error && this.retry > 0) {
        await new Promise(res => setTimeout(res, this.retryDelay));
        r = await this._one(c);
      }
      result[c.method] = r;
      if (!(r && r.__error)) this._cache.set(c.method, { ts: Date.now(), value: r });
    }));
    return result;
  }

  async _one(c) {
    const id = ++this._seq;
    const params = { ...(c.params || {}) };
    const headers = { 'Content-Type': 'application/json', ...this.headers };
    if (this.token) {
      if (this.tokenIn === 'params') params.token = this.token;
      else headers.Authorization = `Bearer ${this.token}`;
    }
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: c.method, params, id }),
        signal: AbortSignal.timeout(this.timeout),
        // JSON-RPC 可能携带 token/自定义凭据，禁止 HTTP 重定向把它们带到其它 Origin。
        redirect: this.token || Object.keys(headers).some(key =>
          !['content-type', 'accept', 'user-agent'].includes(String(key).toLowerCase())
        ) ? 'manual' : 'follow',
      });
      const txt = await readResponseText(res);
      let j;
      try { j = JSON.parse(txt); } catch {
        return { __error: `返回的不是 JSON（HTTP ${res.status}：${txt.slice(0, 60).replace(/\s+/g, ' ')}）` };
      }
      if (!res.ok) return { __error: `HTTP ${res.status}` };
      if (j.error) return { __error: j.error.message || JSON.stringify(j.error), __code: j.error.code };
      return j.result;
    } catch (e) {
      return { __error: e.name === 'TimeoutError' ? '请求超时' : e.message };
    }
  }

  invalidate() { this._cache.clear(); }
}

/**
 * 双通道 RPC：先 POST（更稳），失败再 WS。
 * Nodeget 官方前端就是这个策略，这里固化成可复用能力。
 *
 * ⚠ 关键：**区分「服务端拒绝」与「客户端放弃」**
 *   上游在被打多了之后会限流/超时，此时若立刻落到 WS，
 *   WS 又要重新握手 + 再超时一轮，一次读取就从 0.3s 变成 40s+。
 *   所以这里默认 concurrency=1 且给 POST 一次重试机会，
 *   只有 POST 明确"不是超时"的失败（比如 404/协议不符）才回退 WS。
 */
export class DualRpcClient {
  constructor(url, opts = {}) {
    this.http = new HttpRpcClient(url, opts);
    this.ws = new RpcClient(String(url).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:'), {
      ...opts,
      headers: opts.token && opts.tokenIn === 'header' ? { Authorization: `Bearer ${opts.token}`, ...opts.headers } : opts.headers,
    });
    this.url = url;
    // 是否允许回退到 WS。默认允许，但遇到"超时"类失败时不回退（见下面注释）。
    this.allowWsFallback = opts.allowWsFallback !== false;
  }

  async call(calls) {
    const viaHttp = await this.http.call(calls);
    const missing = calls.filter(c => {
      const v = viaHttp[c.method];
      return v === undefined || (v && v.__error);
    });
    if (!missing.length) return viaHttp;
    if (!this.allowWsFallback) return viaHttp;

    // 只在「POST 通道根本不可用」（如 HTTP 404 / 返回非 JSON / 连接被拒）时才用 WS。
    // 若是超时，多半是上游限流 —— 再开一条 WS 只会更慢，直接把错误带回去，
    // 让上层按"部分数据缺失"处理，别把整站拖成 40 秒。
    const httpUnusable = missing.every(c => {
      const e = viaHttp[c.method]?.__error || '';
      return e && !/超时|timeout/i.test(e);
    });
    if (!httpUnusable) return viaHttp;

    const viaWs = await this.ws.call(missing.map(c => ({
      ...c,
      params: { ...(c.params || {}), ...(this.http.token && this.http.tokenIn === 'params' ? { token: this.http.token } : {}) },
    })));
    const out = { ...viaHttp };
    for (const c of missing) if (viaWs[c.method] !== undefined) out[c.method] = viaWs[c.method];
    return out;
  }

  invalidate() { this.http.invalidate(); this.ws.invalidate(); }
}
