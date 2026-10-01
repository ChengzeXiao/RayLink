// Maintainer command: node server/routing/rule-sets/update.mjs APPROVED_MANIFEST NEW_OUTPUT_DIR
// The supplied local manifest must already pin upstream commits and reviewed SHA-256 values.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { validateRuleSetManifest, validRuleSet } from "../../singbox/rule-set-cache.js";

const run = promisify(execFile);
const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error("Usage: update.mjs APPROVED_MANIFEST NEW_OUTPUT_DIR");
const manifest = validateRuleSetManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const output = resolve(outputPath);
if (await stat(output).catch(() => null)) throw new Error("Output must be a new directory; existing baseline is never overwritten");
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(dirname(output), ".raylink-rules-"));
const binary = process.env.SING_BOX_BIN || "sing-box";
try {
  for (const source of manifest.rules) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${source.filename}: HTTP ${response.status}`);
    const payload = Buffer.from(await response.arrayBuffer());
    if (!validRuleSet(payload, source)) throw new Error(`${source.filename}: approved checksum mismatch`);
    const binaryPath = join(staging, source.filename);
    await writeFile(binaryPath, payload);
    source.jsonFilename = source.filename.replace(/\.srs$/, ".json");
    const jsonPath = join(staging, source.jsonFilename);
    await run(binary, ["rule-set", "decompile", binaryPath, "-o", jsonPath], { timeout: 30_000 });
    const decoded = JSON.parse(await readFile(jsonPath, "utf8"));
    if (!Array.isArray(decoded.rules) || !decoded.rules.length) throw new Error("Empty decoded rule set");
    const compact = `${JSON.stringify(decoded)}\n`;
    await writeFile(jsonPath, compact);
    source.jsonSha256 = createHash("sha256").update(compact).digest("hex");
    source.statistics = Object.fromEntries(["domain", "domain_suffix", "domain_keyword", "domain_regex", "ip_cidr"]
      .map((key) => [key, decoded.rules.reduce((count, rule) => count + (rule[key]?.length || 0), 0)])
      .filter(([, count]) => count));
    const cases = source.filename.startsWith("geoip-")
      ? [["114.114.114.114", true], ["8.8.8.8", false]]
      : [["baidu.com", true], ["qq.com", true], ["example.invalid", false]];
    for (const [value, expected] of cases) {
      const { stdout, stderr } = await run(binary, ["rule-set", "match", "-f", "binary", binaryPath, value]);
      if (`${stdout}${stderr}`.trim().startsWith("match ") !== expected) throw new Error(`${source.filename}: behavior check failed: ${value}`);
    }
    // Recompile the exact JSON shipped for inline generation and verify it with the kernel.
    const rebuilt = join(staging, `${source.filename}.check`);
    await run(binary, ["rule-set", "compile", jsonPath, "-o", rebuilt], { timeout: 30_000 });
    if (!(await readFile(rebuilt)).equals(payload)) throw new Error(`${source.filename}: binary/inline round trip differs`);
    await rm(rebuilt);
  }
  for (const name of ["LICENSE.sing-geosite", "LICENSE.sing-geoip", "COPYING", "README.md"]) {
    await copyFile(new URL(name, import.meta.url), join(staging, name));
  }
  await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(staging, output);
  console.log(`Validated ${manifest.version}: ${output}. Review and commit the manifest, SRS and JSON together.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
