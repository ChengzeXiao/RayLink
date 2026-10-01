import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

// Execute the shipped handlers; only the DOM and network boundaries are substituted.
function handler(name) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf("\nfunction ", start + 1);
  const asyncEnd = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, Math.min(...[end, asyncEnd].filter((index) => index > start)));
}

function userForm() {
  return {
    id: "user-drawer-form",
    dataset: { userId: "" },
    elements: Object.fromEntries(Object.entries({
      name: "Local test", email: "local@example.com", quota: "120",
      nodeGroup: "全部节点", expires: "2030-12-31", usedGb: "0", password: "TestOnly123!"
    }).map(([name, value]) => [name, { value }])),
    querySelector: () => ({ classList: { contains: () => true } })
  };
}

test("a committed user survives bootstrap failure and retry updates rather than creates", async () => {
  const requests = [];
  const context = {
    labelToScope: () => ["all"],
    api: async (path, options) => {
      requests.push({ path, method: options.method });
      return { id: "created-user", name: "Local test", runtimeSync: { status: "published" } };
    },
    loadBootstrap: async () => { throw new Error("bootstrap offline"); }
  };
  vm.runInNewContext(handler("saveUserForm"), context);
  const form = userForm();
  const saved = await context.saveUserForm(form);
  assert.equal(saved.id, "created-user");
  assert.match(saved.refreshWarning, /已保存/);
  assert.equal(form.dataset.userId, "created-user");
  await context.saveUserForm(form);
  assert.deepEqual(requests, [
    { path: "/api/users", method: "POST" },
    { path: "/api/users/created-user", method: "PATCH" }
  ]);
});

test("new user confirmation preserves pending runtime publication", async () => {
  const form = userForm();
  const toasts = [];
  const context = {
    elements: {
      drawerContent: { querySelector: () => form },
      drawerSave: { textContent: "创建用户", disabled: false },
      drawerEyebrow: {}, drawerTitle: {}
    },
    validateDrawerForm: () => true,
    saveUserForm: async () => ({
      id: "created-user", runtimeSync: { status: "pending", message: "用户变更已保存，运行配置发布失败，系统将自动重试" }
    }),
    users: [{ id: "created-user", name: "Local test" }],
    userDrawerMarkup: () => "saved user",
    showToast: (...args) => toasts.push(args)
  };
  vm.runInNewContext(handler("saveDrawer"), context);
  await context.saveDrawer();
  assert.match(toasts[0][0], /等待应用/);
  assert.match(toasts[0][1], /发布失败/);
  assert.equal(context.elements.drawerSave.disabled, false);
});
