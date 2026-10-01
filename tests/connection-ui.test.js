import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

// Drive the shipped page-entry and browser events with only DOM, HTTP and time replaced.
function page() {
  const nodes = new Map();
  const timers = new Map();
  const events = new Map();
  const requests = [];
  let timerId = 0;
  let outcome = "online";
  let loggedOut = 0;
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: "", disabled: false });
    return nodes.get(selector);
  };
  const timer = (callback, delay, interval = false) => {
    const id = ++timerId; timers.set(id, { callback, delay, interval }); return id;
  };
  const context = {
    AbortSignal, AbortController,
    window: { addEventListener(name, handler) { events.set(name, handler); } },
    document: { hidden: false, querySelector: node, addEventListener(name, handler) { events.set(name, handler); } },
    navigator: { onLine: true }, location: { hash: "#/system", origin: "http://127.0.0.1:43127" },
    controlPlane: { currentAdmin: { id: "owner", role: "owner" } },
    provisioning: { loading: false, timer: null, jobs: [], generation: 0 },
    elements: { authScreen: {}, appShell: {}, mobileNav: {}, authError: {} },
    applyBootstrap() {}, syncResponsiveNavigation() {}, navigate() {}, loadProvisioningJobs: async () => {},
    showAdminLogin() { loggedOut++; context.controlPlane.currentAdmin = null; },
    setText(selector, value) { node(selector).textContent = value; },
    setTimeout: timer, clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => timer(callback, delay, true), clearInterval: (id) => timers.delete(id),
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (outcome === "offline") throw new TypeError("Failed to fetch");
      if (typeof outcome === "function") return outcome(path, options);
      return { ok: outcome !== "unauthorized", status: outcome === "unauthorized" ? 401 : 200,
        headers: { get: () => "application/json" }, json: async () => outcome === "unauthorized" ? {} : { currentAdmin: context.controlPlane.currentAdmin } };
    }
  };
  vm.createContext(context);
  const helpers = source.indexOf("function renderControlPlaneConnection(");
  vm.runInContext([
    source.slice(0, source.indexOf("const requiredNodeAgentVersion")),
    block("async function api(", "\nfunction scopeToLabel"),
    block("async function loadBootstrap(", "\nfunction renderRuntime"),
    helpers === -1 ? "" : source.slice(helpers, source.indexOf("async function enterControlPlane(")),
    block("async function enterControlPlane(", "\nelements.authForm.addEventListener")
  ].join("\n"), context);
  const loginButton = { disabled: false, textContent: "登录" };
  context.elements.authForm = {
    elements: { username: { value: "owner" }, password: { value: "fixture-password", focus() {} } },
    querySelector: () => loginButton,
    addEventListener(name, handler) { events.set(`login:${name}`, handler); }
  };
  const loginStart = source.indexOf('elements.authForm.addEventListener("submit"');
  const startupStart = Math.max(source.lastIndexOf("\nenterControlPlane().catch("), source.lastIndexOf("\nvoid initializeControlPlane();"));
  vm.runInContext(source.slice(loginStart, startupStart), context);
  return {
    context, nodes, node, timers, events, requests,
    setOutcome(value) { outcome = value; },
    initialize() {
      return context.initializeControlPlane ? context.initializeControlPlane() : vm.runInContext(source.slice(startupStart), context);
    },
    get loggedOut() { return loggedOut; },
    async tick() {
      assert.ok(timers.size, "page should schedule its next refresh");
      const [id, pending] = timers.entries().next().value;
      if (!pending.interval) timers.delete(id);
      await pending.callback();
      return pending.delay;
    }
  };
}

test("a stopped control plane shows its address and stale-data warning instead of silently keeping old status", async () => {
  const p = page();
  await p.context.enterControlPlane();
  p.setOutcome("offline");
  await p.tick();
  assert.equal(p.node("#connection-notice").hidden, false);
  assert.match(p.node("#connection-title").textContent, /无法连接/);
  assert.match(p.node("#connection-copy").textContent, /http:\/\/127\.0\.0\.1:43127/);
  assert.match(p.node("#connection-copy").textContent, /过期/);
  assert.equal(p.loggedOut, 0, "network errors must preserve the current form and session");
});

