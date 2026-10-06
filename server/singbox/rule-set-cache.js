import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readApprovedRuleSetResponse } from "../routing/rule-sets/approved-response.js";

const execFile = promisify(execFileCallback);
const bundledDirectory = fileURLToPath(new URL("../routing/rule-sets/", import.meta.url));
const filenames = ["geosite-geolocation-cn.srs", "geoip-cn.srs"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function approvedSource(rule) {
  if (rule.delivery === "bundled") {
    const source = rule.source;
    return rule.filename === "geoip-cn.srs" && rule.url === undefined
      && source?.format === "dbip-country-lite-csv-gzip" && source.selection === "country=CN"
      && /^https:\/\/download\.db-ip\.com\/free\/dbip-country-lite-\d{4}-(?:0[1-9]|1[0-2])\.csv\.gz$/.test(source.url)
      && /^[a-f0-9]{64}$/.test(source.sha256)
      && Number.isSafeInteger(source.bytes) && source.bytes > 32 && source.bytes <= 32 * 1024 * 1024;
  }
  return rule.delivery === undefined
    && /^https:\/\/raw\.githubusercontent\.com\/SagerNet\/sing-(?:geoip|geosite)\/[a-f0-9]{40}\/[a-z-]+\.srs$/.test(rule.url);
}

export function validateRuleSetManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !/^[a-zA-Z0-9._-]{1,100}$/.test(manifest.version || "")
    || !Number.isFinite(Date.parse(manifest.publishedAt)) || manifest.rules?.length !== filenames.length) {
    throw new Error("Invalid rule-set manifest");
  }
  for (const filename of filenames) {
    const entries = manifest.rules.filter((entry) => entry.filename === filename);
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256)
      || !Number.isSafeInteger(entries[0].bytes) || entries[0].bytes <= 32
      || entries[0].bytes > 16 * 1024 * 1024
      || !approvedSource(entries[0])) {
      throw new Error(`Invalid approved rule-set source: ${filename}`);
    }
  }
  return manifest;
}
export function validRuleSet(payload, source) {
  return payload.length === source.bytes && payload.subarray(0, 3).toString("ascii") === "SRS"
    && digest(payload) === source.sha256;
}
async function readManifest(path) {
  return validateRuleSetManifest(JSON.parse(await readFile(path, "utf8")));
}
function identity(manifest) { return digest(JSON.stringify(manifest)); }

