import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Form submissions, rendered state and API requests are the agreed UI seams.
const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function handler(name) {
  const start = source.indexOf(`async function ${name}(`) >= 0
    ? source.indexOf(`async function ${name}(`) : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing shipped handler ${name}`);
  const end = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1)].filter(value => value > start);
  return source.slice(start, Math.min(...end));
}
function fixture(mode = "residential") {
  const button = { disabled: false, textContent: "保存并发布" };
  const form = { elements: {
    mode: { value: mode }, hostMode: { value: "pinned" }, hostId: { value: "local", innerHTML: "", insertAdjacentHTML(_where, value) { this.innerHTML += value; } },
    type: { value: "https" }, server: { value: "proxy.example.com" }, port: { value: "443" }, username: { value: "fixture-user" },
    password: { value: "" }, tlsServerName: { value: "proxy.example.com" }, clearPassword: { checked: false }
  }, querySelector: () => button };
  const requests = [], messages = [];
  const upstream = { enabled: true, type: "https", server: "saved.example.com", port: 443, username: "fixture-user", passwordConfigured: true, revision: 2 };
  const context = {
    controlPlane: { currentAdmin: { id: "owner-1", role: "owner" }, hosts: [{ id: "local", name: "主控" }],
      aiUpstream: { config: upstream }, aiEgress: { mode, aiExit: { mode: "pinned", hostId: "local" }, upstream,
        runtimeSync: { status: "current", publishedMode: mode, runtimeState: "running" } }, routingPolicy: { mode: "smart", rules: [], aiExit: { mode: "pinned", hostId: "local" } } },
    controlPlaneConnection: { generation: 1 }, aiEgressDirty: true, aiEgressSaving: false, aiEgressError: "", aiDiagnosticsLoading: false,
    canManageAiEgress: () => true,
    api: async (path, options) => { const body = JSON.parse(options.body); requests.push({ path, body }); return {
      mode: body.mode || "residential", aiExit: body.aiExit || { mode: "pinned", hostId: "local" },
      upstream: { ...upstream, enabled: body.mode !== "server" }, runtimeSync: { status: "current", publishedMode: body.mode || "residential", runtimeState: "running" }
    }; },
    renderAiEgress() {}, renderRoutingPolicy() {}, renderAiDiagnosticReport() {}, loadBootstrap: async () => {},
    showToast: (...args) => messages.push(args), setText: (...args) => messages.push(args),
    escapeHtml: value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    document: { querySelector: () => form }
  };
  vm.runInNewContext(`${handler("applyAiEgress")}\n${handler("saveAiEgress")}`, context);
  return { button, form, requests, messages, context, event: { preventDefault() {}, currentTarget: form } };
}
function renderer(subject) {
  const { context, form, button } = subject;
  const retry = {}, tls = {}, server = {}, residential = {};
  form.querySelector = selector => ({ "[data-ai-egress-tls]": tls, "[data-ai-egress-server]": server, "[data-ai-egress-residential]": residential })[selector] || button;
  form.querySelectorAll = () => [...Object.values(form.elements), button];
  context.document.querySelector = selector => selector === "#ai-egress-form" ? form : selector === "#ai-egress-publish" ? retry : null;
  vm.runInNewContext(`${handler("renderAiEgress")}\n${handler("syncAiEgressForm")}`, context);
  return { retry, tls, server, residential };
}

test("server mode submits only its Host choice and ignores all hidden residential credential fields", async () => {
  const subject = fixture("server"), { context, event, form, requests, messages } = subject;
  form.elements.server.value = "invalid://unused";
  form.elements.port.value = "bad";
  form.elements.password.value = "hidden-secret";
  form.elements.clearPassword.checked = true;
  await context.saveAiEgress(event);
  assert.deepEqual(requests, [{ path: "/api/settings/ai-egress", body: { mode: "server", aiExit: { mode: "pinned", hostId: "local" } } }]);
  assert.equal(context.controlPlane.aiUpstream.config.enabled, false);
  assert.equal(form.elements.password.value, "");
  assert.equal(context.aiEgressDirty, false);
  assert.ok(messages.some(message => message.join(" ").includes("已保存并发布")));
});

test("residential mode submits only proxy settings and preserves omitted passwords for all protocols", async () => {
  for (const type of ["socks5", "http", "https"]) {
    const { context, event, form, requests } = fixture();
    form.elements.type.value = type;
    await context.saveAiEgress(event);
    assert.deepEqual(requests[0], { path: "/api/settings/ai-egress", body: { mode: "residential", upstream: {
      type, server: "proxy.example.com", port: 443, username: "fixture-user", tlsServerName: type === "https" ? "proxy.example.com" : ""
    } } });
    assert.equal(context.controlPlane.routingPolicy.mode, "smart");
    assert.equal(context.controlPlane.routingPolicy.aiExit.hostId, "local");
  }
});

test("pending and simulated modes retain the last publication boundary and never announce a real switch", async () => {
  for (const status of ["pending", "simulated"]) {
    const subject = fixture(), { context, event, form, requests, messages } = subject;
    renderer(subject); context.renderRoutingPolicy = () => context.renderAiEgress();
    form.elements.password.value = "  fixture-private-password  ";
    context.api = async (_path, options) => {
      requests.push(JSON.parse(options.body));
      return { mode: "residential", aiExit: { mode: "pinned", hostId: "local" }, upstream: { enabled: true, passwordConfigured: true, revision: 3 },
        runtimeSync: { status, publishedMode: "server", runtimeState: "running" } };
    };
    await context.saveAiEgress(event);
    assert.equal(requests[0].upstream.password, "  fixture-private-password  ");
    assert.equal(form.elements.password.value, "");
    assert.equal(context.controlPlane.aiUpstream.runtimeSync.status, status);
    assert.equal(messages.some(message => message.join(" ").includes("已保存并发布")), false);
    const rendered = messages.filter(([selector]) => selector === "#ai-egress-status").at(-1)[1];
    assert.match(rendered, status === "pending" ? /尚未确认切换生效.*最近成功发布：服务器出口/ : /仅模拟.*真实发布：未验证/);
  }
});

test("explicit clearing is distinct from replacing credentials and unauthorized saves send no request", async () => {
  const { context, event, form, requests } = fixture();
  form.elements.clearPassword.checked = true;
  form.elements.username.value = "";
  await context.saveAiEgress(event);
  assert.equal(requests[0].body.upstream.clearPassword, true);
  assert.equal(Object.hasOwn(requests[0].body.upstream, "password"), false);
  form.elements.clearPassword.checked = true; form.elements.password.value = "replacement";
  await context.saveAiEgress(event);
  assert.equal(requests.length, 1);
  context.canManageAiEgress = () => false;
  form.elements.clearPassword.checked = false;
  await context.saveAiEgress(event);
  assert.equal(requests.length, 1);
});

test("failed saving retains the draft and secret instead of claiming publication", async () => {
  const subject = fixture(), { context, form, event, messages } = subject;
  renderer(subject); context.renderRoutingPolicy = () => context.renderAiEgress();
  form.elements.password.value = "retry-secret";
  context.api = async () => { throw new Error("配置校验失败"); };
  await context.saveAiEgress(event);
  assert.equal(form.elements.password.value, "retry-secret");
  assert.equal(context.aiEgressDirty, true);
  assert.equal(context.aiEgressSaving, false);
  assert.match(messages.filter(([selector]) => selector === "#ai-egress-edit-status").at(-1)[1], /保存失败.*配置校验失败/);
});

test("mode selection shows only its fields and hidden invalid proxies cannot participate in server validation", () => {
  const subject = fixture("server"), { context, form } = subject;
  const { server, residential, tls } = renderer(subject);
  context.renderAiEgress();
  assert.equal(server.hidden, false); assert.equal(server.disabled, false);
  assert.equal(residential.hidden, true); assert.equal(residential.disabled, true);
  assert.equal(form.elements.server.disabled, true); assert.equal(form.elements.server.required, false);
  assert.equal(form.elements.port.disabled, true); assert.equal(tls.hidden, true);
  form.elements.mode.value = "residential";
  context.renderAiEgress();
  assert.equal(server.hidden, true); assert.equal(server.disabled, true);
  assert.equal(residential.hidden, false); assert.equal(residential.disabled, false);
  assert.equal(form.elements.hostId.disabled, true); assert.equal(form.elements.server.required, true);
  assert.equal(tls.hidden, false);
});

test("background refresh preserves draft selection and credentials while read-only roles cannot edit", () => {
  const subject = fixture(), { context, form, button } = subject;
  const { retry } = renderer(subject);
  form.elements.server.value = "draft.example.com"; form.elements.password.value = "unfinished-secret";
  context.controlPlane.aiEgress.mode = "server";
  context.controlPlane.aiEgress.runtimeSync.status = "pending";
  context.renderAiEgress();
  assert.equal(form.elements.mode.value, "residential");
  assert.equal(form.elements.server.value, "draft.example.com");
  assert.equal(form.elements.password.value, "unfinished-secret");
  assert.equal(retry.disabled, true); assert.equal(retry.hidden, false);
  context.canManageAiEgress = () => false;
  context.renderAiEgress();
  assert.equal(button.disabled, true); assert.equal(form.elements.mode.disabled, true); assert.equal(form.elements.password.disabled, true);
});

test("retry publishes only saved state and sends no credentials or pending draft", async () => {
  const subject = fixture(), { context, requests } = subject;
  renderer(subject); vm.runInNewContext(handler("publishAiEgress"), context);
  await context.publishAiEgress(); assert.equal(requests.length, 0);
  context.aiEgressDirty = false;
  await context.publishAiEgress();
  assert.deepEqual(requests, [{ path: "/api/settings/ai-egress/publish", body: {} }]);
});

test("a response from a previous session cannot alter the newly logged-in administrator's form", async () => {
  const { context, event } = fixture();
  let release;
  context.api = () => new Promise(resolve => { release = resolve; });
  const pending = context.saveAiEgress(event);
  context.controlPlane.currentAdmin = { id: "other-admin", role: "owner" };
  context.controlPlaneConnection.generation++;
  const current = context.controlPlane.aiEgress;
  release({ mode: "server", upstream: { enabled: false }, aiExit: { mode: "auto", hostId: null }, runtimeSync: { status: "current" } });
  await pending;
  assert.equal(context.controlPlane.aiEgress, current);
});

test("upstream diagnostics separates proxy authentication and stale configuration from API account success", () => {
  const result = { innerHTML: "" };
  const context = { document: { querySelector: () => result }, controlPlane: { aiUpstream: { config: { revision: 7 } } },
    escapeHtml: value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;") };
  vm.runInNewContext(handler("renderAiDiagnosticReport"), context);
  context.renderAiDiagnosticReport({ source: "control-plane-via-upstream", configRevision: 6, checkedAt: "2026-10-04T12:00:00Z", results: [
    { host: "claude.ai", status: "upstream_authentication_required", stage: "upstream", message: "检查代理账号<script>" }
  ] });
  assert.match(result.innerHTML, /住宅代理认证失败/); assert.match(result.innerHTML, /旧配置/);
  assert.match(result.innerHTML, /未验证已发布 Runtime/); assert.doesNotMatch(result.innerHTML, /需要 API 认证|<script>/);
});

test("a pending dry-run switch labels the previous opposite mode as a simulation record", () => {
  const subject = fixture(), { context, messages } = subject;
  renderer(subject);
  context.controlPlane.aiEgress.runtimeSync = { status: "pending", publishedMode: "server", runtimeState: "staged", runtimeMode: "dry-run" };
  context.renderAiEgress();
  const status = messages.filter(([selector]) => selector === "#ai-egress-status").at(-1)[1];
  assert.match(status, /待发布/);
  assert.match(status, /最近模拟记录：服务器出口/);
  assert.match(status, /真实发布：未验证/);
  assert.doesNotMatch(status, /最近成功发布/);
});
