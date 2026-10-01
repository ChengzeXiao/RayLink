import { join } from "node:path";
import { createRayLinkApp } from "../../server/app.js";
import { LocalSingBoxAdapter } from "../../server/singbox/local-adapter.js";

const dataDir = process.argv[2];
const adapter = new LocalSingBoxAdapter({
  dataDir, binaryPath: join(dataDir, "absent-sing-box"), mode: "dry-run"
});
let gateNextPublication = false;
let releasePublication;
// The gate is at the public Runtime adapter boundary, after the user workflow
// has saved its entitlement. Validation and file publication still use the real
// dry-run adapter. No journal or application database internals are inspected.
const runtimeAdapter = {
  activePath: adapter.activePath,
  status: () => adapter.status(),
  async publish(candidate) {
    if (gateNextPublication) {
      gateNextPublication = false;
      await new Promise((resolve) => {
        releasePublication = resolve;
        process.send({ type: "publication-blocked" });
      });
    }
    return adapter.publish(candidate);
  }
};

const app = await createRayLinkApp({
  dataDir, adminUsername: "admin", adminPassword: "test-password",
  publicOrigin: "http://127.0.0.1", runtimeAdapter,
  backupIntervalMs: 0, alertIntervalMs: 0, runtimeUpdateCheckIntervalMs: 0,
  entitlementReconcileIntervalMs: 60_000,
  installer: { async status() { return { installed: false, tags: [] }; } },
  ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null }
});
process.on("message", (message) => {
  if (message.type === "gate-next-publication") {
    gateNextPublication = true;
    process.send({ type: "armed" });
  } else if (message.type === "release-publication") {
    releasePublication?.();
    releasePublication = null;
    process.send({ type: "released" });
  }
});
await app.listen({ host: "127.0.0.1", port: 0 });
process.send({ type: "ready", base: `http://127.0.0.1:${app.server.address().port}` });
