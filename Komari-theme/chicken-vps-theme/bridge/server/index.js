// 伴生服务 HTTP 健康检查 + WebSocket 入口。主题静态文件由 Komari 提供。

import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import cfg from './config.js';
import { isOriginAllowed, isTrustedProxy } from './security.js';

const portValue = process.env.PORT !== undefined && process.env.PORT !== ''
  ? process.env.PORT : (cfg.port ?? 3777);
const PORT = Number(portValue);
const HOST = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error(`[config] PORT must be an integer between 0 and 65535 (got ${portValue})`);
}

const handshakeAttempts = new Map();
function allowHandshake(ip, limit = 60) {
  const maxAttempts = Number.isInteger(limit) && limit > 0 ? limit : 60;
  const now = Date.now();
  const key = ip || 'unknown';
  const recent = (handshakeAttempts.get(key) || []).filter(time => now - time < 60_000);
  if (recent.length >= maxAttempts) return false;
  recent.push(now);
  handshakeAttempts.set(key, recent);
  if (handshakeAttempts.size > 10_000) {
    const oldest = handshakeAttempts.keys().next().value;
    handshakeAttempts.delete(oldest);
  }
  return true;
}

function rateLimitKey(req) {
  let peer = req?.socket?.remoteAddress || 'unknown';
  if (peer.startsWith('::ffff:')) peer = peer.slice(7);
  if (isTrustedProxy(peer, cfg.trustedProxyCidrs)) {
    const forwarded = req.headers?.['cf-connecting-ip'] || req.headers?.['x-forwarded-for']?.split(',')[0];
    const value = String(forwarded || '').trim();
    if (value && net.isIP(value.replace(/^::ffff:/i, ''))) return value;
  }
  return peer;
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});
server.maxConnections = 256;

// 入站消息很小；限制单帧大小避免 JSON 解析阻塞事件循环。
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 16 * 1024,
  verifyClient: (info, done) => {
    const origin = info.origin || info.req?.headers?.origin;
    // Origin 先校验，避免无效请求消耗代理共享的速率桶。
    if (!isOriginAllowed(origin, cfg.allowedOrigins)) {
      done(false, 403, 'Origin not allowed');
      return;
    }
    if (!allowHandshake(rateLimitKey(info.req), cfg.maxHandshakesPerMinute)) {
      done(false, 429, 'Too many connections');
      return;
    }
    done(true);
  },
});

const game = new Game(wss, cfg);
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  game.onConnection(ws, req).catch(error => {
    console.error('[conn]', error);
    try { ws.close(); } catch { /* ignore */ }
  });
});

// 清理过期握手记录，并淘汰没有响应 ping 的半开连接。
setInterval(() => {
  const now = Date.now();
  for (const [key, attempts] of handshakeAttempts) {
    const recent = attempts.filter(time => now - time < 60_000);
    if (recent.length) handshakeAttempts.set(key, recent);
    else handshakeAttempts.delete(key);
  }
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30_000);

// 每秒重置连接的消息数和字节预算。
setInterval(() => {
  for (const ws of wss.clients) {
    ws._msgs = 0;
    ws._bytes = 0;
  }
}, 1000);

server.listen(PORT, HOST, () => {
  console.log(`🐔 养鸡VPS伴生服务已启动: http://${HOST}:${PORT}`);
  console.log('   主题静态资源由 Komari 提供；此服务只暴露 /health 和 /ws');
});
