import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";
import { NodeDomains } from "../server/node-domains.js";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-domains-"));
  const dbPath = join(directory, "store.db");
  const store = new RayLinkStore({ dbPath, adminUsername: "admin", adminPassword: "test-password", seedDemoData: false });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = [], records = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    if (!String(url).includes("/dns_records")) return Response.json({ success: true, result: { name: "example.com" } });
    if (init.method === "POST") {
      records.push({ id: "record-1", ...JSON.parse(init.body) });
      if (options.lostResponse) throw new Error("response lost after commit");
      return Response.json({ success: true, result: records.at(-1) });
    }
    return Response.json({ success: true, result: records, result_info: { total_pages: 1 } });
  };
  const domains = new NodeDomains({ store, fetchImpl, lookup: async () => [{ address: "203.0.113.12" }], pollMs: 1, waitMs: 5, ...options });
  const host = store.createRemoteHost({ name: "Test", address: "203.0.113.12", region: "global" }).host;
  return { domains, store, host, calls, records, dbPath };
}
const settings = { provider: "cloudflare", zoneId: "a".repeat(32), baseDomain: "nodes.example.com", apiToken: "test-CF-token-not-in-json", autoProvision: true, inheritProtocols: true };

test("DNS automation settings retain an encrypted token and never return its value", async (t) => {
  const f = await fixture(t);
  assert.equal(f.domains.settings().provider, "disabled");
  const value = f.domains.updateSettings(settings);
  assert.equal(value.tokenConfigured, true);
  assert.doesNotMatch(JSON.stringify(value), /test-CF-token/);
  f.domains.updateSettings({ ...settings, apiToken: "", inheritProtocols: false });
  assert.equal(f.domains.settings().tokenConfigured, true);
  assert.equal(f.domains.settings().inheritProtocols, false);
  assert.equal((await readFile(f.dbPath)).includes(Buffer.from(settings.apiToken)), false);
  assert.throws(() => f.domains.updateSettings({ baseDomain: "https://bad.example/path" }), { code: "INVALID_NODE_DOMAIN_SETTINGS" });
});

test("automatic DNS creates one unproxied record, reuses it after a lost response and keeps the SSH IP", async (t) => {
  const f = await fixture(t, { lostResponse: true });
  f.domains.updateSettings(settings);
  const first = await f.domains.configure(f.host, { domainMode: "auto" });
  assert.match(first.endpointDomain, /^node-[a-f0-9]+\.nodes\.example\.com$/);
  assert.equal(f.store.getHost(f.host.id).address, "203.0.113.12");
  assert.equal(f.store.getHost(f.host.id).endpointDomain, first.endpointDomain);
  const second = await f.domains.configure(f.store.getHost(f.host.id), { domainMode: "auto" });
  assert.equal(second.endpointDomain, first.endpointDomain);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(f.records[0].proxied, false);
  assert.equal(f.records[0].type, "A");
  assert.equal(f.records[0].content, "203.0.113.12");
  assert.doesNotMatch(JSON.stringify(first), /test-CF-token/);
});

test("DNS automation never overwrites an existing unowned record or accepts mixed public answers", async (t) => {
  const f = await fixture(t);
  f.domains.updateSettings(settings);
  f.records.push({ id: "someone-else", type: "A", content: f.host.address, proxied: false });
  await assert.rejects(f.domains.configure(f.host, { domainMode: "auto" }), { code: "NODE_DNS_RECORD_CONFLICT" });
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(f.store.getHost(f.host.id).endpointDomain, null);
  const wrong = new NodeDomains({ store: f.store, lookup: async () => [{ address: f.host.address }, { address: "203.0.113.99" }], pollMs: 1, waitMs: 3 });
  await assert.rejects(wrong.configure(f.host, { domainMode: "existing", endpointDomain: "other.example.com" }), { code: "NODE_DOMAIN_BINDING_CONFLICT" });
});

test("existing domains require matching resolution and disabled automation preserves IP-only onboarding", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.domains.configure(f.host, { domainMode: "auto" })).endpointDomain, null);
  assert.equal(f.calls.length, 0);
  const existing = await f.domains.configure(f.host, { domainMode: "existing", endpointDomain: "vps.example.com" });
  assert.equal(existing.endpointDomain, "vps.example.com");
  assert.equal(f.calls.length, 0);
  const g = await fixture(t, { lookup: async () => [{ address: "203.0.113.99" }], waitMs: 3 });
  await assert.rejects(g.domains.configure(g.host, { domainMode: "existing", endpointDomain: "vps.example.com" }), { code: "NODE_DOMAIN_DNS_PENDING" });
  assert.equal(g.store.getHost(g.host.id).endpointDomain, null);
});

test("wrong zone does not reserve the domain and can be corrected before retry", async (t) => {
  const f = await fixture(t);
  f.domains.updateSettings({ ...settings, baseDomain: "nodes.wrong.test" });
  await assert.rejects(f.domains.configure(f.host, { domainMode: "auto" }), { code: "NODE_DNS_ZONE_MISMATCH" });
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM node_domain_bindings").get().n, 0);
  f.domains.updateSettings({ baseDomain: "nodes.example.com" });
  assert.match((await f.domains.configure(f.host, { domainMode: "auto" })).endpointDomain, /nodes\.example\.com$/);
});

test("IPv6 node gets a DNS-only AAAA record and rejects another public address in resolution", async (t) => {
  const f = await fixture(t, { lookup: async () => [{ address: "2001:db8::12" }] });
  const host = f.store.createRemoteHost({ name: "IPv6", address: "2001:db8::12", region: "global" }).host;
  f.domains.updateSettings(settings);
  await f.domains.configure(host, { domainMode: "auto" });
  assert.equal(f.records[0].type, "AAAA");
  assert.equal(f.records[0].content, "2001:db8::12");
  const other = f.store.createRemoteHost({ name: "Mixed", address: "203.0.113.12", region: "global" }).host;
  const wrong = new NodeDomains({ store: f.store, lookup: async () => [{ address: other.address }, { address: "203.0.113.99" }], pollMs: 1, waitMs: 3 });
  await assert.rejects(wrong.configure(other, { domainMode: "existing", endpointDomain: "mixed.example.com" }), { code: "NODE_DOMAIN_DNS_PENDING" });
  assert.equal(f.store.getHost(other.id).endpointDomain, null);
});
