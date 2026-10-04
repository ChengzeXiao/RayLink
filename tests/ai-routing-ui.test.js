import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("AI diagnostics display challenges and anonymous evidence without claiming account success", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderAiDiagnosticReport(");
  const end = source.indexOf("async function loadAiDiagnostics(", start);
  assert.ok(start > 0 && end > start);
  const result = { innerHTML: "" };
  const context = {
    document: { querySelector: () => result },
    escapeHtml: (value) => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    report: { checkedAt: new Date().toISOString(), results: [{
      label: "Claude <script>", host: "claude.ai", status: "challenge", httpStatus: 403,
      stage: "http", latencyMs: 12, message: "需要人机验证", checkedAt: new Date().toISOString()
    }] }
  };
  vm.runInNewContext(`${source.slice(start, end)}\nrenderAiDiagnosticReport(report);`, context);
  assert.match(result.innerHTML, /人机验证/);
  assert.match(result.innerHTML, /主控服务器/);
  assert.match(result.innerHTML, /不代表.*账户/);
  assert.match(result.innerHTML, /HTTP 403/);
  assert.doesNotMatch(result.innerHTML, /<script>/);
  assert.match(result.innerHTML, /Claude &lt;script&gt;/);
});
