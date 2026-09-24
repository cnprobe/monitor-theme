import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "komari-theme.json"), "utf8"));
const version = manifest.version;
const releaseDir = resolve(root, "release");
const output = resolve(releaseDir, `ChickenFarm-${version}.zip`);
const temporary = `${output}.tmp`;

await mkdir(releaseDir, { recursive: true });
await rm(temporary, { force: true });
await rm(output, { force: true });

const archive = archiver("zip", { zlib: { level: 9 } });
const finished = new Promise((resolvePromise, reject) => {
  archive.on("error", reject);
  archive.on("warning", (warning) => {
    if (warning.code !== "ENOENT") reject(warning);
  });
  archive.on("end", resolvePromise);
});
archive.pipe(createWriteStream(temporary));
archive.file(resolve(root, "komari-theme.json"), { name: "komari-theme.json" });
archive.file(resolve(root, "preview.svg"), { name: "preview.svg" });
archive.file(resolve(root, "NOTICE.md"), { name: "NOTICE.md" });
archive.file(resolve(root, "SECURITY.md"), { name: "SECURITY.md" });
archive.directory(resolve(root, "dist"), "dist");
await archive.finalize();
await finished;
await rename(temporary, output);
console.log(`Theme package: ${output}`);
