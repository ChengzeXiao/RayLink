import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RayLinkStore } from "../server/database.js";

async function fixture(t, instant = "2026-10-31T15:59:59.999Z") {
  const directory = await mkdtemp(join(tmpdir(), "raylink-monthly-"));
  let clock = instant;
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "monthly-test-password",
    seedDemoData: false, clock: () => new Date(clock) };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, options, setTime(value) { clock = value; },
    reopen(prepare) { store.close(); prepare?.(options.dbPath); store = new RayLinkStore(options); } };
}

function createUser(store, overrides = {}) {
  return store.createUser({ name: "Monthly User", email: "monthly@example.test", quotaGb: 10,
    nodeScope: ["all"], portalStatus: "active", expiresAt: "2099-12-31", ...overrides });
}

let sampleSequence = 0;
function sample(f, user, bytes, { runtime = "runtime-a", observedAt, host = "local", sampleId } = {}) {
  return f.store.recordUsageSnapshot(host, { sampleId: sampleId || `monthly-sample-${++sampleSequence}`,
    runtimeInstanceId: runtime, observedAt, users: [{ name: user.email, uplinkBytes: 0, downlinkBytes: bytes }] });
}

test("Shanghai month boundary archives usage exactly once and preserves disabled entitlements", async t => {
  const f = await fixture(t);
  const user = createUser(f.store, { usedGb: 2, state: "disabled", expiresAt: "2020-01-01" });
  assert.equal(f.store.getUser(user.id).usedGb, 2);
  assert.equal(f.store.rolloverUsagePeriods().changed, false);
  f.setTime("2026-10-31T16:00:00.000Z");
  const result = f.store.rolloverUsagePeriods();
  assert.deepEqual(result.period, { key: "2026-11", timeZone: "Asia/Shanghai", startsAt: "2026-10-31T16:00:00.000Z", resetsAt: "2026-11-30T16:00:00.000Z" });
  assert.deepEqual(result.resetUserIds, [user.id]);
  assert.equal(result.changed, true);
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.equal(f.store.getUser(user.id).state, "disabled");
  assert.equal(f.store.getUser(user.id).expiresAt, "2020-01-01");
  assert.equal(f.store.getUser(user.id).usagePeriod.lastResetAt, "2026-10-31T16:00:00.000Z");
  assert.equal(f.store.userUsageHistory(user.id).find(entry => entry.key === "2026-10").usedGb, 2);
  assert.equal(f.store.usagePeriodStatus().reconciliationPending, true);
  f.reopen();
  assert.equal(f.store.rolloverUsagePeriods().changed, false);
  assert.equal(f.store.usagePeriodStatus().reconciliationPending, true);
  f.store.acknowledgeUsagePeriodSync("2026-10");
  assert.equal(f.store.usagePeriodStatus().reconciliationPending, true);
  f.store.acknowledgeUsagePeriodSync("2026-11");
  assert.equal(f.store.usagePeriodStatus().reconciliationPending, false);
});

test("legacy activation archives existing totals before clearing them and preserves credentials", async t => {
  const f = await fixture(t, "2026-10-10T03:00:00.000Z");
  const user = createUser(f.store, { usedGb: 3 });
  const credential = f.store.clientCredential(user.id);
  const subscription = f.store.rotateUserSubscription(user.id);
  // Recreate the previous version's absence of monthly bookkeeping as migration input.
  f.reopen(dbPath => {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("DELETE FROM settings WHERE key='monthly_usage_period'; DROP TABLE user_usage_periods; DROP TABLE user_usage_adjustments;");
    legacy.close();
  });
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.equal(f.store.usagePeriodStatus().reconciliationPending, true);
  const archive = f.store.userUsageHistory(user.id).find(entry => entry.kind === "legacy");
  assert.equal(archive.usedGb, 3);
  assert.equal(archive.startsAt, null);
  assert.deepEqual(f.store.clientCredential(user.id), { ...credential, usedGb: 0 });
  assert.equal(f.store.currentUserSubscription(user.id).secret, subscription.secret);
  f.reopen();
  assert.equal(f.store.userUsageHistory(user.id).filter(entry => entry.kind === "legacy").length, 1);
});