test("failed background reads back off to one minute and a recovered service resumes normal refresh", async () => {
  const p = page();
  await p.context.enterControlPlane();
  p.setOutcome("offline");
  await p.tick();
  for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
    assert.equal(p.timers.size, 1);
    assert.equal(await p.tick(), delay);
  }
  p.setOutcome("online");
  await p.tick();
  assert.equal(p.node("#connection-notice").hidden, true);
  assert.equal(await p.tick(), 10_000);
  assert.ok(p.requests.every(({ options }) => !options.method || options.method === "GET"));
  assert.ok(p.requests.every(({ options }) => options.signal), "background reads need a deadline");
});

test("browser offline and hidden states pause reads; becoming visible or online reconnects immediately", async () => {
  const p = page();
  await p.context.enterControlPlane();
  p.context.document.hidden = true;
  await p.events.get("visibilitychange")();
  assert.equal(p.timers.size, 0);
  assert.equal(p.requests.length, 1);
  p.context.navigator.onLine = false;
  await p.events.get("offline")();
  assert.equal(p.node("#connection-notice").hidden, false);
  p.context.document.hidden = false;
  await p.events.get("visibilitychange")();
  assert.equal(p.requests.length, 1);
  p.context.navigator.onLine = true;
  await p.events.get("online")();
  assert.equal(p.requests.length, 2);
  assert.equal(p.node("#connection-notice").hidden, true);
  assert.equal(p.timers.size, 1);
});

test("task progress pauses on connection failure and a successful reconnect refreshes its saved jobs", async () => {
  const p = page();
  await p.context.enterControlPlane();
  p.context.canProvision = () => true;
  p.context.renderProvisioningJobs = () => {};
  p.context.provisioning.jobs = [{ id: "job-1", status: "running" }];
  vm.runInContext(block("async function loadProvisioningJobs(", "\nfunction shellQuote"), p.context);
  p.setOutcome("offline");
  await p.context.loadProvisioningJobs();
  assert.equal(p.node("#connection-notice").hidden, false);
  assert.equal(p.timers.size, 1, "progress must share reconnect polling instead of adding a 2-second loop");
  const before = p.requests.length;
  await p.context.loadProvisioningJobs();
  assert.equal(p.requests.length, before, "offline progress reads should be paused");
  p.setOutcome((path) => ({ ok: true, headers: { get: () => "application/json" }, json: async () => path.endsWith("provision") ? { jobs: [{ id: "job-1", status: "running" }] } : { currentAdmin: p.context.controlPlane.currentAdmin } }));
  await p.context.reconnectControlPlane();
  assert.equal(p.node("#connection-notice").hidden, true);
  assert.equal(p.requests.at(-1).path, "/api/hosts/provision");
});

test("a local-only control plane explains the HTTPS prerequisite and does not submit SSH secrets", async () => {
  const p = page();
  p.context.controlPlane.provisioning = { canStart: false, controlPlaneOrigin: "http://127.0.0.1:4199", reason: "PROVISIONING_PUBLIC_HTTPS_REQUIRED" };
  Object.assign(p.context, { crypto: { randomUUID: () => "request-1" }, clearProvisioningSecrets() {}, icon: () => "", escapeHtml: String });
  vm.runInContext(block("function provisioningFormMarkup(", "\nconst provisioningLabels"), p.context);
  const form = { dataset: {}, elements: { host: { value: "192.0.2.1" }, password: { value: "do-not-send" } } };
  await assert.rejects(p.context.submitProvisioningForm(form), /HTTPS/);
  assert.equal(p.requests.length, 0);
  const markup = p.context.provisioningFormMarkup();
  assert.match(markup, /VPS 可访问的 HTTPS/);
  assert.match(markup, /http:\/\/127\.0\.0\.1:4199/);
  assert.doesNotMatch(markup, /203\.0\.113\.10/);
});

