import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Authorized browser-handler seam: real shipped form handler, DOM/HTTP boundaries only.
const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function handler(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `Missing shipped handler ${name}`);
  const end = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1)].filter(value => value > start);
  return source.slice(start, Math.min(...end));
}
function setup({ mode = "password", confirm = "new-password-123", error } = {}) {
  const requests = []; const errors = [];
  const form = { id: `account-${mode}-form`, dataset: {}, isConnected: true, elements: Object.fromEntries(Object.entries({ currentPassword: "old-password-123", newPassword: "new-password-123", confirmPassword: confirm, username: "new-admin" }).map(([key, value]) => [key, { value }])) };
  let cleared = false; let loggedOut = false;
  const context = {
    controlPlane: { currentAdmin: { id: "admin-1", username: "old-admin", role: "auditor" } },
    elements: { drawerSave: { disabled: false, textContent: "保存并重新登录" }, authError: { textContent: "" }, authForm: { elements: { username: { value: "" } } } },
    api: async (path, options) => { requests.push({ path, method: options.method, body: JSON.parse(options.body) }); if (error) throw error; return {}; },
    clearPersonalAccountSecrets: () => { cleared = true; },
    showAdminLogin: () => { loggedOut = true; },
    showDrawerFormError: (_form, error) => errors.push(error.message)
  };
  vm.runInNewContext(handler("savePersonalAccountForm"), context);
  return { form, context, requests, errors, cleared: () => cleared, loggedOut: () => loggedOut };
}

test("every admin can change their password and must sign in again after credentials are cleared", async () => {
  const run = setup();
  await run.context.savePersonalAccountForm(run.form);
  assert.deepEqual(run.requests, [{ path: "/api/account/password", method: "POST", body: { currentPassword: "old-password-123", newPassword: "new-password-123" } }]);
  assert.equal(run.cleared(), true);
  assert.equal(run.loggedOut(), true);
  assert.equal(run.context.elements.authForm.elements.username.value, "old-admin");
  assert.match(run.context.elements.authError.textContent, /MCP Token/);
});

test("password confirmation mismatch never sends a credential change", async () => {
  const run = setup({ confirm: "different-confirmation" });
  await run.context.savePersonalAccountForm(run.form);
  assert.equal(run.requests.length, 0);
  assert.equal(run.loggedOut(), false);
  assert.match(run.errors[0], /不一致/);
});

test("username change submits only profile fields and pre-fills the new login name", async () => {
  const run = setup({ mode: "profile" });
  await run.context.savePersonalAccountForm(run.form);
  assert.deepEqual(run.requests, [{ path: "/api/account/profile", method: "PATCH", body: { currentPassword: "old-password-123", username: "new-admin" } }]);
  assert.equal(run.context.elements.authForm.elements.username.value, "new-admin");
  assert.equal(run.loggedOut(), true);
});

test("incorrect current password remains an actionable inline error without ending the session", async () => {
  const run = setup({ error: Object.assign(new Error("当前密码不正确"), { status: 403, code: "CURRENT_PASSWORD_INVALID" }) });
  await run.context.savePersonalAccountForm(run.form);
  assert.equal(run.loggedOut(), false);
  assert.equal(run.cleared(), false);
  assert.deepEqual(run.errors, ["当前密码不正确"]);
  assert.equal(run.context.elements.drawerSave.disabled, false);
});

test("owner can rename another administrator without resetting their password", async () => {
  const requests = [];
  const fields = { "[data-admin-username]": { value: "renamed-admin" }, "[data-admin-password]": { value: "" }, "[data-admin-role]": { value: "support" }, "[data-save-admin]": { disabled: false } };
  const context = { CSS: { escape: value => value }, document: { querySelector: () => ({ querySelector: selector => fields[selector] }) }, controlPlane: { currentAdmin: { id: "owner", username: "owner" } }, api: async (path, options) => requests.push({ path, body: JSON.parse(options.body) }), loadBootstrap: async () => {}, showToast() {} };
  vm.runInNewContext(handler("saveAdministrator"), context);
  await context.saveAdministrator("other-admin");
  assert.deepEqual(requests, [{ path: "/api/admins/other-admin", body: { username: "renamed-admin", role: "support" } }]);
});

test("owner role edit never bypasses current-password verification through the administrator list", async () => {
  const requests = [];
  const fields = { "[data-admin-username]": { value: "owner" }, "[data-admin-password]": { value: "" }, "[data-admin-role]": { value: "owner" }, "[data-save-admin]": { disabled: false } };
  const context = { CSS: { escape: value => value }, document: { querySelector: () => ({ querySelector: selector => fields[selector] }) }, controlPlane: { currentAdmin: { id: "owner", username: "owner" } }, api: async (path, options) => requests.push(JSON.parse(options.body)), loadBootstrap: async () => {}, showToast() {} };
  vm.runInNewContext(handler("saveAdministrator"), context);
  await context.saveAdministrator("owner");
  assert.deepEqual(requests, [{ role: "owner" }]);
});

test("password confirmation feedback is attached to the personal account form", async () => {
  const run = setup({ confirm: "mismatch" });
  let visibleMessage;
  run.form.querySelector = () => null;
  run.form.prepend = message => { visibleMessage = message; };
  run.context.document = { createElement: () => ({ dataset: {}, classList: { add() {} } }) };
  const start = source.indexOf("function showDrawerFormError(");
  const end = source.indexOf("\nasync function ", start);
  vm.runInNewContext(source.slice(start, end), run.context);
  await run.context.savePersonalAccountForm(run.form);
  assert.match(visibleMessage?.textContent || "", /不一致/);
});
