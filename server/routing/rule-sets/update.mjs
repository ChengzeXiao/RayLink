// Maintainer command: node server/routing/rule-sets/update.mjs APPROVED_MANIFEST NEW_OUTPUT_DIR
// The supplied local manifest must already pin upstream commits and reviewed SHA-256 values.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
    const download = source.delivery === "bundled" ? source.source : source;
    const response = await fetch(download.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${source.filename}: HTTP ${response.status}`);
    let payload = Buffer.from(await response.arrayBuffer());
    const binaryPath = join(staging, source.filename);
    if (source.delivery === "bundled") {
      if (payload.length !== download.bytes || createHash("sha256").update(payload).digest("hex") !== download.sha256) {
        throw new Error(`${source.filename}: approved source checksum mismatch`);
      }
      const countryManifest = join(staging, ".country-source.json");
      const compressed = join(staging, ".country.csv.gz");
      const generated = join(staging, ".country-generated");
      await writeFile(countryManifest, JSON.stringify(download));
      await writeFile(compressed, payload);
      await run("python3", [fileURLToPath(new URL("generate-country.py", import.meta.url)),
        countryManifest, compressed, generated, "--sing-box", binary], { timeout: 120_000 });
      payload = await readFile(join(generated, source.filename));
      await copyFile(join(generated, "country-review.json"), join(staging, "country-review.json"));
      for (const path of [countryManifest, compressed, generated]) await rm(path, { recursive: true, force: true });
    }
    if (!validRuleSet(payload, source)) throw new Error(`${source.filename}: approved checksum mismatch`);
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
      ? [["114.114.114.114", true], ["8.141.181.226", true], ["8.142.1.1", true],
        ["2400:3200::1", true], ["8.8.8.8", false], ["1.1.1.1", false],
        ["47.88.0.1", false], ["104.18.32.7", false], ["160.79.104.10", false], ["2606:4700:4700::1111", false]]
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
  for (const name of ["LICENSE.sing-geosite", "LICENSE.sing-geoip", "LICENSE.db-ip", "COPYING", "COPYING.CC-BY-4.0", "README.md", "generate-country.py"]) {
    await copyFile(new URL(name, import.meta.url), join(staging, name));
  }
  const countrySource = manifest.rules.find((rule) => rule.delivery === "bundled")?.source;
  if (countrySource) await writeFile(join(staging, "country-source.json"), `${JSON.stringify(countrySource, null, 2)}\n`);
  await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(staging, output);
  console.log(`Validated ${manifest.version}: ${output}. Review and commit the manifest, SRS and JSON together.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
