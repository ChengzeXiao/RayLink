import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function handler(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) return "";
  const ends = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1)].filter(index => index > start);
  return source.slice(start, Math.min(...ends));
}

const checkedAt = "2026-10-02T08:00:00.000Z";
function host(overrides = {}) {
  return {
    id: "remote-1", kind: "remote", name: "Tokyo", address: "192.0.2.5", region: "tokyo", status: "online",
    lastSeenAt: checkedAt, agentVersion: "0.8.0", enrolledAt: checkedAt, protocols: [],
    telemetry: { updatedAt: checkedAt, serviceStatus: "running", bbr: { status: "enabled", congestionControl: "bbr", qdisc: "fq", checkedAt } },
    ...overrides
  };
}

function hostPage(hosts, options = {}) {
  const target = { innerHTML: "" };
  class Clock extends Date { static now() { return new Date(checkedAt).getTime(); } }
  const context = {
    Date: Clock, Intl, requiredNodeAgentVersion: "0.9.0", location: { origin: "https://panel.example" }, users: [],
    controlPlaneConnection: { generation: 0 }, controlPlane: { currentAdmin: { id: "owner-1", role: "owner" }, hosts, runtime: { state: "running", mode: "systemd", platform: "linux" }, installation: { installed: true }, deployments: [], protocolCatalog: [], ...options },
    elements: { hostBody: target }, renderHostTopology() {},
    document: { querySelector: () => null, querySelectorAll: () => [] },
    icon: name => name, escapeHtml: value => String(value),
    runtimeSetupRequest: { running: false, error: "" }, renderSystemUpdate() {}, protocolHealth: { present: () => ({}) }, userCanUseHost: () => true,
    usageMeteringDescription: () => "等待采集", usageMeteringLabel: () => "待采集", shellQuote: value => value
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("const protocolStatePresentation ="), source.indexOf("\nfunction hostDrawerMarkup(")), context);
  vm.runInContext(["hostBbrPresentation", "hostBbrMarkup", "renderHosts", "hostDrawerMarkup", "versionIsOlder", "nodeVersionSupports", "nodeUpdateMarkup", "runtimeSetupPresentation", "runtimeSetupMarkup", "maintenanceSessionIsCurrent"].map(handler).join("\n"), context);
  return { context, target };
}

test("an applied protocol configuration without runtime evidence never claims a listening port", () => {
  const profile = { type: "shadowsocks", enabled: true, listen: "::", port: 8388, tls: { mode: "none" } };
  const local = host({ id: "local", kind: "local", protocols: [profile], appliedProtocols: [{ ...profile }] });
  for (const runtime of [
    { mode: "dry-run", state: "not-configured", platform: "darwin" },
    { mode: "systemd", state: "running", platform: "linux" }
  ]) {
    const p = hostPage([local], { runtime });
    const markup = p.context.hostDrawerMarkup("local");
    const row = markup.match(/<button[^>]*data-host-protocol="shadowsocks"[\s\S]*?<\/button>/)?.[0];
    assert.ok(row);
    assert.doesNotMatch(row, /端口已监听|公网可用|status-badge good/);
    assert.match(row, runtime.mode === "dry-run" ? /本地测试配置/ : /已配置，待验证/);
  }
});

test("historical successful protocol activation cannot override local test mode or a stopped service", () => {
  const profile = { type: "shadowsocks", enabled: true, listen: "::", port: 8388, tls: { mode: "none" } };
  for (const state of ["port-listening", "public-ready"]) {
    for (const [kind, runtime, label, className] of [
      ["local", { mode: "dry-run", state: "running" }, "本地测试配置", "neutral"],
      ["local", { mode: "systemd", state: "stopped" }, "服务未运行", "warning"],
      ["local", { mode: "systemd", state: "running" }, state === "port-listening" ? "端口已监听" : "公网可用", "good"],
      ["remote", { mode: "dry-run", state: "not-configured" }, state === "port-listening" ? "端口已监听" : "公网可用", "good"]
    ]) {
      const current = host({ kind, protocols: [profile], appliedProtocols: [{ ...profile }], protocolActivations: [{ type: "shadowsocks", state }] });
      const p = hostPage([current], { runtime });
      const markup = p.context.hostDrawerMarkup(current.id);
      const row = markup.match(/<button[^>]*data-host-protocol="shadowsocks"[\s\S]*?<\/button>/)?.[0];
      assert.ok(row);
      assert.match(row, new RegExp(`status-badge ${className}[^>]*><i><\\/i>${label}`));
      if (className !== "good") assert.doesNotMatch(row, /端口已监听|公网可用|status-badge good/);
    }
  }
});