test("manual usage adjustments stay in their period and stale period edits cannot undo a rollover", async t => {
  const f = await fixture(t);
  const user = createUser(f.store, { usedGb: 2 });
  f.store.updateUser(user.id, { usedGb: 0, usagePeriodKey: "2026-10" });
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.deepEqual(f.store.userUsageHistory(user.id)[0].adjustments.map(entry => [entry.beforeBytes, entry.afterBytes]), [[2147483648, 0]]);
  f.setTime("2026-10-31T16:00:00.000Z");
  assert.throws(() => f.store.updateUser(user.id, { name: "Stale edit", usedGb: 2, usagePeriodKey: "2026-10" }),
    error => error.code === "USAGE_PERIOD_CHANGED" && error.statusCode === 409);
  assert.equal(f.store.getUser(user.id).name, "Monthly User");
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  const old = f.store.userUsageHistory(user.id).find(entry => entry.key === "2026-10");
  assert.equal(old.adjustments.length, 1);
  f.store.updateUser(user.id, { usedGb: 1 });
  assert.equal(f.store.userUsageHistory(user.id)[0].adjustments[0].afterBytes, 1073741824);
});

test("late old-month counters update history after a new-month baseline without charging the new allowance", async t => {
  const f = await fixture(t, "2026-10-31T15:58:00.000Z");
  const user = createUser(f.store);
  assert.equal(sample(f, user, 100).appliedBytes, 100);
  f.setTime("2026-10-31T16:01:00.000Z");
  assert.equal(sample(f, user, 200).appliedBytes, 0, "cross-month cumulative bytes cannot all be attributed to the new month");
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.equal(sample(f, user, 150, { observedAt: "2026-10-31T15:59:00.000Z" }).appliedBytes, 50);
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.equal(f.store.userUsageHistory(user.id).find(entry => entry.key === "2026-10").usedBytes, 150);
  assert.equal(sample(f, user, 250).appliedBytes, 50);
  assert.equal(sample(f, user, 150, { observedAt: "2026-10-31T15:59:00.000Z" }).appliedBytes, 0);
  assert.equal(f.store.getUser(user.id).usedGb * 1024 ** 3, 50);
  f.store.updateUser(user.id, { usedGb: 0 });
  assert.equal(sample(f, user, 280).appliedBytes, 30);
  assert.equal(f.store.getUser(user.id).usedGb * 1024 ** 3, 30);
});

test("unknown old Runtime instances remain conservative after another instance already reported this month", async t => {
  const f = await fixture(t);
  const user = createUser(f.store);
  sample(f, user, 100);
  const { host } = f.store.createRemoteHost({ name: "Other Host", address: "192.0.2.4", region: "hk" });
  sample(f, user, 300, { host: host.id });
  f.setTime("2026-10-31T16:01:00.000Z");
  assert.equal(sample(f, user, 500).appliedBytes, 0);
  assert.equal(sample(f, user, 520).appliedBytes, 20);
  assert.equal(sample(f, user, 400, { host: host.id }).appliedBytes, 0);
  assert.equal(sample(f, user, 430, { host: host.id }).appliedBytes, 30);
  assert.equal(sample(f, user, 200, { runtime: "runtime-new" }).appliedBytes, 0);
  assert.equal(sample(f, user, 250, { runtime: "runtime-new" }).appliedBytes, 50);
  assert.equal(sample(f, user, 9000, { runtime: "runtime-offline-old" }).appliedBytes, 0);
  assert.equal(sample(f, user, 9010, { runtime: "runtime-offline-old", sampleId: "monthly-duplicate" }).appliedBytes, 10);
  assert.equal(sample(f, user, 9010, { runtime: "runtime-offline-old", sampleId: "monthly-duplicate" }).duplicate, true);
  assert.equal(sample(f, user, 8000, { runtime: "runtime-offline-old" }).appliedBytes, 0);
  f.reopen();
  assert.equal(sample(f, user, 9020, { runtime: "runtime-offline-old" }).appliedBytes, 10);
  assert.equal(f.store.getUser(user.id).usedGb * 1024 ** 3, 120);
});

