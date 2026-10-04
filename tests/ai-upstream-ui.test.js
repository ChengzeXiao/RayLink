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
  const end = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1)].filter((value) => value > start);
  return source.slice(start, Math.min(...end));
}
function fixture() {
  const button = { disabled: false, textContent: "保存并发布" };
  const form = { elements: {
    enabled: { checked: true }, type: { value: "https" }, server: { value: "proxy.example.com" }, port: { value: "443" },
    username: { value: "fixture-user" }, password: { value: "" }, tlsServerName: { value: "proxy.example.com" }, clearPassword: { checked: false }
  }, querySelector: () => button };
  const requests = [], messages = [];
  const context = {
    controlPlane: { currentAdmin: { id: "owner-1", role: "owner" }, aiUpstream: { config: { passwordConfigured: true } } }, controlPlaneConnection: { generation: 1 },
    aiUpstreamDirty: true, aiUpstreamSaving: false, aiUpstreamError: "", aiDiagnosticsLoading: false, canManageAiUpstream: () => true,
    api: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { config: { enabled: true, passwordConfigured: true, revision: 2 }, runtimeSync: { status: "current" } }; },
    renderAiUpstream() {}, renderAiExit() {}, renderAiDiagnosticReport() {}, loadAiDiagnostics() {}, loadBootstrap: async () => {},
    showToast: (...args) => messages.push(args), setText: (...args) => messages.push(args), AbortSignal,
    document: { querySelector: () => form }
  };
  vm.runInNewContext(handler("saveAiUpstream"), context);
  return { button, form, requests, messages, context, event: { preventDefault() {}, currentTarget: form } };
}
function renderer(subject) {
  const { context, form, button } = subject, retry = {}, tls = {};
  form.querySelector = (selector) => selector === "[data-ai-upstream-tls]" ? tls : button;
  form.querySelectorAll = () => [...Object.values(form.elements), button];
  context.document.querySelector = (selector) => selector === "#ai-upstream-form" ? form : selector === "#ai-upstream-publish" ? retry : null;
  vm.runInNewContext(`${handler("renderAiUpstream")}\n${handler("syncAiUpstreamForm")}`, context);
  return { retry, tls };
}

test("saving AI upstream preserves an omitted password and reports the returned publication state", async () => {
  const { context, event, requests, button, messages } = fixture();
  await context.saveAiUpstream(event);
  assert.deepEqual(requests, [{ path: "/api/settings/ai-upstream", body: {
    enabled: true, type: "https", server: "proxy.example.com", port: 443, username: "fixture-user", tlsServerName: "proxy.example.com"
  } }]);
  assert.equal(context.controlPlane.aiUpstream.runtimeSync.status, "current");
  assert.equal(context.aiUpstreamDirty, false);
  assert.equal(button.disabled, false);
  assert.ok(messages.some((message) => message.join(" ").includes("已保存并发布")));
});

test("replacement credentials clear after saving while pending or simulated publication never claims deployment", async () => {
  for (const status of ["pending", "simulated"]) {
    const { context, event, form, requests, messages } = fixture();
    form.elements.password.value = "  fixture-private-password  ";
    context.api = async (path, options) => {
      requests.push(JSON.parse(options.body));
      return { config: { enabled: true, passwordConfigured: true }, runtimeSync: { status } };
    };
    await context.saveAiUpstream(event);
    assert.equal(requests[0].password, "  fixture-private-password  ", "password whitespace belongs to the credential");
    assert.equal(form.elements.password.value, "");
    assert.equal(context.controlPlane.aiUpstream.runtimeSync.status, status);
    assert.equal(messages.some((message) => message.join(" ").includes("已保存并发布")), false);
    assert.ok(messages.some((message) => message.join(" ").includes(status === "pending" ? "待发布" : "仅模拟")));
  }
});