test("host table and details show BBR only from fresh reported kernel evidence", () => {
  const p = hostPage([host()]);
  p.context.renderHosts();
  assert.match(p.target.innerHTML, /BBR 已启用/);
  const detail = p.context.hostDrawerMarkup("remote-1");
  assert.match(detail, /BBR 已启用/);
  assert.match(detail, /bbr.*fq/);
});

test("offline, stale, future and missing BBR evidence never claim current acceleration", () => {
  for (const overrides of [
    { status: "offline" }, { lastSeenAt: "2026-10-02T07:00:00Z" },
    { telemetry: { updatedAt: "2026-10-02T07:00:00Z", bbr: { status: "enabled", congestionControl: "bbr", qdisc: "fq" } } },
    { telemetry: { bbr: { status: "enabled", checkedAt: "2026-10-03T08:00:00Z" } } },
    { telemetry: {} }
  ]) {
    const p = hostPage([host(overrides)]);
    p.context.renderHosts();
    assert.doesNotMatch(p.target.innerHTML, /BBR 已启用/);
    assert.match(p.target.innerHTML, /BBR (状态过期|待上报)/);
  }
  const local = hostPage([host({ id: "local", kind: "local" })], { runtime: { mode: "dry-run", state: "staged" }, bbr: { status: "enabled", checkedAt } });
  local.context.renderHosts();
  assert.match(local.target.innerHTML, /本地测试模式/);
  assert.doesNotMatch(local.target.innerHTML, /BBR 已启用/);
});

test("enabling remote BBR queues one task and waits for reported confirmation", async () => {
  const p = hostPage([host({ agentVersion: "0.9.0", telemetry: { updatedAt: checkedAt, bbr: { status: "available", checkedAt } } })]);
  const calls = [], toasts = [];
  Object.assign(p.context, { api: async (path, options) => { calls.push({ path, method: options.method }); return { taskId: "bbr-task" }; }, loadBootstrap: async () => {}, openHost() {}, showToast: (...args) => toasts.push(args) });
  vm.runInContext(handler("configureHostBbr"), p.context);
  const button = { disabled: false, innerHTML: "启用 BBR" };
  await p.context.configureHostBbr("remote-1", button);
  assert.deepEqual(calls, [{ path: "/api/hosts/remote-1/bbr", method: "POST" }]);
  assert.match(toasts[0].join(" "), /已下发.*等待/);
  assert.doesNotMatch(toasts[0].join(" "), /BBR 已启用/);
});

test("runtime installation reports complete service readiness separately from a development binary", async () => {
  for (const development of [false, true]) {
    const p = hostPage([host({ id: "local", kind: "local" })], {
      runtime: { state: development ? "staged" : "running", mode: development ? "dry-run" : "systemd" },
      runtimeSetup: { status: development ? "development" : "succeeded", steps: [] }
    });
    const toasts = [], calls = [], renders = [];
    Object.assign(p.context, {
      runtimeSetupRequest: { running: false, error: "" },
      renderRuntimeSetup() { renders.push(p.context.runtimeSetupRequest.running); },
      api: async (path, options) => { calls.push({ path, method: options.method }); return { version: "1.14.2", runtimeSetup: p.context.controlPlane.runtimeSetup }; },
      loadBootstrap: async () => {}, showToast: (...args) => toasts.push(args)
    });
    vm.runInContext(["runtimeSetupPresentation", "installSingBox"].map(handler).join("\n"), p.context);
    await p.context.installSingBox();
    assert.deepEqual(calls, development ? [] : [{ path: "/api/runtime/install", method: "POST" }]);
    assert.deepEqual(renders, development ? [] : [true, false]);
    if (development) {
      const markup = p.context.runtimeSetupMarkup();
      assert.match(markup, /本地测试模式/);
      assert.match(markup, /不运行 Linux 代理服务/);
      assert.match(markup, /data-install-runtime disabled/);
    } else assert.match(toasts[0].join(" "), /安装与配置完成/);
  }
});

