import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../server/config.js";

test("operators can select a separately reviewed local rule-set manifest", () => {
  assert.equal(loadConfig({}).ruleSetManifestPath, null);
  assert.equal(loadConfig({ RAYLINK_RULE_SET_MANIFEST: "./approved-routing/manifest.json" }).ruleSetManifestPath,
    resolve("./approved-routing/manifest.json"));
});
