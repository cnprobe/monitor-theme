import { copyFile, cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "theme");
const output = resolve(root, "dist");
const threeModule = resolve(root, "node_modules/three/build/three.module.js");
const threeCore = resolve(root, "node_modules/three/build/three.core.js");
const threeLicense = resolve(root, "node_modules/three/LICENSE");

async function assertSafeThemeTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`主题目录不允许符号链接: ${relative(root, full)}`);
    if (/^(?:\.env|.*\.(?:pem|key|crt|bak|backup|log)|.*(?:secret|token|config).*)$/i.test(entry.name)) {
      throw new Error(`主题目录包含疑似敏感文件: ${relative(root, full)}`);
    }
    if (entry.isDirectory()) await assertSafeThemeTree(full);
    if (entry.isFile()) {
      const stat = await lstat(full);
      if (stat.size > 5 * 1024 * 1024) throw new Error(`主题文件过大: ${relative(root, full)}`);
    }
  }
}

async function assertRelativeImports(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await assertRelativeImports(full);
      continue;
    }
    if (!entry.isFile() || extname(entry.name) !== ".js") continue;
    const sourceText = await readFile(full, "utf8");
    const imports = /(?:from\s*|import\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;
    for (const match of sourceText.matchAll(imports)) {
      const target = resolve(dirname(full), match[1]);
      try {
        const stat = await lstat(target);
        if (!stat.isFile()) throw new Error("not a file");
      } catch {
        throw new Error(`构建产物存在未解析的相对模块导入: ${relative(root, full)} -> ${match[1]}`);
      }
    }
  }
}

await assertSafeThemeTree(source);
await rm(output, { force: true, recursive: true });
await cp(source, output, { recursive: true });
await mkdir(resolve(output, "vendor"), { recursive: true });
await copyFile(threeModule, resolve(output, "vendor/three.module.js"));
await copyFile(threeCore, resolve(output, "vendor/three.core.js"));
await copyFile(threeLicense, resolve(output, "vendor/THREE-LICENSE.txt"));

await assertRelativeImports(output);

const html = await readFile(resolve(output, "index.html"), "utf8");
const required = [
  "<title>Komari Monitor</title>",
  '<meta name="description" content="A simple server monitor tool." />',
  "Powered by Komari Monitor.",
];
for (const marker of required) {
  if (!html.includes(marker)) {
    throw new Error(`Built theme is missing Komari marker: ${marker}`);
  }
}

console.log(`Built Komari theme in ${output}`);
