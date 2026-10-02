const GIBIBYTE = 1024 ** 3;
const STATE_KEY = "monthly_usage_period";
const TIME_ZONE = "Asia/Shanghai";

export function monthlyUsagePeriod(value) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid usage period clock");
  // Modern Asia/Shanghai uses UTC+08:00 without daylight saving time.
  const local = new Date(instant.getTime() + 8 * 60 * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    timeZone: TIME_ZONE,
    startsAt: new Date(Date.UTC(year, month, 1) - 8 * 60 * 60 * 1000).toISOString(),
    resetsAt: new Date(Date.UTC(year, month + 1, 1) - 8 * 60 * 60 * 1000).toISOString()
  };
}

function periodView(state) {
  return { key: state.key, timeZone: TIME_ZONE, startsAt: state.startsAt, resetsAt: state.resetsAt };
}

export class MonthlyUsagePeriods {
  constructor(db, clock) {
    this.db = db;
    this.clock = clock;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_usage_periods (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          period_key TEXT NOT NULL, kind TEXT NOT NULL,
          starts_at TEXT, resets_at TEXT NOT NULL, used_bytes INTEGER NOT NULL,
          quota_gb REAL, closed_at TEXT NOT NULL,
          PRIMARY KEY(user_id, period_key)
        );
        CREATE TABLE IF NOT EXISTS user_usage_adjustments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          period_key TEXT NOT NULL, before_bytes INTEGER NOT NULL,
          after_bytes INTEGER NOT NULL, delta_bytes INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS user_usage_adjustments_user_period
        ON user_usage_adjustments(user_id, period_key, id);
        CREATE TABLE IF NOT EXISTS monthly_usage_watermarks (
          host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
          user_name TEXT NOT NULL, runtime_instance_id TEXT NOT NULL, period_key TEXT NOT NULL,
          starting_uplink INTEGER NOT NULL, starting_downlink INTEGER NOT NULL,
          uplink_bytes INTEGER NOT NULL, downlink_bytes INTEGER NOT NULL,
          PRIMARY KEY(host_id,user_name,runtime_instance_id,period_key)
        );
      `);
      if (!db.prepare("PRAGMA table_info(users)").all().some(column => column.name === "usage_last_reset_at")) {
        db.exec("ALTER TABLE users ADD COLUMN usage_last_reset_at TEXT");
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  state() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(STATE_KEY);
    return row ? JSON.parse(row.value) : null;
  }

  saveState(state, timestamp) {
    this.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(STATE_KEY, JSON.stringify(state), timestamp);
  }

  status() {
    const state = this.state();
    return { ...periodView(state), activatedAt: state.activatedAt,
      lastResetAt: state.lastResetAt, reconciliationPending: state.reconciliationPending };
  }

  rollover() {
    const timestamp = new Date(this.clock()).toISOString();
    const period = monthlyUsagePeriod(timestamp);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.state();
      if (previous && previous.key >= period.key) {
        this.db.exec("COMMIT");
        return { changed: false, resetUserIds: [], period: periodView(previous), activated: false };
      }
      const users = this.db.prepare("SELECT id,used_bytes,quota_gb FROM users ORDER BY id").all();
      const archive = this.db.prepare(`INSERT INTO user_usage_periods
        (user_id,period_key,kind,starts_at,resets_at,used_bytes,quota_gb,closed_at) VALUES (?,?,?,?,?,?,?,?)`);
      for (const user of users) {
        archive.run(user.id, previous?.key || "legacy", previous ? "monthly" : "legacy",
          previous?.startsAt || null, previous?.resetsAt || timestamp, user.used_bytes, user.quota_gb, timestamp);
      }
      if (!previous && users.length) {
        this.db.exec(`INSERT OR IGNORE INTO monthly_usage_watermarks
          (host_id,user_name,runtime_instance_id,period_key,starting_uplink,starting_downlink,uplink_bytes,downlink_bytes)
          SELECT host_id,user_name,runtime_instance_id,'legacy',0,0,uplink_bytes,downlink_bytes
          FROM usage_counter_checkpoints`);
      }
      this.db.prepare("UPDATE users SET used_bytes=0,used_gb=0,usage_last_reset_at=?,updated_at=?")
        .run(timestamp, timestamp);
      const state = { ...period, activatedAt: previous?.activatedAt || timestamp,
        lastResetAt: previous || users.length ? timestamp : null,
        reconciliationPending: Boolean(previous || users.length),
        legacyActivated: previous?.legacyActivated || (!previous && users.length > 0),
        baselineUnknownCounters: Boolean(previous || users.length) };
      this.saveState(state, timestamp);
      this.db.exec("COMMIT");
      return { changed: true, resetUserIds: users.map(user => user.id), period, activated: !previous };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  acknowledge(periodKey) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.state();
      if (state.key === periodKey) {
        state.reconciliationPending = false;
        this.saveState(state, new Date(this.clock()).toISOString());
      }
      this.db.exec("COMMIT");
      return this.status();
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recordAdjustment(userId, beforeBytes, afterBytes) {
    this.db.prepare(`INSERT INTO user_usage_adjustments
      (user_id,period_key,before_bytes,after_bytes,delta_bytes,created_at) VALUES (?,?,?,?,?,?)`)
      .run(userId, this.state().key, beforeBytes, afterBytes, afterBytes - beforeBytes, new Date(this.clock()).toISOString());
  }

  counterDelta({ hostId, runtimeInstanceId, usage, observedAt, checkpoint, baselineOnly }) {
    const state = this.state();
    const period = state.legacyActivated && observedAt < new Date(state.activatedAt)
      ? { key: "legacy", startsAt: null, resetsAt: state.activatedAt }
      : monthlyUsagePeriod(observedAt);
    const identity = [hostId, usage.userName, runtimeInstanceId];
    const existing = this.db.prepare(`SELECT * FROM monthly_usage_watermarks
      WHERE host_id=? AND user_name=? AND runtime_instance_id=? AND period_key=?`).get(...identity, period.key);
    const otherPeriod = !existing && this.db.prepare(`SELECT 1 FROM monthly_usage_watermarks
      WHERE host_id=? AND user_name=? AND runtime_instance_id=? LIMIT 1`).get(...identity);
    // An unknown InvocationID might be an old offline Runtime, even when this
    // Host has already reported another instance this month. Its first sample
    // cannot safely be billed after a rollover or legacy activation.
    const baseline = baselineOnly || (!existing && (state.baselineUnknownCounters || otherPeriod || checkpoint));
    // Retain a separate watermark for each period. A delayed old-month sample
    // can recover known old usage even after the new month's baseline arrived.
    // Its counters cannot pass the earliest later-period starting watermark.
    const later = this.db.prepare(`SELECT starting_uplink,starting_downlink FROM monthly_usage_watermarks
      WHERE host_id=? AND user_name=? AND runtime_instance_id=? AND period_key <> 'legacy'
        AND (? = 'legacy' OR period_key > ?) ORDER BY period_key LIMIT 1`).get(...identity, period.key, period.key);
    const uplink = Math.max(existing?.uplink_bytes || 0, Math.min(usage.uplinkBytes, later?.starting_uplink ?? Infinity));
    const downlink = Math.max(existing?.downlink_bytes || 0, Math.min(usage.downlinkBytes, later?.starting_downlink ?? Infinity));
    const uplinkDelta = baseline ? 0 : uplink - (existing?.uplink_bytes || 0);
    const downlinkDelta = baseline ? 0 : downlink - (existing?.downlink_bytes || 0);
    this.db.prepare(`INSERT INTO monthly_usage_watermarks
      (host_id,user_name,runtime_instance_id,period_key,starting_uplink,starting_downlink,uplink_bytes,downlink_bytes)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(host_id,user_name,runtime_instance_id,period_key)
      DO UPDATE SET uplink_bytes=excluded.uplink_bytes,downlink_bytes=excluded.downlink_bytes`)
      .run(...identity, period.key, baseline ? uplink : 0, baseline ? downlink : 0, uplink, downlink);
    return { period, current: period.key === state.key, uplinkDelta, downlinkDelta };
  }

  addHistoricalUsage(userId, period, bytes, receivedAt) {
    const before = Number(this.db.prepare("SELECT used_bytes FROM user_usage_periods WHERE user_id=? AND period_key=?")
      .get(userId, period.key)?.used_bytes || 0);
    if (!Number.isSafeInteger(before + bytes)) throw new Error("Historical usage exceeds safe integer range");
    this.db.prepare(`INSERT INTO user_usage_periods
      (user_id,period_key,kind,starts_at,resets_at,used_bytes,quota_gb,closed_at) VALUES (?,?,?,?,?,?,NULL,?)
      ON CONFLICT(user_id,period_key) DO UPDATE SET used_bytes=user_usage_periods.used_bytes+excluded.used_bytes`)
      .run(userId, period.key, period.key === "legacy" ? "legacy" : "monthly", period.startsAt, period.resetsAt, bytes, receivedAt);
  }

  history(user, { limit = 12 } = {}) {
    const boundedLimit = Math.min(120, Math.max(1, Math.trunc(Number(limit) || 12)));
    const state = this.state();
    const entries = [{ user_id: user.id, period_key: state.key, kind: "current", starts_at: state.startsAt,
      resets_at: state.resetsAt, used_bytes: user.used_bytes, quota_gb: user.quota_gb, closed_at: null },
    ...this.db.prepare("SELECT * FROM user_usage_periods WHERE user_id=? ORDER BY closed_at DESC,period_key DESC LIMIT ?")
      .all(user.id, boundedLimit)].slice(0, boundedLimit);
    return entries.map(entry => ({ kind: entry.kind, key: entry.period_key, timeZone: TIME_ZONE,
      startsAt: entry.starts_at, resetsAt: entry.resets_at, usedBytes: Number(entry.used_bytes),
      usedGb: Number(entry.used_bytes) / GIBIBYTE, quotaGb: entry.quota_gb, closedAt: entry.closed_at,
      adjustments: this.db.prepare(`SELECT before_bytes AS beforeBytes,after_bytes AS afterBytes,
        delta_bytes AS deltaBytes,created_at AS createdAt FROM user_usage_adjustments
        WHERE user_id=? AND period_key=? ORDER BY id`).all(user.id, entry.period_key)
    }));
  }
}
