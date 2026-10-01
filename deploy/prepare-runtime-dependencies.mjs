#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = resolve(process.argv[2] || ".");
const forceInstall = process.argv.includes("--install");
try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) throw new Error("需要 Node.js 22.5+");
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const lockText = await readFile(join(directory, "package-lock.json"), "utf8");
  const lock = JSON.parse(lockText);
  if (lock.lockfileVersion < 2 || !lock.packages?.[""]) throw new Error("缺少有效 npm 锁文件");
  const sorted = (value) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
  for (const field of ["dependencies", "optionalDependencies"]) {
    if (sorted(manifest[field]) !== sorted(lock.packages[""][field])) {
      throw new Error(`package.json ${field} 与锁文件不一致`);
    }
  }
  const digest = createHash("sha256").update(lockText).digest("hex");
  const marker = join(directory, "node_modules/.raylink-production-lock");
  const bundled = await readFile(marker, "utf8").catch(() => "");
  if (forceInstall || bundled.trim() !== digest) {
    const result = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: directory, stdio: "inherit", timeout: 300_000,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}` }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ci 失败（${result.status ?? result.signal}）`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev) continue;
    if (!path.startsWith("node_modules/") || path.split("/").includes("..") || entry.link) {
      throw new Error(`生产依赖路径不受支持：${path}`);
    }
    const installed = await readFile(join(directory, path, "package.json"), "utf8").catch((error) => {
      if (entry.optional && error.code === "ENOENT") return null;
      throw error;
    });
    if (installed && JSON.parse(installed).version !== entry.version) {
      throw new Error(`生产依赖版本与锁文件不一致：${path}`);
    }
  }
  // Import the actual control-plane graph before any service stop/switch. This
  // checks package exports and transitive ESM imports, not just JS syntax.
  if (await stat(join(directory, "server/app.js")).catch(() => null)) {
    await import(pathToFileURL(join(directory, "server/app.js")));
  }
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, `${digest}\n`, { mode: 0o644 });
} catch (error) {
  process.stderr.write(`RayLink 生产依赖检查失败：${error.message}\n`);
  process.exitCode = 1;
}