test("system updates stay blocked in local mode and accepted upgrades are not reported as completed", async () => {
  const p = hostPage([], { systemUpdate: { currentVersion: "0.2.33", latestVersion: "0.3.0", updateAvailable: true, status: "ready" }, runtime: { mode: "dry-run", platform: "darwin" } });
  const calls = [], toasts = [];
  Object.assign(p.context, {
    systemUpdateRequest: { checking: false, upgrading: false, error: "" }, window: { confirm: () => true },
    api: async (path, options) => { calls.push({ path, method: options.method }); return { task: { status: "queued", stage: "download", message: "等待下载" } }; },
    loadBootstrap: async () => {}, renderSystemUpdate() {}, showToast: (...args) => toasts.push(args)
  });
  vm.runInContext(["systemUpdatePresentation", "upgradeSystem"].map(handler).join("\n"), p.context);
  await p.context.upgradeSystem();
  assert.equal(calls.length, 0);
  p.context.controlPlane.runtime = { mode: "systemd", platform: "linux" };
  await p.context.upgradeSystem();
  assert.deepEqual(calls, [{ path: "/api/system/upgrade", method: "POST" }]);
  assert.match(toasts.at(-1).join(" "), /已接受.*等待/);
  assert.doesNotMatch(toasts.at(-1).join(" "), /升级完成|更新完成/);
});

test("failed installation exposes the backend error and keeps a retry action even when the binary exists", async () => {
  const p = hostPage([host({ id: "local", kind: "local" })], { installation: { installed: true } });
  const toasts = [];
  Object.assign(p.context, {
    api: async () => { throw new Error("systemd service failed"); },
    renderRuntimeSetup() {}, showToast: (...args) => toasts.push(args)
  });
  vm.runInContext(handler("installSingBox"), p.context);
  await p.context.installSingBox();
  const markup = p.context.runtimeSetupMarkup();
  assert.match(markup, /systemd service failed/);
  assert.match(markup, /重试完整配置/);
  assert.doesNotMatch(markup, /data-install-runtime disabled/);
  assert.match(toasts[0].join(" "), /未完成/);
});

test("BBR failures remain retryable and successful writes survive a temporarily failed refresh", async () => {
  const p = hostPage([host({ id: "local", kind: "local" })], { bbr: { status: "available", checkedAt } });
  const toasts = [], button = { disabled: false, innerHTML: "启用 BBR" };
  Object.assign(p.context, { api: async () => ({ status: "failed", error: "sysctl permission denied", checkedAt }),
    loadBootstrap: async () => { throw new Error("offline"); }, showToast: (...args) => toasts.push(args) });
  vm.runInContext(handler("configureHostBbr"), p.context);
  await p.context.configureHostBbr("local", button);
  assert.match(toasts[0].join(" "), /尚未启用.*sysctl permission denied/);
  assert.equal(button.disabled, false);
  assert.equal(p.context.hostBbrPresentation(p.context.controlPlane.hosts[0]).canConfigure, true);
});

test("legacy nodes keep manual upgrade instructions and later versions remain compatible", () => {
  const legacy = hostPage([host({ agentVersion: "0.8.0", nodeUpgrade: { supported: false, blockedReason: "旧 Node 需使用服务器命令" } })], { runtimeUpdate: { latestVersion: "1.14.2" } });
  legacy.context.controlPlane.hosts[0].runtimeVersion = "1.13.0";
  const legacyMarkup = legacy.context.hostDrawerMarkup("remote-1");
  assert.match(legacyMarkup, /node-upgrade-command/);
  assert.doesNotMatch(legacyMarkup, /data-upgrade-node=/);
  assert.match(legacyMarkup, /data-upgrade-host=/);
  const current = hostPage([host({ agentVersion: "0.10.0" })]);
  assert.doesNotMatch(current.context.hostDrawerMarkup("remote-1"), /node-upgrade-command|Node 可更新/);
  assert.equal(current.context.hostBbrPresentation(current.context.controlPlane.hosts[0]).label, "BBR 已启用");
});

