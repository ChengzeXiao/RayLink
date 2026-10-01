import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RayLinkStore } from "../server/database.js";
import { RuntimeManager } from "../server/singbox/runtime-manager.js";
import { RuntimeSetupManager } from "../server/runtime-setup.js";

test("a local development console refuses real Runtime setup before installing packages", async () => {
  let attempted = false;
  const manager = new RuntimeSetupManager({
    runtimeMode: "dry-run", platform: "darwin",
    installer: { install: async () => { attempted = true; } }
  });
  await assert.rejects(manager.configure(), { code: "RUNTIME_AUTOMATION_UNSUPPORTED", statusCode: 422 });
  assert.equal(attempted, false);
  assert.equal(manager.status().status, "development");
  assert.equal(manager.status().ready, false);
});

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-runtime-setup-"));
  const store = new RayLinkStore({
    dbPath: join(directory, "raylink.db"), seedDemoData: false,
    adminUsername: "admin", adminPassword: "fixture-password",
    initialHostAddress: "192.0.2.10"
  });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const installation = {
    installed: true, version: "1.14.2", platform: "linux",
    binaryPath: "/usr/local/bin/raylink-sing-box", tags: ["with_v2ray_api"]
  };
  const calls = [];
  let installed = false;
  let active = false;
  const configs = [];
  const adapter = {
    mode: "systemd", binaryPath: "sing-box",
    status: async () => ({ mode: "systemd", state: active ? "running" : "stopped" }),
    publish: async ({ configText }) => {
      assert.equal(installed, true, "a missing binary must be installed before publication");
      if (overrides.publishError) throw overrides.publishError;
      configs.push(JSON.parse(configText));
      active = !overrides.stopped;
      return { mode: "systemd", validation: "sing-box" };
    }
  };
  const manager = new RuntimeSetupManager({
    platform: "linux", runtimeMode: "systemd", store, runtimeAdapter: adapter,
    runtimeManager: new RuntimeManager({ store, adapter }),
    installer: {
      status: async () => installed ? installation : { installed: false },
      install: async () => { installed = true; calls.push("install"); return installation; }
    },
    bbrManager: { configure: async () => {
      calls.push("bbr");
      if (overrides.bbrError) throw overrides.bbrError;
      return { status: "enabled", congestionControl: "bbr", qdisc: "fq" };
    }, inspect: async () => ({ status: "unsupported" }) },
    firewallManager: { open: async (rule) => {
      calls.push(["firewall", rule]);
      return { managed: true, rollback: async () => calls.push(["rollback", rule]) };
    } },
    portManager: { waitForListening: async (endpoint) => {
      const inbound = configs.at(-1).inbounds.find((entry) => entry.listen_port === endpoint.port);
      if (inbound.network && inbound.network !== endpoint.network) throw new Error(`Runtime 未配置 ${endpoint.network} 监听`);
      calls.push(["listening", endpoint]);
    } }
  });
  return { manager, store, adapter, calls, configs };
}

test("automatic setup installs, publishes the default Shadowsocks configuration, and verifies its configured listener", async (t) => {
  const { manager, store, adapter, calls, configs } = await fixture(t);
  const original = store.listHostProtocolConfigs("local").find((entry) => entry.type === "shadowsocks");
  const result = await manager.configure();
  assert.equal(result.ready, true);
  assert.equal(result.installed, true);
  assert.equal(result.runtime.state, "running");
  assert.equal(result.bbr.status, "enabled");
  assert.equal(adapter.binaryPath, "/usr/local/bin/raylink-sing-box");
  assert.equal(configs[0].inbounds[0].type, "shadowsocks");
  assert.equal(configs[0].inbounds[0].listen_port, original.port);
  assert.deepEqual(calls.filter((entry) => entry[0] === "firewall").map((entry) => entry[1].network), ["tcp"]);
  assert.deepEqual(calls.filter((entry) => entry[0] === "listening").map((entry) => entry[1].network), ["tcp"]);
  assert.equal(store.listDeployments()[0].status, "active");
  const activation = store.getHost("local").protocolActivations.find((entry) => entry.type === "shadowsocks");
  assert.equal(activation?.state, "port-listening");
  assert.equal(activation.publicCheck.reachable, null, "local readiness must not claim external reachability");
  assert.equal(manager.status().status, "succeeded");
  assert.ok(manager.status().steps.every((step) => step.status === "succeeded"));
});

