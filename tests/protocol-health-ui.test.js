import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../web/protocol-health.js", import.meta.url),
  "utf8"
);

function loadPresenter(now = "2026-07-28T12:20:00.000Z") {
  class Clock extends Date { static now() { return new Date(now).getTime(); } }
  const context = { window: {}, Intl, Date: Clock };
  vm.runInNewContext(source, context);
  return context.window.RayLinkProtocolHealth;
}

test("missing metrics are unknown rather than fabricated zero latency or success", () => {
  const result = loadPresenter().present({ publicCheck: {
    checkedAt: "2026-07-28T12:19:49.365Z", reachable: true, availability: "available",
    latencyMs: null, jitterMs: null, p95Ms: null, healthWindow: { successRate: null }
  } });
  assert.equal(result.latencyLabel, "—");
  assert.equal(result.jitterLabel, "—");
  assert.equal(result.p95Label, "—");
  assert.equal(result.rollingAvailabilityLabel, "—");
  assert.equal(result.availabilityLabel, "可用");
  assert.notEqual(result.className, "good");
});

test("stale, invalid and future health evidence cannot be shown as current availability", () => {
  for (const checkedAt of ["2026-07-28T12:00:00Z", "invalid", "2026-07-29T12:00:00Z"]) {
    const result = loadPresenter().present({ publicCheck: { checkedAt, reachable: true,
      availability: "available", latencyMs: 20 } });
    assert.equal(result.availabilityLabel, "待复检");
    assert.equal(result.className, "warning");
  }
});

test("protocol health presentation exposes availability, connection time, jitter and check time", () => {
  const presenter = loadPresenter();
  const result = presenter.present({
    publicCheck: {
      availability: "available",
      reachable: true,
      latencyMs: 128,
      p95Ms: 166,
      jitterMs: 14,
      samples: { count: 5, successful: 5 },
      healthWindow: { successRate: 98.4 },
      layers: { port: "passed", handshake: "passed", public: "passed" },
      checkedAt: "2026-07-28T12:19:49.365Z"
    }
  });

  assert.equal(result.availabilityLabel, "可用");
  assert.equal(result.latencyLabel, "128 ms");
  assert.equal(result.p95Label, "166 ms");
  assert.equal(result.jitterLabel, "14 ms");
  assert.equal(result.availabilityRateLabel, "100%");
  assert.equal(result.rollingAvailabilityLabel, "98.4%");
  assert.match(result.summary, /连接耗时 128 ms/);
  assert.match(result.summary, /P95 166 ms/);
  assert.match(result.summary, /抖动 14 ms/);
  assert.match(result.summary, /本轮成功率 100%/);
  assert.match(result.summary, /窗口成功率 98.4%/);
  assert.match(result.summary, /端口 通过 · 协议握手 通过 · 公网访问 通过/);
  assert.match(result.summary, /最近检测/);
});

test("a partially successful round is presented as quality degradation", () => {
  const presenter = loadPresenter();
  const result = presenter.present({
    publicCheck: {
      availability: "degraded",
      reachable: true,
      latencyMs: 95,
      p95Ms: 180,
      jitterMs: 28,
      consecutiveFailures: 0,
      samples: { count: 5, successful: 4 },
      healthWindow: { successRate: 80 },
      checkedAt: "2026-07-28T12:19:49.365Z"
    }
  });

  assert.equal(result.label, "质量降级");
  assert.equal(result.availabilityLabel, "质量降级");
  assert.equal(result.className, "warning");
  assert.match(result.summary, /本轮成功率 80%/);
  assert.match(result.summary, /窗口成功率 80%/);
});

test("protocol health presentation shows a pending recheck before the third failure", () => {
  const presenter = loadPresenter();
  const result = presenter.present({
    publicCheck: {
      availability: "degraded",
      reachable: true,
      latencyMs: 88,
      jitterMs: 7,
      consecutiveFailures: 2,
      checkedAt: "2026-07-28T12:19:49.365Z",
      lastSuccessAt: "2026-07-28T12:00:00.000Z",
      error: "connection timed out"
    }
  });

  assert.equal(result.label, "复检 2/3");
  assert.equal(result.availabilityLabel, "复检中");
  assert.equal(result.className, "warning");
  assert.match(result.summary, /最近成功 88 ms/);
  assert.doesNotMatch(result.summary, /^超时/);
});

test("legacy one-shot timeouts enter the first recheck instead of fabricating three failures", () => {
  const presenter = loadPresenter();
  const result = presenter.present({
    publicCheck: {
      reachable: false,
      checkedAt: "2026-07-28T12:19:49.365Z",
      error: "connection timed out"
    }
  });

  assert.equal(result.label, "复检 1/3");
  assert.equal(result.availabilityLabel, "复检中");
  assert.doesNotMatch(result.summary, /连续失败 3\/3/);
});

test("confirmed timeout keeps last jitter visible and slow availability is never dangerous", () => {
  const presenter = loadPresenter();
  const unavailable = presenter.present({
    publicCheck: {
      availability: "unavailable",
      reachable: false,
      latencyMs: 188,
      jitterMs: 31,
      consecutiveFailures: 3,
      checkedAt: "2026-07-28T12:19:49.365Z",
      error: "connection timed out"
    }
  });
  const slow = presenter.present({
    publicCheck: {
      availability: "available",
      reachable: true,
      latencyMs: 480,
      jitterMs: 22,
      checkedAt: "2026-07-28T12:19:49.365Z"
    }
  });

  assert.match(unavailable.summary, /抖动 31 ms/);
  assert.equal(unavailable.className, "danger");
  assert.equal(slow.availabilityLabel, "可用");
  assert.equal(slow.className, "warning");
});
