import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const handlers = source.slice(source.indexOf("async function publishConfig()"), source.indexOf("function maintenanceSessionIsCurrent("));

function fixture({ failMutation = false, failRefresh = true } = {}) {
  const node = () => ({ disabled: false, className: "", innerHTML: "", textContent: "", dataset: {}, querySelector: () => ({ innerHTML: "" }) });
  const publish = node(), rollback = node(), badge = node(), trail = [node(), node(), node()];
  rollback.dataset.deploymentId = "historical-id";
  const calls = [], toasts = [];
  const context = vm.createContext({ document: {
    querySelector: selector => selector === "#publish-config" ? publish : selector === "#rollback-config" ? rollback : badge,
    querySelectorAll: selector => selector === "#publish-trail li" ? trail : []
  }, icon: () => "", showToast: (...args) => toasts.push(args),
  api: async (path, options) => {
    calls.push({ path, method: options.method });
    if (failMutation && !path.endsWith("preview")) throw new Error("mutation failed");
    return { id: "committed-id", version: "committed-version", eligibleUsers: 1, inboundCount: 1 };
  }, loadBootstrap: async () => { if (failRefresh) throw new Error("refresh offline"); } });
  vm.runInContext(`let publishInProgress = false;\n${handlers}`, context);
  return { context, publish, rollback, badge, calls, toasts };
}

for (const action of ["publishConfig", "rollbackConfig"]) {
  test(`${action}: a committed deployment is not reported as failed when refresh fails`, async () => {
    const { context, publish, badge, calls, toasts } = fixture();
    await vm.runInContext(`${action}()`, context);
    assert.ok(toasts.some(([title, message]) => /已发布|回滚已生效|已提交/.test(title) && /刷新/.test(message)));
    assert.ok(!toasts.some(([title]) => /发布失败|回滚失败/.test(title)));
    assert.ok(!toasts.some(([title]) => /已生效/.test(title)), "a refresh failure cannot confirm every Host applied the deployment");
    assert.ok(!publish.innerHTML.includes("重试发布"));
    assert.ok(!badge.innerHTML.includes("发布失败"));
    assert.equal(calls.filter(call => !call.path.endsWith("preview")).length, 1);
  });

  test(`${action}: mutation failures remain failures`, async () => {
    const { context, toasts } = fixture({ failMutation: true });
    await vm.runInContext(`${action}()`, context);
    assert.ok(toasts.some(([title]) => /发布失败|回滚失败/.test(title)));
  });
}
