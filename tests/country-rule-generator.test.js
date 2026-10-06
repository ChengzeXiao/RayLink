import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

const generator = new URL("../server/routing/rule-sets/generate-country.py", import.meta.url).pathname;
const binary = process.env.SING_BOX_BIN || "sing-box";
const nativeAvailable = spawnSync(binary, ["version"], { encoding: "utf8" }).status === 0;
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const csv = "8.140.0.0,8.140.0.255,CN\n8.140.1.0,8.140.1.255,SG\n8.140.2.0,8.140.2.255,CN\n2400:3200::,2400:3200::3,CN\n";

async function fixture(t, text = csv, change = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-country-generator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from(text);
  const compressed = gzipSync(payload);
  const source = {
    format: "dbip-country-lite-csv-gzip", selection: "country=CN",
    url: "https://download.db-ip.com/free/dbip-country-lite-2026-10.csv.gz",
    sha256: hash(compressed), bytes: compressed.length,
    uncompressedSha256: hash(payload), uncompressedBytes: payload.length,
    upstreamSha1: hash(payload, "sha1"), records: text.trim().split("\n").length,
    validationCases: [{ ip: "8.140.0.10", domestic: true }, { ip: "8.140.1.10", domestic: false }]
  };
  change(source);
  await writeFile(join(directory, "source.json"), JSON.stringify(source));
  await writeFile(join(directory, "source.csv.gz"), compressed);
  await writeFile(join(directory, "baseline.json"), JSON.stringify({ version: 3, rules: [{ ip_cidr: ["8.140.0.0/23"] }] }));
  return {
    directory,
    run: (name = "result") => spawnSync("python3", [generator, join(directory, "source.json"), join(directory, "source.csv.gz"), join(directory, name), "--baseline", join(directory, "baseline.json"), "--sing-box", binary], { encoding: "utf8", timeout: 60_000 })
  };
}

test("country generator preserves foreign holes and emits deterministic native IPv4 and IPv6 classification", { skip: !nativeAvailable }, async (t) => {
  const candidate = await fixture(t);
  const first = candidate.run();
  assert.equal(first.status, 0, first.stderr);
  const second = candidate.run("repeat");
  assert.equal(second.status, 0, second.stderr);
  for (const name of ["geoip-cn.json", "geoip-cn.srs", "country-review.json"]) {
    assert.deepEqual(await readFile(join(candidate.directory, "result", name)), await readFile(join(candidate.directory, "repeat", name)), name);
  }
  const decoded = JSON.parse(await readFile(join(candidate.directory, "result", "geoip-cn.json"), "utf8"));
  assert.deepEqual(decoded.rules[0].ip_cidr, ["8.140.0.0/24", "8.140.2.0/24", "2400:3200::/126"]);
  const review = JSON.parse(await readFile(join(candidate.directory, "result", "country-review.json"), "utf8"));
  assert.deepEqual(review.difference.ipv4.added.cidrs, ["8.140.2.0/24"]);
  assert.deepEqual(review.difference.ipv4.removed.cidrs, ["8.140.1.0/24"]);
  assert.equal(review.difference.ipv4.added.addressCount, "256");
  assert.deepEqual(review.difference.ipv6.added.cidrs, ["2400:3200::/126"]);
  const overwrite = candidate.run();
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /existing baseline is never overwritten/);
});

test("country generator rejects altered source bytes before producing a candidate", async (t) => {
  const candidate = await fixture(t, csv, (source) => { source.sha256 = "0".repeat(64); });
  const result = candidate.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Approved source checksum or length mismatch/);
});

test("country generator rejects registration semantics even when source bytes are approved", async (t) => {
  const candidate = await fixture(t, csv, (source) => { source.selection = "registered_country=CN"; });
  const result = candidate.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported or unpinned country source/);
});

test("country generator refuses overlapping country assignments rather than widening domestic coverage", async (t) => {
  const candidate = await fixture(t, "8.140.0.0,8.140.1.255,CN\n8.140.1.0,8.140.1.255,SG\n");
  const result = candidate.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsorted or overlapping country range/);
});

test("country generator refuses incomplete and incorrectly classified approved candidates", async (t) => {
  const incomplete = await fixture(t, csv, (source) => { source.records += 1; });
  const incompleteResult = incomplete.run();
  assert.notEqual(incompleteResult.status, 0);
  assert.match(incompleteResult.stderr, /Incomplete country source/);
  const incorrect = await fixture(t, csv, (source) => { source.validationCases[1].domestic = true; });
  const incorrectResult = incorrect.run();
  assert.notEqual(incorrectResult.status, 0);
  assert.match(incorrectResult.stderr, /Country regression failed: 8.140.1.10/);
});
