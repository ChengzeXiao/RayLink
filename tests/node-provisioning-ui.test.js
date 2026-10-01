import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function handler(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `Missing shipped handler ${name}`);
  const end = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1)].filter((value) => value > start);
  return source.slice(start, Math.min(...end));
}
function form() {
  return { dataset: {}, elements: Object.fromEntries(Object.entries({ host: "203.0.113.10", port: "22", username: "root", authMethod: "password", password: "secret-test", privateKey: "", passphrase: "", sudoPassword: "sudo-test", hostname: "", region: "" }).map(([name, value]) => [name, { value }])) };
}

test("provisioning submission reuses its request ID after transport failure and clears credentials after acceptance", async () => {
  const requests = [];
  const context = { AbortSignal, crypto: { randomUUID: () => "stable-request" }, clearProvisioningSecrets: (target) => {
    for (const name of ["password", "privateKey", "passphrase", "sudoPassword"]) target.elements[name].value = "";
  }, api: async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    if (requests.length === 1) throw new Error("network timeout");
    return { job: { id: "job-1", status: "queued" } };
  } };
  vm.runInNewContext(handler("submitProvisioningForm"), context);
  const target = form();
  await assert.rejects(context.submitProvisioningForm(target), /timeout/);
  assert.equal(target.elements.password.value, "secret-test");
  assert.equal((await context.submitProvisioningForm(target)).id, "job-1");
  assert.equal(requests[0].body.requestId, requests[1].body.requestId);
  assert.equal(requests[1].body.name, undefined);
  assert.equal(target.elements.password.value, "");
  assert.equal(target.elements.sudoPassword.value, "");
});

test("retry recovers an accepted attempt after a lost HTTP response without resubmitting SSH credentials", async () => {
  const requests = [];
  const context = { AbortSignal, crypto: { randomUUID: () => "retry-request" }, clearProvisioningSecrets: (target) => { target.elements.password.value = ""; }, api: async (path, options = {}) => {
    requests.push({ path, method: options.method || "GET" });
    if (options.method === "POST") throw new Error("response lost");
    return { job: { id: "job-retry", status: "running" } };
  } };
  vm.runInNewContext(handler("submitProvisioningForm"), context);
  const target = form(); target.dataset.jobId = "job-retry";
  assert.equal((await context.submitProvisioningForm(target)).status, "running");
  assert.deepEqual(requests, [{ path: "/api/hosts/provision/job-retry/retry", method: "POST" }, { path: "/api/hosts/provision/job-retry", method: "GET" }]);
  assert.equal(target.elements.password.value, "");
});

test("an online-node continuation sends only retry identity without stale SSH credentials", async () => {
  let body;
  const context = { AbortSignal, crypto: { randomUUID: () => "continue-online" }, clearProvisioningSecrets() {}, api: async (path, options) => {
    body = JSON.parse(options.body); return { job: { id: "job-online", status: "queued" } };
  } };
  vm.runInNewContext(handler("submitProvisioningForm"), context);
  const target = form(); target.dataset.jobId = "job-online"; target.elements.authMethod.value = "resume";
  await context.submitProvisioningForm(target);
  assert.deepEqual(body, { requestId: "continue-online" });
});
