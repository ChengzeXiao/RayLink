import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedRuleSetCache } from "../server/singbox/rule-set-cache.js";

const filenames = ["geosite-geolocation-cn.srs", "geoip-cn.srs"];
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "raylink-rules-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("offline cold start serves complete bundled China rule sets without network access", async (t) => {
  let requests = 0;
  const cache = new ManagedRuleSetCache({ dataDir: await directory(t), fetchImpl: async () => {
    requests++; throw new Error("offline");
  } });
  await cache.prepare();
  assert.equal(cache.available(), true);
  for (const name of filenames) assert.ok((await cache.get(name)).length > 30000);
  assert.equal(requests, 0);
  assert.equal(cache.status().source, "bundled");
  assert.equal(cache.status().degraded, false);
});

async function candidate(t) {
  const path = join(await directory(t), "manifest.json");
  const manifest = JSON.parse(await readFile(new URL("../server/routing/rule-sets/manifest.json", import.meta.url)));
  const payloads = new Map();
  for (let i = 0; i < filenames.length; i++) {
    const bytes = await readFile(new URL(`../server/routing/rule-sets/${filenames[1-i]}`, import.meta.url));
    const rule = manifest.rules[i];
    rule.bytes = bytes.length;
    rule.sha256 = createHash("sha256").update(bytes).digest("hex");
    payloads.set(rule.url, bytes);
  }
  manifest.version = "reviewed-test-update";
  await writeFile(path, JSON.stringify(manifest));
  return { path, manifest, payloads };
}
test("a failed candidate keeps the complete previous version and successful update survives restart", async (t) => {
  const dataDir = await directory(t);
  const update = await candidate(t);
  let failSecond = true;
  let requests = 0;
  const options = { dataDir, manifestPath: update.path, fetchImpl: async (url) => {
    requests++;
    if (failSecond && url === update.manifest.rules[1].url) throw new Error("offline");
    return new Response(update.payloads.get(url));
  } };
  const cache = new ManagedRuleSetCache(options);
  await cache.prepare();
  assert.equal(cache.available(), true);
  assert.notEqual(cache.status().version, update.manifest.version);
  assert.equal(cache.status().degraded, true);
  for (const name of filenames) assert.deepEqual(await cache.get(name), await readFile(new URL(`../server/routing/rule-sets/${name}`, import.meta.url)));
  failSecond = false;
  await cache.prepare();
  assert.equal(cache.status().version, update.manifest.version);
  assert.equal(cache.status().degraded, false);
  const previousRequests = requests;
  await cache.prepare();
  const restarted = new ManagedRuleSetCache({ ...options, fetchImpl: async () => { throw new Error("no network"); } });
  await restarted.prepare();
  assert.equal(restarted.status().version, update.manifest.version);
  assert.equal(restarted.status().degraded, false);
  assert.equal(requests, previousRequests);
});

test("corrupted active files recover the bundled baseline instead of serving damaged bytes", async (t) => {
  const dataDir = await directory(t);
  const cache = new ManagedRuleSetCache({ dataDir, fetchImpl: async () => { throw new Error("offline"); } });
  await cache.prepare();
  const pointer = JSON.parse(await readFile(join(dataDir, "rule-sets", "active.json")));
  await writeFile(join(dataDir, "rule-sets", "releases", pointer.generation, filenames[0]), "damaged");
  await cache.prepare();
  assert.equal(cache.available(), true);
  assert.ok((await cache.get(filenames[0]))?.length > 30000);
  assert.equal(cache.status().degraded, true);
  assert.match(cache.status().lastError, /checksum/);
});

test("an invalid maintainer manifest cannot remove the offline baseline", async (t) => {
  const dataDir = await directory(t);
  const manifestPath = join(dataDir, "approved.json");
  await writeFile(manifestPath, '{"schemaVersion":7}');
  const cache = new ManagedRuleSetCache({ dataDir, manifestPath });
  await cache.prepare();
  assert.equal(cache.available(), true);
  assert.equal(cache.status().degraded, true);
  assert.ok((await cache.get(filenames[1])).length > 30000);
});

test("restart rejects a corrupt new generation and retains the last good approved version", async (t) => {
  const dataDir = await directory(t);
  const update = await candidate(t);
  const cache = new ManagedRuleSetCache({ dataDir, manifestPath: update.path,
    fetchImpl: async (url) => new Response(update.payloads.get(url)) });
  await cache.prepare();
  assert.equal(cache.status().version, update.manifest.version);
  const pointer = JSON.parse(await readFile(join(dataDir, "rule-sets", "active.json")));
  await writeFile(join(dataDir, "rule-sets", "releases", pointer.generation, filenames[1]), "corrupt");
  const restarted = new ManagedRuleSetCache({ dataDir, manifestPath: update.path,
    fetchImpl: async () => { throw new Error("upstream unavailable"); } });
  await restarted.prepare();
  assert.equal(restarted.available(), true);
  assert.equal(restarted.status().degraded, true);
  assert.notEqual(restarted.status().version, update.manifest.version);
  assert.deepEqual(await restarted.get(filenames[1]), await readFile(new URL(`../server/routing/rule-sets/${filenames[1]}`, import.meta.url)));
});

test("checksum-rejected candidate never publishes a partial rule set", async (t) => {
  const update = await candidate(t);
  const cache = new ManagedRuleSetCache({ dataDir: await directory(t), manifestPath: update.path,
    fetchImpl: async () => new Response("SRS-unapproved-content") });
  await cache.prepare();
  assert.equal(cache.available(), true);
  assert.notEqual(cache.status().version, update.manifest.version);
  assert.match(cache.status().lastError, /checksum/);
  assert.equal(await cache.get("../../private"), null);
});

test("offline restart reports repairing a corrupt bundled cache generation", async (t) => {
  const dataDir = await directory(t);
  const cache = new ManagedRuleSetCache({ dataDir });
  await cache.prepare();
  const pointer = JSON.parse(await readFile(join(dataDir, "rule-sets", "active.json")));
  await writeFile(join(dataDir, "rule-sets", "releases", pointer.generation, filenames[0]), "damaged");
  const restarted = new ManagedRuleSetCache({ dataDir });
  await restarted.prepare();
  assert.equal(restarted.available(), true);
  assert.equal(restarted.status().degraded, true);
  assert.match(restarted.status().lastError, /checksum/);
});

test("offline application upgrade activates a newer verified local bundle over the old cache", async (t) => {
  const dataDir = await directory(t);
  const previous = new ManagedRuleSetCache({ dataDir });
  await previous.prepare();
  const update = await candidate(t);
  const bundleDir = await directory(t);
  await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(update.manifest));
  for (const rule of update.manifest.rules) await writeFile(join(bundleDir, rule.filename), update.payloads.get(rule.url));
  let requests = 0;
  const upgraded = new ManagedRuleSetCache({ dataDir, bundleDir, fetchImpl: async () => {
    requests++; throw new Error("offline");
  } });
  await upgraded.prepare();
  assert.equal(upgraded.status().version, update.manifest.version);
  assert.equal(upgraded.status().degraded, false);
  assert.equal(requests, 0);
});