test("future-month observations never advance the period or consume either allowance", async t => {
  const f = await fixture(t);
  const user = createUser(f.store, { usedGb: 1 });
  assert.throws(() => sample(f, user, 200, { observedAt: "2026-10-31T16:00:00.001Z" }),
    error => error.code === "FUTURE_USAGE_PERIOD");
  assert.equal(f.store.usagePeriodStatus().key, "2026-10");
  assert.equal(f.store.getUser(user.id).usedGb, 1);
  assert.equal(f.store.userUsageHistory(user.id).length, 1);
});

test("calendar rollover handles leap February, year boundaries, downtime and clock rollback", async t => {
  const f = await fixture(t, "2028-02-01T00:00:00.000Z");
  const user = createUser(f.store, { usedGb: 1 });
  assert.equal(f.store.usagePeriodStatus().startsAt, "2028-01-31T16:00:00.000Z");
  assert.equal(f.store.usagePeriodStatus().resetsAt, "2028-02-29T16:00:00.000Z");
  f.setTime("2028-02-29T15:59:59.999Z");
  assert.equal(f.store.rolloverUsagePeriods().changed, false);
  f.setTime("2028-02-29T16:00:00.000Z");
  assert.equal(f.store.rolloverUsagePeriods().period.key, "2028-03");
  f.store.updateUser(user.id, { usedGb: 2 });
  f.setTime("2029-01-01T00:00:00.000Z");
  f.reopen();
  assert.equal(f.store.usagePeriodStatus().startsAt, "2028-12-31T16:00:00.000Z");
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.equal(f.store.userUsageHistory(user.id).find(entry => entry.key === "2028-03").usedGb, 2);
  assert.equal(f.store.userUsageHistory(user.id).find(entry => entry.key === "2028-02").usedGb, 1);
  f.store.updateUser(user.id, { usedGb: 3 });
  f.setTime("2028-12-30T00:00:00.000Z");
  assert.equal(f.store.rolloverUsagePeriods().changed, false);
  assert.equal(f.store.usagePeriodStatus().key, "2029-01");
  assert.equal(f.store.getUser(user.id).usedGb, 3);
});

test("legacy counters establish a fresh baseline and delayed pre-activation traffic stays archived", async t => {
  const f = await fixture(t, "2026-10-10T10:00:00.000Z");
  const user = createUser(f.store, { usedGb: 1 });
  sample(f, user, 100);
  f.setTime("2026-10-10T10:01:00.000Z");
  f.reopen(dbPath => {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("DELETE FROM settings WHERE key='monthly_usage_period'; DROP TABLE monthly_usage_watermarks; DROP TABLE user_usage_periods; DROP TABLE user_usage_adjustments;");
    legacy.close();
  });
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.equal(sample(f, user, 500).appliedBytes, 0);
  assert.equal(sample(f, user, 200, { observedAt: "2026-10-10T10:00:30.000Z" }).appliedBytes, 100);
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.equal(f.store.userUsageHistory(user.id).find(entry => entry.key === "legacy").usedBytes, 1073742024);
  assert.equal(sample(f, user, 530).appliedBytes, 30);
  assert.equal(f.store.getUser(user.id).usedGb * 1024 ** 3, 30);
});

test("adjusting usage and resetting the portal password remains one successful user update", async t => {
  const f = await fixture(t);
  const user = createUser(f.store, { usedGb: 1 });
  f.store.updateUser(user.id, { usedGb: 0, password: "replacement-password" });
  assert.equal(f.store.getUser(user.id).usedGb, 0);
  assert.equal((await f.store.authenticateUser(user.email, "replacement-password")).id, user.id);
  assert.equal(f.store.userUsageHistory(user.id)[0].adjustments[0].afterBytes, 0);
});

test("two control-plane connections cannot archive or reset the same period twice", async t => {
  const f = await fixture(t);
  const user = createUser(f.store, { usedGb: 1 });
  const second = new RayLinkStore(f.options);
  try {
    f.setTime("2026-10-31T16:00:00.000Z");
    assert.equal(f.store.rolloverUsagePeriods().changed, true);
    assert.equal(second.rolloverUsagePeriods().changed, false);
    second.updateUser(user.id, { usedGb: 2 });
    assert.equal(f.store.rolloverUsagePeriods().changed, false);
    assert.equal(f.store.getUser(user.id).usedGb, 2);
    assert.equal(f.store.userUsageHistory(user.id).filter(entry => entry.key === "2026-10").length, 1);
  } finally { second.close(); }
});