test("manual reconnect and browser events share one pending GET and never replay a failed write", async () => {
  const p = page();
  await p.context.enterControlPlane();
  p.setOutcome("offline");
  await assert.rejects(p.context.api("/api/hosts/provision", { method: "POST", body: "{}" }));
  let finish;
  p.setOutcome(() => new Promise((resolve) => { finish = resolve; }));
  const first = p.context.reconnectControlPlane();
  const second = p.events.get("online")();
  const direct = p.context.loadBootstrap({ share: true });
  assert.equal(p.requests.length, 3, "multiple refresh sources must share the pending bootstrap read");
  finish({ ok: true, headers: { get: () => "application/json" }, json: async () => ({ currentAdmin: p.context.controlPlane.currentAdmin }) });
  await Promise.all([first, second, direct]);
  assert.equal(p.requests.filter(({ options }) => options.method === "POST").length, 1);
  assert.equal(p.timers.size, 1);
});

test("an expired session stops reconnecting and returns to login", async () => {
  const p = page();
  await p.context.enterControlPlane();
  p.setOutcome("unauthorized");
  await p.tick();
  assert.equal(p.loggedOut, 1);
  assert.equal(p.timers.size, 0);
  await p.events.get("online")();
  assert.equal(p.requests.length, 2);
});

