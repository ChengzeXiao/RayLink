import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Rendered coverage, submitted forms and returned diagnostic evidence are the agreed UI seams.
const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function handler(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `Missing shipped handler ${name}`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
const escapeHtml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

test("AI coverage is readable, includes exclusions and escapes domain data without adding another writable list", () => {
  const container = { innerHTML: "" };
  const context = { document: { querySelector: () => container }, escapeHtml,
    routingMatchLabels: { domain: "完整域名", domain_suffix: "域名后缀" }, routingActionLabels: { ai: "AI 出口", direct: "直连", proxy: "默认代理出口" },
    controlPlane: { aiDomainRules: { version: "fixture-v1", domainNames: ["gemini.google.com"], domainSuffixes: ["claude.ai"],
      sharedDomains: ["accounts.google.com"], protectedDomains: ["google.com"], customRules: [
        { id: "include", match: "domain", value: "custom.ai", action: "ai", enabled: true, priority: 10 },
        { id: "exclude", match: "domain", value: "<excluded.ai>", action: "direct", enabled: false, priority: 20 }
      ] } } };
  vm.runInNewContext(handler("renderAiDomainRules"), context);
  context.renderAiDomainRules();
  assert.match(container.innerHTML, /fixture-v1/);
  for (const domain of ["gemini.google.com", "claude.ai", "accounts.google.com", "google.com", "custom.ai"]) assert.ok(container.innerHTML.includes(domain));
  assert.match(container.innerHTML, /AI 出口/); assert.match(container.innerHTML, /直连/); assert.match(container.innerHTML, /已停用/);
  assert.match(container.innerHTML, /&lt;excluded.ai&gt;/);
  assert.doesNotMatch(container.innerHTML, /<(?:input|form|textarea)\b|<excluded.ai>/);
});

test("routing diagnostics separates AI classification, matched routing rule and pending or simulated publication", () => {
  const container = { innerHTML: "" };
  const context = { document: { querySelector: () => container }, escapeHtml,
    routingActionLabels: { ai: "AI 出口", proxy: "默认代理出口" }, routingMatchLabels: { domain: "完整域名" } };
  vm.runInNewContext(`${handler("routingPublicationStatus")}\n${handler("renderRoutingDiagnostic")}`, context);
  const diagnostic = { domain: "custom.ai", addresses: [], action: "ai", outbound: "ai-proxy", source: "custom", ruleId: "actual-rule", dns: "remote",
    explanation: "根据规则推断", checkedAt: "2026-10-04T00:00:00Z", aiDomain: { eligible: true, source: "custom", match: "domain", value: "custom.ai", ruleId: "ai-rule",
      reason: "命中 AI 专用规则", desiredEgress: "residential", runtimeSync: { status: "pending", runtimeMode: "dry-run", publishedMode: "server" } } };
  context.renderRoutingDiagnostic(diagnostic);
  assert.match(container.innerHTML, /AI 专用域名/); assert.match(container.innerHTML, /actual-rule/);
  assert.match(container.innerHTML, /住宅代理出口/); assert.match(container.innerHTML, /待发布/); assert.match(container.innerHTML, /模拟/);
  assert.match(container.innerHTML, /非客户端实测/); assert.doesNotMatch(container.innerHTML, /最近成功发布/);
  diagnostic.aiDomain = { eligible: false, source: "shared", reason: "共享登录服务保护", desiredEgress: "server", runtimeSync: { status: "not-required" } };
  context.renderRoutingDiagnostic(diagnostic);
  assert.match(container.innerHTML, /共享/); assert.match(container.innerHTML, /无需 Runtime 发布/);
  diagnostic.aiDomain.note = "仅判断目标到达当前主控后的域名出口；客户端 IP 规则可能改变路径。";
  diagnostic.aiDomain.desiredEgress = "blocked";
  context.renderRoutingDiagnostic(diagnostic);
  assert.match(container.innerHTML, /已拦截，无出口/); assert.match(container.innerHTML, /客户端 IP 规则可能改变路径/);
  diagnostic.aiDomain.desiredEgress = "client-direct";
  context.renderRoutingDiagnostic(diagnostic);
  assert.match(container.innerHTML, /客户端直连/);
  diagnostic.aiDomain.desiredEgress = "client-selection";
  context.renderRoutingDiagnostic(diagnostic);
  assert.match(container.innerHTML, /未分类流量组，由客户端选择/);
  assert.doesNotMatch(container.innerHTML, /目标到达主控后的预期出口/);
  delete diagnostic.aiDomain;
  context.renderRoutingDiagnostic(diagnostic);
  assert.match(container.innerHTML, /未返回 AI 域名分类/);
});

test("publication copy distinguishes Runtime publication from subscription-only, simulation and unknown status", () => {
  const context = {};
  vm.runInNewContext(handler("routingPublicationStatus"), context);
  assert.match(context.routingPublicationStatus({ status: "current" }), /已发布.*不代表客户端/);
  assert.match(context.routingPublicationStatus({ status: "simulated" }), /仅模拟.*未确认/);
  assert.match(context.routingPublicationStatus({ status: "not-required", runtimeMode: "dry-run" }), /仅更新订阅.*无需/);
  assert.match(context.routingPublicationStatus(undefined), /未返回/);
});

test("diagnostic requests run once and cannot render into another login session", async () => {
  const result = { innerHTML: "" }, button = { disabled: false }, renders = [];
  let release, calls = 0;
  const form = { elements: { domain: { value: "custom.ai" } }, querySelector: () => button };
  const context = { document: { querySelector: () => result }, controlPlane: { currentAdmin: { id: "owner-1" } },
    controlPlaneConnection: { generation: 1 }, routingDiagnosisLoading: false, escapeHtml,
    api: () => { calls++; return new Promise(resolve => { release = resolve; }); }, renderRoutingDiagnostic: report => renders.push(report) };
  vm.runInNewContext(handler("diagnoseRouting"), context);
  const event = { preventDefault() {}, currentTarget: form };
  const pending = context.diagnoseRouting(event);
  await context.diagnoseRouting(event);
  assert.equal(calls, 1);
  context.controlPlaneConnection.generation++;
  context.controlPlane.currentAdmin = { id: "owner-2" };
  context.routingDiagnosisLoading = false;
  result.innerHTML = "新会话";
  release({ domain: "custom.ai" });
  await pending;
  assert.deepEqual(renders, []);
  assert.equal(result.innerHTML, "新会话");
});