test("explicit password removal is separate from replacement and unauthorized saves send no request", async () => {
  const { context, event, form, requests } = fixture();
  form.elements.clearPassword.checked = true;
  form.elements.username.value = "";
  await context.saveAiUpstream(event);
  assert.equal(requests[0].body.clearPassword, true);
  assert.equal(Object.hasOwn(requests[0].body, "password"), false);
  form.elements.clearPassword.checked = true;
  form.elements.password.value = "replacement";
  await context.saveAiUpstream(event);
  assert.equal(requests.length, 1, "contradictory credential intent must not be sent");
  context.canManageAiUpstream = () => false;
  form.elements.clearPassword.checked = false;
  await context.saveAiUpstream(event);
  assert.equal(requests.length, 1);
});

test("failed saving retains unsaved credential input and visible failure instead of claiming publication", async () => {
  const subject = fixture(); renderer(subject);
  const { context, event, form, messages } = subject;
  form.elements.password.value = "retry-secret";
  context.api = async () => { throw new Error("配置校验失败"); };
  await context.saveAiUpstream(event);
  assert.equal(form.elements.password.value, "retry-secret");
  assert.equal(context.aiUpstreamDirty, true);
  assert.match(messages.filter(([selector]) => selector === "#ai-upstream-edit-status").at(-1)[1], /保存失败.*配置校验失败/);
  assert.equal(context.aiUpstreamSaving, false);
  assert.equal(messages.some((message) => message.join(" ").includes("已保存并发布")), false);
});

test("background state refresh preserves unsaved form values and credential input while a read-only administrator cannot edit", () => {
  const subject = fixture(), { context, form, button, messages } = subject;
  const { retry, tls } = renderer(subject);
  form.elements.password.value = "unfinished-secret";
  form.elements.server.value = "unsaved.example.com";
  context.controlPlane.aiUpstream = { config: { enabled: false, server: "saved.example.com", type: "socks5", passwordConfigured: true, revision: 2 }, runtimeSync: { status: "pending" } };
  context.renderAiUpstream();
  assert.equal(form.elements.server.value, "unsaved.example.com");
  assert.equal(form.elements.password.value, "unfinished-secret");
  assert.equal(tls.hidden, false, "unsaved HTTPS selection must retain its TLS field");
  assert.equal(retry.disabled, true, "unsaved changes must be saved before retrying publication");
  assert.equal(retry.hidden, false);
  assert.ok(messages.some(([selector, message]) => selector === "#ai-upstream-status" && message.includes("已保存，待发布")));
  context.canManageAiUpstream = () => false;
  context.renderAiUpstream();
  assert.equal(button.disabled, true);
  assert.equal(form.elements.password.disabled, true);
  assert.equal(form.elements.enabled.disabled, true);
});

test("native publication retry sends no credential payload and cannot publish an unsaved draft", async () => {
  const subject = fixture(), { context, requests } = subject;
  renderer(subject);
  vm.runInNewContext(handler("publishAiUpstream"), context);
  await context.publishAiUpstream();
  assert.equal(requests.length, 0);
  context.aiUpstreamDirty = false;
  await context.publishAiUpstream();
  assert.deepEqual(requests, [{ path: "/api/settings/ai-upstream/publish", body: {} }]);
});

test("upstream diagnostics identifies proxy authentication and old configuration without claiming API or Runtime success", () => {
  const result = { innerHTML: "" };
  const context = { document: { querySelector: () => result }, controlPlane: { aiUpstream: { config: { revision: 7 } } },
    escapeHtml: (value) => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;") };
  vm.runInNewContext(handler("renderAiDiagnosticReport"), context);
  context.renderAiDiagnosticReport({ source: "control-plane-via-upstream", configRevision: 6, checkedAt: "2026-10-04T12:00:00Z", results: [
    { host: "claude.ai", status: "upstream_authentication_required", stage: "upstream", message: "检查代理账号参数<script>" }
  ] });
  assert.match(result.innerHTML, /主控经已配置 AI 上游/);
  assert.match(result.innerHTML, /住宅代理认证失败/);
  assert.match(result.innerHTML, /配置版本 6/);
  assert.match(result.innerHTML, /旧配置/);
  assert.match(result.innerHTML, /未验证已发布 Runtime/);
  assert.doesNotMatch(result.innerHTML, /需要 API 认证|<script>/);
});
