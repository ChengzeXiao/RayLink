import assert from "node:assert/strict";
import test from "node:test";

import { evaluateOperationalAlerts } from "../server/alerts.js";

test("a fresh Node heartbeat does not hide a stopped remote Runtime", () => {
  const now = new Date();
  const alerts = evaluateOperationalAlerts({ now, hosts: [{
    id: "remote-1", name: "Remote", kind: "remote", status: "online",
    lastSeenAt: now.toISOString(),
    telemetry: { updatedAt: now.toISOString(), serviceStatus: "stopped" }
  }] });
  assert.ok(alerts.some((alert) => alert.code === "HOST_OFFLINE" && alert.resourceId === "remote-1"));
});

test("operational alerts cover rollout, offline nodes, protocol health, memory and backups", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const alerts = evaluateOperationalAlerts({
    now,
    hosts: [
      {
        id: "local",
        name: "Control Plane",
        telemetry: {
          serviceStatus: "running",
          memoryUsedBytes: 950,
          memoryTotalBytes: 1_000,
          diskUsedBytes: 950,
          diskTotalBytes: 1_000,
          updatedAt: "2026-07-30T11:59:55.000Z"
        },
        usageMetering: { status: "healthy" },
        protocolActivations: []
      },
      {
        id: "sg-01",
        name: "Singapore",
        kind: "remote",
        status: "offline",
        lastSeenAt: "2026-07-30T11:55:00.000Z",
        telemetry: { serviceStatus: "unknown", updatedAt: "2026-07-30T11:55:00.000Z" },
        usageMetering: { status: "stale" },
        protocolActivations: [{
          type: "tuic",
          publicCheck: {
            availability: "unavailable",
            consecutiveFailures: 3,
            checkedAt: "2026-07-30T11:58:00.000Z"
          }
        }]
      }
    ],
    deployments: [{
      id: "deployment-1",
      version: "v1",
      status: "active",
      rolloutStatus: "failed",
      createdAt: "2026-07-30T11:45:00.000Z",
      targets: [{
        hostId: "sg-01",
        certificates: [{
          name: "raylink-hysteria2",
          validTo: "2026-08-05T12:00:00.000Z"
        }]
      }]
    }],
    backups: [{
      filename: "raylink-old.sqlite",
      createdAt: "2026-07-28T00:00:00.000Z",
      integrity: "ok"
    }]
  });

  assert.deepEqual(
    new Set(alerts.map((alert) => alert.code)),
    new Set([
      "DEPLOYMENT_TARGET_FAILED",
      "HOST_MEMORY_CRITICAL",
      "HOST_DISK_CRITICAL",
      "HOST_OFFLINE",
      "USAGE_METERING_STALE",
      "PROTOCOL_UNAVAILABLE",
      "CERTIFICATE_EXPIRING"
    ])
  );
  assert.ok(alerts.every((alert) => alert.id && alert.title && alert.createdAt));
});

test("old verified backups do not alert while failed integrity still does", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");
  const validAlerts = evaluateOperationalAlerts({
    now,
    backups: [{
      filename: "raylink-old.sqlite",
      createdAt: "2026-07-28T00:00:00.000Z",
      integrity: "ok"
    }]
  });
  assert.ok(!validAlerts.some((alert) => alert.resourceType === "backup"));

  const invalidAlerts = evaluateOperationalAlerts({
    now,
    backups: [{
      filename: "raylink-invalid.sqlite",
      createdAt: "2026-07-30T11:00:00.000Z",
      integrity: "failed"
    }]
  });
  assert.deepEqual(
    invalidAlerts.map(({ code, title, message }) => ({ code, title, message })),
    [{
      code: "BACKUP_INVALID",
      title: "数据库备份未通过校验",
      message: "最近一次备份没有通过 SQLite 完整性检查。"
    }]
  );
});

test("healthy infrastructure produces no operational alerts", () => {
  const alerts = evaluateOperationalAlerts({
    now: new Date("2026-07-30T12:00:00.000Z"),
    hosts: [{
      id: "local",
      name: "Control Plane",
      status: "online",
      telemetry: {
        serviceStatus: "running",
        memoryUsedBytes: 500,
        memoryTotalBytes: 1_000,
        diskUsedBytes: 500,
        diskTotalBytes: 1_000,
        updatedAt: "2026-07-30T11:59:55.000Z"
      },
      usageMetering: { status: "healthy" },
      protocolActivations: [{
        type: "vless",
        publicCheck: { availability: "available", consecutiveFailures: 0 }
      }]
    }],
    deployments: [{
      id: "deployment-1",
      status: "active",
      rolloutStatus: "complete",
      createdAt: "2026-07-30T11:45:00.000Z",
      targets: [{
        hostId: "local",
        certificates: [{
          name: "raylink-trojan",
          validTo: "2026-10-30T12:00:00.000Z"
        }]
      }]
    }],
    backups: [{
      filename: "raylink-current.sqlite",
      createdAt: "2026-07-30T11:00:00.000Z",
      integrity: "ok"
    }]
  });
  assert.deepEqual(alerts, []);
});
