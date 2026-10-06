import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const webRoot = new URL("../web/", import.meta.url);

test("strategy workspace exposes simple modes, custom rules and explainable diagnostics", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("index.html", webRoot), "utf8"),
    readFile(new URL("app.js", webRoot), "utf8")
  ]);

  assert.match(html, /id="routing-mode-form"/);
  assert.match(html, /value="smart"/);
  assert.match(html, /value="global-proxy"/);
  assert.match(html, /value="direct"/);
  assert.match(html, /<select name="aiSelection">/);
  assert.match(html, /<option value="manual">手动固定节点<\/option>/);
  assert.match(html, /<option value="fallback">协议自动回退<\/option>/);
  assert.match(html, /id="routing-rule-form"/);
  assert.match(html, /id="routing-diagnose-form"/);
  assert.match(script, /\/api\/settings\/routing/);
  assert.match(script, /\/api\/routing\/diagnose/);
});

test("routing policy renders during the post-login bootstrap", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const helperStart = script.indexOf("function setText(");
  const policyStart = script.indexOf("const routingModeCopy");
  const policyEnd = script.indexOf("async function persistRoutingPolicy");

  assert.notEqual(helperStart, -1, "the shared text helper must be declared");
  assert.notEqual(policyStart, -1);
  assert.notEqual(policyEnd, -1);

  const nodes = new Map();
  const context = {
    controlPlane: { currentAdmin: { role: "owner" }, routingPolicy: { mode: "smart", rules: [] } },
    routingPolicySaving: false,
    document: {
      querySelectorAll(selector) {
        if (selector.includes('#routing-mode-form select,')) {
          return [this.querySelector('#routing-mode-form select[name="aiSelection"]')];
        }
        return [];
      },
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", textContent: "" });
        return nodes.get(selector);
      }
    },
    escapeHtml: String
  };

  vm.runInNewContext(
    `${script.slice(helperStart, policyStart)}\n${script.slice(policyStart, policyEnd)}\nrenderRoutingPolicy();`,
    context
  );

  assert.equal(nodes.get("#routing-mode-title").textContent, "智能分流");
  assert.equal(nodes.get("#routing-rule-count").textContent, "0");
  const aiSelection = nodes.get('#routing-mode-form select[name="aiSelection"]');
  assert.equal(aiSelection.value, "fallback", "older policies preserve protocol fallback");
  assert.equal(aiSelection.disabled, false);
  context.controlPlane.routingPolicy.aiSelection = "manual";
  context.controlPlane.currentAdmin.role = "auditor";
  context.renderRoutingPolicy();
  assert.equal(aiSelection.value, "manual", "saved manual selection is shown after bootstrap");
  assert.equal(aiSelection.disabled, true, "read-only roles cannot edit the selection");
});

test("saving routing rules separates publication metadata and refreshes coverage without clearing the AI draft", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const start = script.indexOf("async function persistRoutingPolicy(");
  const end = script.indexOf("\nasync function saveRoutingMode", start);
  const saved = { mode: "smart", rules: [], runtimeSync: { status: "pending" } };
  const messages = [], requests = [];
  let refreshed = 0;
  const context = {
    controlPlane: { currentAdmin: { id: "owner-1", role: "owner" }, routingPolicy: {} },
    controlPlaneConnection: { generation: 1 }, routingPolicySaving: false, aiEgressDirty: true,
    canManageRoutingPolicy: () => true, routingPublicationStatus: () => "待发布；尚未确认 Runtime 应用",
    api: async (_path, options) => { requests.push(JSON.parse(options.body)); return saved; },
    renderRoutingPolicy() {}, showToast: (...args) => messages.push(args), setText: (...args) => messages.push(args),
    loadBootstrap: async () => { refreshed++; }
  };
  vm.runInNewContext(script.slice(start, end), context);
  await context.persistRoutingPolicy({ mode: "smart", rules: [], runtimeSync: { status: "old" } }, "订阅已更新");
  assert.equal(Object.hasOwn(requests[0], "runtimeSync"), false);
  assert.equal(Object.hasOwn(context.controlPlane.routingPolicy, "runtimeSync"), false);
  assert.equal(refreshed, 1);
  assert.equal(context.aiEgressDirty, true);
  assert.ok(messages.some(message => message.join(" ").includes("待发布")));
});

test("routing mode form saves manual AI selection with the existing host restriction and rules", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const start = script.indexOf("async function saveRoutingMode(");
  const end = script.indexOf("\nasync function addRoutingRule", start);
  const policy = {
    mode: "smart", aiSelection: "fallback", unknownDomain: "resolve-geoip",
    aiExit: { mode: "pinned", hostId: "host-a" },
    rules: [{ id: "direct-work", action: "direct", match: "domain", value: "work.example" }]
  };
  const saved = [];
  const context = {
    controlPlane: { routingPolicy: policy }, routingPolicySaving: false,
    canManageRoutingPolicy: () => true,
    FormData: class {
      constructor(form) { this.form = form; }
      get(name) { return this.form[name]; }
    },
    persistRoutingPolicy: async next => { saved.push(JSON.parse(JSON.stringify(next))); },
    showToast() { assert.fail("saving the form must succeed"); }
  };
  vm.runInNewContext(script.slice(start, end), context);
  await context.saveRoutingMode({ preventDefault() {}, currentTarget: { mode: "smart", aiSelection: "manual" } });
  assert.deepEqual(saved, [{ ...policy, aiSelection: "manual" }]);
  context.canManageRoutingPolicy = () => false;
  await context.saveRoutingMode({ preventDefault() {}, currentTarget: { mode: "smart", aiSelection: "fallback" } });
  assert.equal(saved.length, 1, "read-only users cannot change AI node selection");
});

test("routing saves reject read-only roles, coalesce duplicate writes and discard a previous session response", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const start = script.indexOf("async function persistRoutingPolicy(");
  const end = script.indexOf("\nasync function saveRoutingMode", start);
  let release, calls = 0;
  const messages = [];
  const original = { mode: "smart", rules: [] };
  const context = { controlPlane: { currentAdmin: { id: "read-only", role: "auditor" }, routingPolicy: original },
    controlPlaneConnection: { generation: 1 }, routingPolicySaving: false,
    canManageRoutingPolicy: () => ["owner", "operator"].includes(context.controlPlane.currentAdmin.role),
    api: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    renderRoutingPolicy() {}, showToast: (...args) => messages.push(args), setText: (...args) => messages.push(args),
    loadBootstrap: async () => { throw new Error("stale writes must not refresh the next session"); } };
  vm.runInNewContext(script.slice(start, end), context);
  assert.equal(await context.persistRoutingPolicy(original, "saved"), null);
  assert.equal(calls, 0);
  context.controlPlane.currentAdmin = { id: "owner-1", role: "owner" };
  const pending = context.persistRoutingPolicy(original, "saved");
  assert.equal(await context.persistRoutingPolicy(original, "duplicate"), null);
  assert.equal(calls, 1);
  context.controlPlaneConnection.generation++;
  context.controlPlane.currentAdmin = { id: "owner-2", role: "owner" };
  context.routingPolicySaving = false;
  release({ mode: "direct", rules: [], runtimeSync: { status: "current" } });
  assert.equal(await pending, null);
  assert.equal(context.controlPlane.routingPolicy, original);
  assert.deepEqual(messages, []);
});