test("a stalled bootstrap read reaches its 15-second deadline and becomes recoverable", async () => {
  const p = page();
  await p.context.enterControlPlane();
  const timeout = new AbortController();
  p.context.AbortSignal = { any: AbortSignal.any, timeout(ms) { assert.equal(ms, 15_000); return timeout.signal; } };
  p.setOutcome((_path, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
  const refresh = p.context.reconnectControlPlane();
  timeout.abort(new DOMException("Timed out", "TimeoutError"));
  await refresh;
  assert.equal(p.node("#connection-notice").hidden, false);
  assert.equal(p.node("[data-reconnect-control-plane]").disabled, false);
  assert.equal(p.timers.size, 1);
});

test("a response finishing after the browser goes offline does not hide the offline warning", async () => {
  const p = page();
  await p.context.enterControlPlane();
  let finish;
  p.setOutcome(() => new Promise((resolve) => { finish = resolve; }));
  const pending = p.context.reconnectControlPlane();
  p.context.navigator.onLine = false;
  await p.events.get("offline")();
  finish({ ok: true, headers: { get: () => "application/json" }, json: async () => ({ currentAdmin: p.context.controlPlane.currentAdmin }) });
  await pending;
  assert.equal(p.node("#connection-notice").hidden, false);
  assert.equal(p.timers.size, 0);
});

test("login starts a fresh bootstrap read and a late unauthorized reconnect cannot log out the new session", async () => {
  const p = page();
  await p.context.enterControlPlane();
  p.context.elements.authScreen.hidden = false;
  p.context.elements.appShell.hidden = true;
  let finishOld;
  let signedIn = false;
  const response = (status) => ({ ok: status === 200, status, headers: { get: () => "application/json" }, json: async () => ({}) });
  p.setOutcome((path) => {
    if (path === "/api/auth/login") { signedIn = true; return response(200); }
    if (signedIn) return response(200);
    return new Promise((resolve) => { finishOld = resolve; });
  });
  const oldReconnect = p.context.reconnectControlPlane();
  const login = p.events.get("login:submit")({ preventDefault() {} });
  await Promise.resolve();
  finishOld(response(401));
  await Promise.all([oldReconnect, login]);
  assert.equal(p.requests.filter(({ path }) => path === "/api/bootstrap").length, 3, "login must send its own authenticated GET");
  assert.equal(p.loggedOut, 0);
  assert.equal(p.context.elements.appShell.hidden, false);
  assert.equal(p.context.elements.authError.textContent, "");
});

test("an aborted startup read cannot restore the login screen or reconnect loop after a new login", async () => {
  const p = page();
  let rejectOld;
  let signedIn = false;
  const response = { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) };
  p.setOutcome((path) => {
    if (path === "/api/auth/login") { signedIn = true; return response; }
    if (signedIn) return response;
    return new Promise((_resolve, reject) => { rejectOld = reject; });
  });
  const startup = p.initialize();
  const login = p.events.get("login:submit")({ preventDefault() {} });
  await login;
  assert.equal(p.context.elements.appShell.hidden, false, "the new login completes before the old startup rejects");
  rejectOld(new DOMException("Superseded by login", "AbortError"));
  await Promise.all([startup, login]);
  assert.equal(p.requests.filter(({ path }) => path === "/api/bootstrap").length, 2);
  assert.equal(p.context.elements.appShell.hidden, false);
  assert.equal(p.context.elements.authScreen.hidden, true);
  assert.equal(p.node("#connection-notice").hidden, true);
  assert.equal(p.context.elements.authError.textContent, "");
  assert.equal(p.timers.size, 1);
});

for (const oldReadFails of [false, true]) {
  test(`saving a user reads a fresh list after an older ${oldReadFails ? "failed" : "successful"} bootstrap finishes`, async () => {
    const p = page();
    let renderedUsers = [];
    p.context.applyBootstrap = (data) => { renderedUsers = data.users; };
    p.context.labelToScope = () => ["all"];
    vm.runInContext(block("async function saveUserForm(", "\nfunction showPasswordResetFieldError"), p.context);
    const form = {
      dataset: {},
      elements: Object.fromEntries(Object.entries({ name: "Saved user", email: "saved@example.com", quota: "100", nodeGroup: "全部节点", expires: "2030-12-31", usedGb: "0" }).map(([name, value]) => [name, { value }])),
      querySelector: () => ({ classList: { contains: () => true } })
    };
    const response = (body) => ({ ok: true, headers: { get: () => "application/json" }, json: async () => body });
    let finishOld;
    let rejectOld;
    let reads = 0;
    p.setOutcome((path, options) => {
      if (options.method === "POST") return response({ id: "new-user" });
      if (reads++ === 0) return new Promise((resolve, reject) => { finishOld = resolve; rejectOld = reject; });
      return response({ users: [{ id: "new-user", name: "Saved user" }] });
    });
    const earlierRead = p.context.loadBootstrap().catch(() => null);
    const savedUser = p.context.saveUserForm(form);
    for (let i = 0; i < 12 && !form.dataset.userId; i++) await Promise.resolve();
    assert.equal(form.dataset.userId, "new-user", "the POST must commit before the old read completes");
    if (oldReadFails) rejectOld(new TypeError("Old read failed"));
    else finishOld(response({ users: [] }));
    const [saved] = await Promise.all([savedUser, earlierRead]);
    assert.deepEqual(p.requests.map(({ path, options }) => [options.method || "GET", path]), [
      ["GET", "/api/bootstrap"], ["POST", "/api/users"], ["GET", "/api/bootstrap"]
    ]);
    assert.equal(saved.refreshWarning, undefined);
    assert.equal(renderedUsers[0]?.id, "new-user");
  });
}

test("fresh refreshes waiting on an old session cannot start another read after login changes", async () => {
  const p = page();
  let finishOld;
  let signedIn = false;
  const response = { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) };
  p.setOutcome((path) => {
    if (path === "/api/auth/login") { signedIn = true; return response; }
    if (signedIn) return response;
    return new Promise((resolve) => { finishOld = resolve; });
  });
  const oldRead = p.context.loadBootstrap();
  const waiting = assert.rejects(p.context.loadBootstrap(), { name: "AbortError" });
  await p.events.get("login:submit")({ preventDefault() {} });
  finishOld(response);
  await Promise.all([oldRead, waiting]);
  assert.equal(p.requests.filter(({ path }) => path === "/api/bootstrap").length, 2);
  assert.equal(p.context.elements.appShell.hidden, false);
});
