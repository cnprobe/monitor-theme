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

const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://local").pathname);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("bad request");
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