export class ManagedRuleSetCache {
  constructor({ dataDir, fetchImpl = globalThis.fetch, requestTimeoutMs = 10_000,
    bundleDir = bundledDirectory, manifestPath = join(bundleDir, "manifest.json") }) {
    this.cacheDir = join(dataDir, "rule-sets");
    this.bundleDir = bundleDir;
    this.manifestPath = manifestPath;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.active = null;
    this.preparing = null;
    this.desired = null;
    this.lastError = null;
    this.checkedAt = null;
  }
  available() { return Boolean(this.active); }
  status() {
    return { available: this.available(), version: this.active?.manifest.version || null,
      desiredVersion: this.desired?.version || null, source: this.active?.source || null,
      publishedAt: this.active?.manifest.publishedAt || null, checkedAt: this.checkedAt,
      degraded: Boolean(this.lastError) || !this.available(), lastError: this.lastError,
      files: this.active?.manifest.rules.map((rule) => ({ ...rule })) || [] };
  }
  async prepare() {
    if (this.preparing) return this.preparing;
    this.preparing = this.refresh().finally(() => { this.preparing = null; });
    return this.preparing;
  }
  async readSet(directory, manifest) {
    const payloads = new Map();
    for (const rule of manifest.rules) {
      const payload = await readFile(join(directory, rule.filename));
      if (!validRuleSet(payload, rule)) throw new Error(`Rule-set checksum mismatch: ${rule.filename}`);
      payloads.set(rule.filename, payload);
    }
    return payloads;
  }
  async activate(manifest, payloads, source) {
    const id = identity(manifest);
    const releases = join(this.cacheDir, "releases");
    await mkdir(releases, { recursive: true, mode: 0o700 });
    const temporary = join(releases, `.candidate-${randomUUID()}`);
    // Unique immutable generation; corrupt generations are never rewritten in place.
    const generation = `${id}-${randomUUID()}`;
    const directory = join(releases, generation);
    await mkdir(temporary, { mode: 0o700 });
    const pointer = join(this.cacheDir, `.active-${randomUUID()}.tmp`);
    try {
      for (const rule of manifest.rules) await writeFile(join(temporary, rule.filename), payloads.get(rule.filename), { mode: 0o600 });
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      await rename(temporary, directory);
      await writeFile(pointer, JSON.stringify({ generation, source, previous: this.active ? basename(this.active.directory) : null }), { mode: 0o600 });
      await rename(pointer, join(this.cacheDir, "active.json"));
      this.active = { directory, manifest, source };
    } finally {
      await rm(temporary, { force: true, recursive: true });
      await rm(pointer, { force: true });
    }
  }
  async restore() {
    const pointer = JSON.parse(await readFile(join(this.cacheDir, "active.json"), "utf8"));
    for (const generation of [pointer.generation, pointer.previous]) {
      if (!/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(generation || "")) continue;
      try {
        const directory = join(this.cacheDir, "releases", generation);
        const manifest = await readManifest(join(directory, "manifest.json"));
        if (!generation.startsWith(`${identity(manifest)}-`)) continue;
        await this.readSet(directory, manifest);
        this.active = { directory, manifest, source: "cache" };
        return;
      } catch (error) {
        this.lastError = error.message;
        // Try the last complete generation before the bundled baseline.
      }
    }
  }
  async refresh() {
    this.checkedAt = new Date().toISOString();
    this.lastError = null;
    try {
      if (!this.active) await this.restore().catch(() => {});
      try { this.desired = await readManifest(this.manifestPath); }
      catch (error) { this.desired = null; this.lastError = error.message; }
      if (this.active) {
        try { await this.readSet(this.active.directory, this.active.manifest); }
        catch (error) {
          this.lastError = error.message;
          this.active = null;
          await this.restore().catch(() => {});
        }
      }
      if (!this.active) {
        const manifest = await readManifest(join(this.bundleDir, "manifest.json"));
        await this.activate(manifest, await this.readSet(this.bundleDir, manifest), "bundled");
      }
      // Immutable approved hashes never need a periodic re-download.
      if (!this.desired || identity(this.active.manifest) === identity(this.desired)) return;
      // An application update may already contain the new approved generation.
      // Prefer its verified bytes even when a previous cache is still valid.
      const bundledCandidate = await this.readSet(this.bundleDir, this.desired).catch(() => null);
      if (bundledCandidate) {
        await this.activate(this.desired, bundledCandidate, "bundled");
        return;
      }
      const payloads = new Map();
      for (const rule of this.desired.rules) {
        const existing = this.active.manifest.rules.find((entry) => entry.filename === rule.filename);
        let payload;
        if (existing.sha256 === rule.sha256 && existing.bytes === rule.bytes) {
          payload = await readFile(join(this.active.directory, rule.filename));
        } else {
          // Source CSV is maintainer input, never a downloadable SRS artifact.
          if (rule.delivery === "bundled") throw new Error(`${rule.filename} requires the reviewed application bundle`);
          const response = await this.fetchImpl(rule.url, {
            signal: AbortSignal.timeout(this.requestTimeoutMs),
            headers: { "user-agent": "RayLink rule-set cache" }
          });
          payload = await readApprovedRuleSetResponse(response, rule.bytes);
        }
        if (!validRuleSet(payload, rule)) throw new Error(`Rule-set checksum mismatch: ${rule.filename}`);
        payloads.set(rule.filename, payload);
      }
      await this.activate(this.desired, payloads, "download");
    } catch (error) {
      this.lastError = error.message;
    }
  }
  async get(filename) {
    if (!filenames.includes(filename) || !this.active) return null;
    const rule = this.active.manifest.rules.find((entry) => entry.filename === filename);
    const payload = await readFile(join(this.active.directory, filename)).catch(() => null);
    if (payload && validRuleSet(payload, rule)) return payload;
    await this.prepare();
    if (!this.active) return null;
    const recovered = await readFile(join(this.active.directory, filename)).catch(() => null);
    const approved = this.active.manifest.rules.find((entry) => entry.filename === filename);
    return recovered && validRuleSet(recovered, approved) ? recovered : null;
  }
  async matches(filename, value, binaryPath = "sing-box") {
    if (!filenames.includes(filename)) return false;
    if (!await this.get(filename)) return null;
    try {
      const { stdout, stderr } = await execFile(binaryPath,
        ["rule-set", "match", "-f", "binary", join(this.active.directory, filename), String(value)],
        { timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true });
      return `${stdout}${stderr}`.trim().startsWith("match ");
    } catch { return null; }
  }
}
