import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);

test("release archive carries locked production dependencies and boots its module graph offline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-package-deps-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "source");
  for (const path of ["deploy", "server", "web/node/runtime", "docs", "dependency"])
    await mkdir(join(root, path), { recursive: true });
  for (const file of ["package-release.sh", "generate-release-metadata.mjs", "prepare-runtime-dependencies.mjs"]) {
    await cp(new URL(`../deploy/${file}`, import.meta.url), join(root, "deploy", file)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await writeFile(join(root, "dependency/package.json"), JSON.stringify({ name: "release-fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
  await writeFile(join(root, "dependency/index.js"), 'export const value = "locked-runtime-dependency";\n');
  await execFile("npm", ["pack", "--pack-destination", "../deploy", "--ignore-scripts", "--offline"], { cwd: join(root, "dependency") });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "raylink-control-plane", version: "1.0.0", type: "module",
    dependencies: { "release-fixture-dependency": "file:deploy/release-fixture-dependency-1.0.0.tgz" },
    devDependencies: { "dev-only-fixture": "file:deploy/release-fixture-dependency-1.0.0.tgz" }
  }));
  await execFile("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline"], { cwd: root });
  await writeFile(join(root, "server/app.js"), 'import { value } from "release-fixture-dependency"; if (value !== "locked-runtime-dependency") throw new Error("bad dependency"); export { value };\n');
  for (const file of ["README.md", "CHANGELOG.md", "docs/production-readiness-plan.md", "docs/mcp-server.md"]) await writeFile(join(root, file), "fixture\n");
  for (const filename of ["raylink-sing-box-1.14.2-linux-amd64", "raylink-libcronet-1.14.2-linux-amd64.so"]) {
    const contents = Buffer.from("approved-runtime-fixture");
    await writeFile(join(root, "web/node/runtime", filename), contents);
    await writeFile(join(root, "web/node/runtime", `${filename}.sha256`), `${createHash("sha256").update(contents).digest("hex")}  ${filename}\n`);
  }
  await execFile("git", ["init", "-q"], { cwd: root });
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "package fixture"], { cwd: root });
  const archive = join(directory, "raylink-1.0.0-linux-amd64.tar.gz");
  await execFile("bash", [join(root, "deploy/package-release.sh"), "1.0.0", archive], { cwd: root });
  const sbom = JSON.parse(await readFile(join(directory, "raylink-1.0.0-linux-amd64.spdx.json")));
  const shippedDependency = sbom.packages.find((entry) => entry.name === "release-fixture-dependency");
  assert.equal(shippedDependency?.versionInfo, "1.0.0", "SBOM must inventory shipped npm dependencies");
  assert.equal(sbom.packages.filter((entry) => entry.SPDXID.startsWith("SPDXRef-npm-")).length, 1);
  assert.ok(sbom.relationships.some((entry) => entry.relationshipType === "CONTAINS" && entry.relatedSpdxElement === shippedDependency.SPDXID));
  const extracted = join(directory, "extracted");
  await mkdir(extracted);
  await execFile("tar", ["-xzf", archive, "-C", extracted]);
  const released = join(extracted, "raylink-1.0.0");
  await assert.rejects(readFile(join(released, "node_modules/dev-only-fixture/package.json")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(join(released, "package-lock.json"))), JSON.parse(await readFile(join(root, "package-lock.json"))));
  await rm(join(released, "deploy/release-fixture-dependency-1.0.0.tgz"));
  await execFile(process.execPath, [join(released, "deploy/prepare-runtime-dependencies.mjs"), released], {
    env: { ...process.env, npm_config_offline: "true", npm_config_cache: join(directory, "empty-cache") }
  });
  await execFile(process.execPath, [join(released, "server/app.js")], { env: { ...process.env, npm_config_offline: "true" } });
  const dependencyManifest = join(released, "node_modules/release-fixture-dependency/package.json");
  const dependency = JSON.parse(await readFile(dependencyManifest, "utf8"));
  await writeFile(dependencyManifest, JSON.stringify({ ...dependency, version: "9.0.0" }));
  await assert.rejects(execFile(process.execPath, [join(released, "deploy/prepare-runtime-dependencies.mjs"), released]),
    (error) => /生产依赖版本与锁文件不一致/.test(error.stderr));
});
