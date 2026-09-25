import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve("dist");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const fixtureNodes = Array.from({ length: 12 }, (_, index) => ({
  uuid: `preview-${index + 1}`,
  name: `预览节点 ${String(index + 1).padStart(2, '0')}`,
  region: index % 2 ? 'CN' : 'JP',
  os: 'Linux',
  arch: 'amd64',
  mem_total: 2 * 1024 * 1024 * 1024,
  disk_total: 20 * 1024 * 1024 * 1024,
  hidden: false,
}));

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 256 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8') || '{}');
}

async function serveFixtureApi(pathname, request, response) {
  if (pathname === '/api/public') {
    sendJson(response, 200, {
      status: 'success',
      data: {
        sitename: 'Chicken Farm Preview',
        private_site: false,
        theme_settings: {
          bridge_url: '',
          geese: 2,
          probe_limit: 6,
          probe_order: '随机',
          probe_refresh_seconds: 5,
          player_name: '预览小鸡',
          footer_text: '',
          label_mode: '完整',
          sound_enabled: false,
          show_controls: true,
        },
      },
    });
    return true;
  }
  if (pathname !== '/api/rpc2') return false;
  try {
    const payload = await readJsonBody(request);
    const calls = Array.isArray(payload) ? payload : [payload];
    const statuses = Object.fromEntries(fixtureNodes.map((node, index) => [node.uuid, {
      client: node.uuid,
      online: index !== 3,
      cpu: 15 + index * 5,
      ram: (0.4 + index * 0.03) * node.mem_total,
      ram_total: node.mem_total,
      disk: (0.2 + index * 0.02) * node.disk_total,
      disk_total: node.disk_total,
      net_in: 12000 + index * 1000,
      net_out: 8000 + index * 700,
      net_total_down: 10 ** 9,
      net_total_up: 5 * 10 ** 8,
      uptime: 86400 + index * 3600,
    }]));
    const results = calls.map(call => {
      let result;
      if (call.method === 'public:getNodesInformation') result = fixtureNodes;
      else if (call.method === 'common:getNodesLatestStatus') {
        const wanted = Array.isArray(call.params?.uuids) ? new Set(call.params.uuids) : null;
        result = wanted
          ? Object.fromEntries(Object.entries(statuses).filter(([uuid]) => wanted.has(uuid)))
          : statuses;
      } else result = null;
      return { jsonrpc: '2.0', id: call.id ?? null, result };
    });
    sendJson(response, 200, Array.isArray(payload) ? results : results[0]);
  } catch (error) {
    sendJson(response, 400, { error: { code: -32700, message: error.message } });
  }
  return true;
}

const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://local").pathname);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("bad request");
    return;
  }
  if (await serveFixtureApi(pathname, request, response)) return;
  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: { code: -32601, message: 'API fixture not found' } });
    return;
  }

  const requested = pathname === "/" ? "/index.html" : pathname;
  let file = resolve(root, `.${requested}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = resolve(file, "index.html");
  } catch {
    file = resolve(root, "index.html");
  }

  response.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
  response.setHeader("Cache-Control", "no-cache");
  createReadStream(file)
    .on("error", () => response.writeHead(404).end("not found"))
    .pipe(response);
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Chicken Farm theme preview: http://${host}:${actualPort}`);
});