test("pending and failed BBR tasks are visible without reusing a green historical result", () => {
  const pending = hostPage([host({ agentVersion: "0.9.0", bbrTask: { pending: true, status: "claimed" } })]);
  assert.match(pending.context.hostDrawerMarkup("remote-1"), /BBR 配置中/);
  assert.doesNotMatch(pending.context.hostDrawerMarkup("remote-1"), /data-configure-bbr=/);
  const failed = hostPage([host({ agentVersion: "0.9.0", bbrTask: { pending: false, status: "failed", error: "kernel denied sysctl" } })]);
  const markup = failed.context.hostDrawerMarkup("remote-1");
  assert.match(markup, /BBR 配置失败/);
  assert.match(markup, /kernel denied sysctl/);
  assert.match(markup, /data-configure-bbr=/);
  assert.doesNotMatch(markup, /BBR 已启用/);
});

test("a supported Node upgrade is queued once and later heartbeat drives the result", async () => {
  const p = hostPage([host({ agentVersion: "0.9.0", nodeUpgrade: { supported: true, availableVersion: "0.10.0" } })]);
  const calls = [], toasts = [];
  Object.assign(p.context, { window: { confirm: () => true }, api: async (path, options) => { calls.push({ path, method: options.method }); return { taskId: "node-task" }; }, loadBootstrap: async () => {}, showToast: (...args) => toasts.push(args) });
  vm.runInContext(handler("upgradeNode"), p.context);
  assert.match(p.context.hostDrawerMarkup("remote-1"), /data-upgrade-node=/);
  const button = { disabled: false };
  await p.context.upgradeNode("remote-1", button);
  await p.context.upgradeNode("remote-1", button);
  assert.deepEqual(calls, [{ path: "/api/hosts/remote-1/node-upgrade", method: "POST" }]);
  assert.match(toasts[0].join(" "), /已下发.*等待/);
  assert.match(p.context.hostDrawerMarkup("remote-1"), /Node 更新中/);
});

test("only Owner can see or submit a Node system update", async () => {
  for (const role of ["operator", "support", "auditor"]) {
    const p = hostPage([host({ agentVersion: "0.9.0", nodeUpgrade: { supported: true, availableVersion: "0.10.0" } })], { currentAdmin: { id: `${role}-1`, role } });
    const calls = [];
    Object.assign(p.context, { window: { confirm: () => true }, api: async (...args) => { calls.push(args); return { taskId: "forbidden-task" }; }, loadBootstrap: async () => {}, showToast() {} });
    vm.runInContext(handler("upgradeNode"), p.context);
    assert.doesNotMatch(p.context.hostDrawerMarkup("remote-1"), /data-upgrade-node=/);
    await p.context.upgradeNode("remote-1", { disabled: false });
    assert.equal(calls.length, 0, `${role} must not submit a Node update`);
  }
});

test("support accounts cannot submit maintenance and late installation responses cannot affect a new login", async () => {
  const p = hostPage([host({ id: "local", kind: "local" })], { currentAdmin: { id: "support-1", role: "support" } });
  const toasts = [], calls = [];
  let finish;
  Object.assign(p.context, { renderRuntimeSetup() {}, showToast: (...args) => toasts.push(args), api: (path) => { calls.push(path); return new Promise(resolve => { finish = resolve; }); } });
  vm.runInContext(handler("installSingBox"), p.context);
  await p.context.installSingBox();
  assert.equal(calls.length, 0);
  p.context.controlPlane.currentAdmin = { id: "owner-1", role: "owner" };
  const pending = p.context.installSingBox();
  p.context.controlPlaneConnection.generation += 1;
  p.context.controlPlane.currentAdmin = { id: "owner-2", role: "owner" };
  p.context.controlPlane.runtimeSetup = { status: "idle" };
  finish({ runtimeSetup: { status: "succeeded" } });
  await pending;
  assert.equal(p.context.controlPlane.runtimeSetup.status, "idle");
  assert.equal(toasts.length, 0);
});