test("setup retries retain existing protocol ports, user keys, and configured transport options", async (t) => {
  const { manager, store, configs } = await fixture(t);
  const previous = store.listHostProtocolConfigs("local").find((entry) => entry.type === "shadowsocks");
  store.updateHostProtocolConfig("local", "shadowsocks", { ...previous, enabled: false, port: 48388 });
  const first = await manager.configure();
  const password = configs[0].inbounds[0].password;
  const second = await manager.configure();
  assert.equal(first.defaultProtocol.port, 48388);
  assert.equal(second.defaultProtocol.port, 48388);
  assert.equal(configs[1].inbounds[0].password, password);
  assert.deepEqual(configs[1].inbounds, configs[0].inbounds);
  assert.equal(store.listHostProtocolConfigs("local").find((entry) => entry.type === "shadowsocks").enabled, true);
});

test("unsupported BBR leaves the proxy usable and reports a warning instead of claiming acceleration", async (t) => {
  const { manager } = await fixture(t, { bbrError: new Error("当前内核不支持 BBR") });
  const result = await manager.configure();
  assert.equal(result.ready, true);
  assert.equal(result.runtime.state, "running");
  assert.equal(result.bbr.status, "unsupported");
  assert.deepEqual(result.warnings, ["当前内核不支持 BBR"]);
  assert.equal(manager.status().steps.find((step) => step.id === "bbr").status, "warning");
});

test("an inactive service cannot produce a successful installation result", async (t) => {
  const { manager } = await fixture(t, { stopped: true });
  await assert.rejects(manager.configure(), { code: "RUNTIME_NOT_RUNNING" });
  assert.equal(manager.status().status, "failed");
  assert.equal(manager.status().ready, false);
  assert.equal(manager.status().stage, "health");
});

test("failed configuration publication restores disabled protocol settings and newly opened firewall rules", async (t) => {
  const { manager, store, calls } = await fixture(t, { publishError: new Error("配置校验失败") });
  const original = store.listHostProtocolConfigs("local").find((entry) => entry.type === "shadowsocks");
  store.updateHostProtocolConfig("local", "shadowsocks", { ...original, enabled: false });
  await assert.rejects(manager.configure(), /配置校验失败/);
  assert.equal(store.listHostProtocolConfigs("local").find((entry) => entry.type === "shadowsocks").enabled, false);
  assert.equal(calls.filter((entry) => entry[0] === "rollback").length, 1);
  assert.equal(store.listDeployments()[0].status, "failed");
  assert.equal(manager.status().stage, "publish");
});

test("a running non-metered Runtime goes through the upgrade rollback path before applying setup", async (t) => {
  const { manager } = await fixture(t);
  const methods = [];
  manager.installer = {
    status: async () => ({ installed: true, version: "1.14.2", tags: [], platform: "linux" }),
    install: async () => { methods.push("unsafe-install"); throw new Error("must not replace a live binary directly"); },
    upgrade: async (version) => { methods.push(["safe-upgrade", version]); throw new Error("rollback retained current service"); }
  };
  manager.runtimeManager = { status: async () => ({ mode: "systemd", state: "running" }) };
  await assert.rejects(manager.configure(), /rollback retained current service/);
  assert.deepEqual(methods, [["safe-upgrade", "1.14.2"]]);
});

test("a second setup cannot race package installation or reset progress", async (t) => {
  const { manager } = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const install = manager.installer.install;
  manager.installer.install = async () => { await gate; return install(); };
  const first = manager.configure();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.status().status, "running");
  await assert.rejects(manager.configure(), { code: "RUNTIME_OPERATION_IN_PROGRESS" });
  assert.equal(manager.status().stage, "install");
  release();
  assert.equal((await first).ready, true);
});

test("setup progress survives restarts and interrupted installation remains retryable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-runtime-progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "runtime-setup.json");
  const { manager } = await fixture(t);
  manager.statePath = statePath;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const install = manager.installer.install;
  manager.installer.install = async () => { await gate; return install(); };
  const operation = manager.configure();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).stage, "install");
  const restarted = new RuntimeSetupManager({ platform: "linux", runtimeMode: "systemd", statePath });
  assert.equal(restarted.status().status, "failed");
  assert.equal(restarted.status().ready, false);
  assert.equal(restarted.status().error.code, "RUNTIME_SETUP_INTERRUPTED");
  release();
  await operation;
  const completed = new RuntimeSetupManager({ platform: "linux", runtimeMode: "systemd", statePath });
  assert.equal(completed.status().status, "succeeded");
  assert.equal(completed.status().stage, "health");
});
