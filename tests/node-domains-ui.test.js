import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// UI form submission and HTTP are the agreed public seams.
const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function handler(name) {
  const start = source.indexOf(`async function ${name}(`) >= 0
    ? source.indexOf(`async function ${name}(`)
    : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing shipped handler ${name}`);
  const end = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1)].filter(value => value > start);
  return source.slice(start, Math.min(...end));
}

test("SSH onboarding retains bootstrap's disabled inheritance when refreshing DNS settings fails", async () => {
  const element = { hidden: true, dataset: {}, textContent: "", querySelector() { return { ...this }; } };
  const context = {
    controlPlane: {}, users: [], accountSummary: {},
    document: { querySelector: () => ({ ...element }), querySelectorAll: () => [], body: { dataset: {} } },
    canProvision: () => true, clearProvisioning() {}, clearMcpAccess() {}, selectWorkspaceTab() {},
    renderUsers() {}, renderRuntime() {}, renderRoutingPolicy() {}, renderRuntimeSetup() {}, renderSystemUpdate() {},
    escapeHtml: value => value, icon: () => "", setText() {}, AbortSignal,
    api: async () => { throw new Error("DNS settings temporarily unavailable"); }
  };
  vm.createContext(context);
  for (const name of ["applyBootstrap", "loadNodeDomainSettings", "provisioningFormMarkup"]) {
    vm.runInContext(handler(name), context);
  }
  context.applyBootstrap({
    currentAdmin: { id: "owner-1", username: "owner", role: "owner" }, users: [], hosts: [], deployments: [],
    nodeDomains: { provider: "cloudflare", autoProvision: true, inheritProtocols: false }
  });
  await context.loadNodeDomainSettings();
  const markup = context.provisioningFormMarkup();
  const inheritanceInput = markup.match(/<input\b[^>]*name="inheritProtocols"[^>]*>/)?.[0];
  assert.ok(inheritanceInput, "SSH form must retain its explicit protocol inheritance choice");
  assert.doesNotMatch(inheritanceInput, /\bchecked\b/);
});

test("saving DNS settings omits an empty token to preserve the configured credential", async () => {
  const requests = []; const button = { disabled: false };
  const form = { elements: { provider: { value: "cloudflare" }, zoneId: { value: "zone-123" }, baseDomain: { value: "nodes.example.com" }, apiToken: { value: "" }, autoProvision: { checked: true }, inheritProtocols: { checked: true } }, querySelector: () => button };
  const context = { controlPlane: { currentAdmin: { id: "owner-1", role: "owner" } }, api: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { nodeDomains: { tokenConfigured: true } }; }, renderNodeDomainSettings() {}, showToast() {}, setText() {} };
  vm.runInNewContext(handler("saveNodeDomainSettings"), context);
  await context.saveNodeDomainSettings({ preventDefault() {}, currentTarget: form });
  assert.deepEqual(requests, [{ path: "/api/settings/node-domains", body: { provider: "cloudflare", zoneId: "zone-123", baseDomain: "nodes.example.com", autoProvision: true, inheritProtocols: true } }]);
  assert.equal(button.disabled, false);
});

test("DNS settings clear a replacement token after acceptance and non-owners cannot submit", async () => {
  const requests = []; const button = { disabled: false };
  const form = { elements: { provider: { value: "cloudflare" }, zoneId: { value: "zone-123" }, baseDomain: { value: "nodes.example.com" }, apiToken: { value: "fixture-token-value" }, autoProvision: { checked: true }, inheritProtocols: { checked: false } }, querySelector: () => button };
  const context = { controlPlane: { currentAdmin: { id: "owner-1", role: "owner" } }, api: async (path, options) => { requests.push(JSON.parse(options.body)); return { nodeDomains: { tokenConfigured: true } }; }, renderNodeDomainSettings() {}, showToast() {}, setText() {} };
  vm.runInNewContext(handler("saveNodeDomainSettings"), context);
  await context.saveNodeDomainSettings({ preventDefault() {}, currentTarget: form });
  assert.equal(requests[0].apiToken, "fixture-token-value");
  assert.equal(form.elements.apiToken.value, "");
  context.controlPlane.currentAdmin.role = "operator";
  await context.saveNodeDomainSettings({ preventDefault() {}, currentTarget: form });
  assert.equal(requests.length, 1);
});
