import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function collectMessages(socket) {
  const messages = [];
  const waiters = new Set();
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    messages.push(message);
  });
  return {
    messages,
    waitFor(predicate, timeoutMs = 5000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting for WebSocket message; received ${JSON.stringify(messages)}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
  };
}

async function waitForOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Bridge exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Bridge health check timed out');
}

test('two clients receive authoritative roster, snapshots, and resume the same player', { timeout: 20000 }, async () => {
  const port = await freePort();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'chicken-bridge-integration-'));
  const configPath = path.join(tempDir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    port,
    allowedOrigins: ['http://localhost:4173'],
    geese: 1,
    maxPlayers: 10,
  }));

  const child = spawn(process.execPath, ['bridge/server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CONFIG_PATH: configPath,
      TRUST_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.resume();

  let first = null;
  let second = null;
  try {
    await waitForHealth(port, child);
    const url = `ws://127.0.0.1:${port}/ws`;

    const firstSocket = new WebSocket(url, { origin: 'http://localhost:4173' });
    const firstCollector = collectMessages(firstSocket);
    await waitForOpen(firstSocket);
    first = { socket: firstSocket, collector: firstCollector };
    const welcome1 = await firstCollector.waitFor(message => message.t === 'w');
    assert.equal(welcome1.protocol, 2);
    assert.equal(welcome1.capabilities.authoritativePlayers, true);
    assert.equal(welcome1.capabilities.geese, true);
    assert.ok(welcome1.token);

    const secondSocket = new WebSocket(url, { origin: 'http://localhost:4173' });
    const secondCollector = collectMessages(secondSocket);
    await waitForOpen(secondSocket);
    second = { socket: secondSocket, collector: secondCollector };

    const roster = await secondCollector.waitFor(message => (
      message.t === 'r' && message.list.filter(info => !info.npc).length === 2
    ));
    assert.equal(roster.list.filter(info => info.npc && info.type === 'goose').length, 1);
    assert.equal(roster.list.some(info => 'stats' in info || 'readonly' in info), false);
    assert.equal('probe' in roster, false);

    const snapshot = await secondCollector.waitFor(message => (
      message.t === 's' && message.ps.filter(row => row[0] === welcome1.id).length === 1
    ));
    assert.ok(snapshot.ps.some(row => row[0] === welcome1.id));

    const firstClosed = new Promise(resolve => first.socket.once('close', resolve));
    first.socket.close();
    await firstClosed;
    first = null;

    const resumedSocket = new WebSocket(url, { origin: 'http://localhost:4173' });
    const resumedCollector = collectMessages(resumedSocket);
    await waitForOpen(resumedSocket);
    resumedSocket.send(JSON.stringify({ t: 'hello', token: welcome1.token }));
    const resumedWelcome = await resumedCollector.waitFor(message => message.t === 'w' && message.resumed === true);
    assert.equal(resumedWelcome.id, welcome1.id);
    assert.notEqual(resumedWelcome.token, welcome1.token);
    resumedSocket.close();
  } catch (error) {
    error.message += `\nBridge stderr:\n${stderr}`;
    throw error;
  } finally {
    first?.socket.close();
    second?.socket.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
