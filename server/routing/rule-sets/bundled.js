import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url)));
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function load(filename) {
  const source = manifest.rules.find((rule) => rule.filename === filename);
  if (!source || source.jsonFilename !== filename.replace(/\.srs$/, ".json")) throw new Error("Invalid bundled rule-set manifest");
  const bytes = readFileSync(new URL(source.jsonFilename, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== source.jsonSha256) throw new Error(`Bundled rule-set checksum mismatch: ${filename}`);
  const decoded = JSON.parse(bytes);
  if (!Array.isArray(decoded.rules) || !decoded.rules.length) throw new Error(`Empty bundled rule set: ${filename}`);
  return freeze(decoded.rules);
}
const rules = Object.freeze({ geosite: load("geosite-geolocation-cn.srs"), geoip: load("geoip-cn.srs") });
// Parse and verify once, never spawn a process while generating subscriptions.
export function getBundledRoutingRules() { return rules; }
export function getBundledRoutingVersion() { return manifest.version; }
