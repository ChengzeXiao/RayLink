import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRayLinkApp } from "../server/app.js";
import { hashSessionSecret } from "../server/security.js";

test("self-signed IP setup exports complete subscriptions without remote rule-set trust requirements", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-subscription-trust-"));
  const token = "subscription-trust-setup-token";
  const app = await createRayLinkApp({
    dataDir,
    adminUsername: "admin",
    adminPassword: "Subscription-trust-admin-2026!",
    publicOrigin: "https://127.0.0.1",
    proxyHost: "127.0.0.1",
    trustProxy: true,
    runtimeMode: "dry-run",
    singBoxBinary: join(dataDir, "uninstalled-runtime"),
    seedDemoData: false,
    setupRequired: true,
    setupTokenHash: hashSessionSecret(token),
    setupTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    protocolProbeUrl: "http://127.0.0.1:1/probe",
    runtimeUpdateCheckIntervalMs: 0,
    backupIntervalMs: 0,
    alertIntervalMs: 0
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const publicOrigin = baseUrl.replace("http:", "https:");
  const request = (path, { cookie, body, method = "GET" } = {}) => fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-forwarded-proto": "https",
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const setup = await request("/api/setup/complete", { method: "POST", body: {
    token,
    access: { mode: "ip", canonicalOrigin: publicOrigin, allowedOrigins: [publicOrigin] },
    certificate: { mode: "ip-self-signed" },
    admin: { username: "admin", password: "Subscription-trust-admin-2026!" },
    runtime: { name: "Loopback test Host", address: "127.0.0.1", region: "test" }
  } });
  assert.equal(setup.status, 201, await setup.text());
  const cookie = setup.headers.getSetCookie()[0].split(";")[0];
  const created = await request("/api/users", { method: "POST", cookie, body: {
    name: "Subscription trust user", email: "trust@example.test", password: "subscription-trust-user-password",
    quotaGb: 100, nodeScope: ["all"], clientFormats: ["sing-box", "mihomo", "loon", "egern"],
    state: "active", portalStatus: "active", expiresAt: "2030-12-31"
  } });
  const user = await created.json();
  assert.equal(created.status, 201, JSON.stringify(user));
  const published = await request("/api/deployments", { method: "POST", cookie });
  assert.equal(published.status, 201, await published.text());
  const rotation = await request(`/api/users/${user.id}/subscription/rotate`, { method: "POST", cookie });
  assert.equal(rotation.status, 201);
  const { subscriptionUrl } = await rotation.json();
  const subscriptionPath = new URL(subscriptionUrl).pathname;
  const response = await request(`${subscriptionPath}?format=singbox`);
  const config = await response.json();
  assert.equal(response.status, 200, JSON.stringify(config));
  assert.equal(config.route.rule_set.length, 2);
  assert.ok(config.route.rule_set.every((rule) => rule.type === "inline" && rule.rules.length > 0),
    "a new client must not fetch rules from an untrusted self-signed HTTPS endpoint");
  const rules = JSON.stringify(config.route.rule_set);
  assert.match(rules, /a1\.mzstatic\.com/);
  assert.match(rules, /1\.0\.1\.0\/24/);
  assert.doesNotMatch(JSON.stringify(config), /"insecure":true/);

  for (const format of ["mihomo", "egern-profile", "egern", "loon"]) {
    const artifact = await request(`${subscriptionPath}?format=${format}`);
    assert.equal(artifact.status, 200, format);
    assert.doesNotMatch(await artifact.text(), /https:\/\/127\.0\.0\.1(?::\d+)?\/rule-sets\//, format);
  }

  // Optional real-kernel acceptance. Only listeners/cache location are changed;
  // preserve all generated DNS, outbounds and rules. Targets remain loopback.
  if (process.env.SING_BOX_BIN) {
    config.inbounds = [];
    config.experimental.cache_file.path = join(dataDir, "cold-client.db");
    const path = join(dataDir, "client.json");
    await writeFile(path, JSON.stringify(config));
    const child = spawn(process.env.SING_BOX_BIN, ["run", "-c", path], {
      cwd: dataDir, stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = once(child, "exit");
    let timer;
    try {
      const earlyExit = await Promise.race([
        exited,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 700); })
      ]);
      assert.equal(earlyExit, null, stderr);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    }
  }
});
