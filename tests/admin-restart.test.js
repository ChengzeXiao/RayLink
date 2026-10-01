import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

const initialPassword = "restart-initial-password";
const changedPassword = "restart-changed-password";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-admin-restart-"));
  const options = {
    dbPath: join(directory, "store.db"),
    adminUsername: "initial-admin",
    adminPassword: initialPassword,
    seedDemoData: false
  };
  let store = new RayLinkStore(options);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get store() { return store; },
    reopen(overrides = {}) {
      store.close();
      store = new RayLinkStore({ ...options, ...overrides });
    }
  };
}

test("restarting with bootstrap credentials does not restore a renamed administrator or its old password", async (t) => {
  const f = await fixture(t);
  const identity = await f.store.authenticateAdmin("initial-admin", initialPassword);
  assert.ok(identity);
  await f.store.changeAdminAccount(identity.id, { currentPassword: initialPassword, username: "renamed-admin" });
  await f.store.changeAdminAccount(identity.id, { currentPassword: initialPassword, newPassword: changedPassword }, { changePassword: true });

  f.reopen();

  assert.equal(await f.store.authenticateAdmin("initial-admin", initialPassword), null);
  assert.equal(await f.store.authenticateAdmin("renamed-admin", initialPassword), null);
  assert.deepEqual(await f.store.authenticateAdmin("renamed-admin", changedPassword), {
    id: identity.id, username: "renamed-admin", role: "owner"
  });
  assert.equal(f.store.listAdmins().length, 1);
});

test("an empty database initializes exactly one owner and preserves that identity on restart", async (t) => {
  const f = await fixture(t);
  const admins = f.store.listAdmins();
  assert.equal(admins.length, 1);
  const identity = { id: admins[0].id, username: "initial-admin", role: "owner" };
  assert.deepEqual(await f.store.authenticateAdmin("initial-admin", initialPassword), identity);

  f.reopen();

  assert.deepEqual(f.store.listAdmins(), admins);
  assert.deepEqual(await f.store.authenticateAdmin("initial-admin", initialPassword), identity);
});

test("changed startup credentials cannot add an owner or change existing administrator roles", async (t) => {
  const f = await fixture(t);
  const initial = f.store.listAdmins()[0];
  f.store.createAdmin({ username: "retained-owner", password: changedPassword, role: "owner" });
  f.store.updateAdmin(initial.id, { role: "auditor", password: changedPassword });
  const admins = f.store.listAdmins();

  f.reopen({ adminUsername: "new-startup-admin", adminPassword: "new-startup-password" });

  assert.deepEqual(f.store.listAdmins(), admins);
  assert.equal(await f.store.authenticateAdmin("new-startup-admin", "new-startup-password"), null);
  assert.equal(await f.store.authenticateAdmin("initial-admin", initialPassword), null);
  assert.deepEqual(await f.store.authenticateAdmin("initial-admin", changedPassword), {
    id: initial.id, username: "initial-admin", role: "auditor"
  });
  assert.equal((await f.store.authenticateAdmin("retained-owner", changedPassword)).role, "owner");
});
