import assert from "node:assert/strict";
import test from "node:test";
import { buildReadinessReport } from "../server/readiness.js";

const now = new Date("2026-10-01T10:00:00Z");
const fresh = now.toISOString();
function fixture() {
  return { now, runtime: { mode: "systemd", state: "running" },
    hosts: [{ id: "local", name: "private-hostname", address: "sensitive.example.com",
      kind: "local", status: "online", telemetry: { serviceStatus: "running", updatedAt: fresh },
      protocols: [{ type: "shadowsocks", enabled: true, options: { password: "SECRET" } }],
      protocolActivations: [{ type: "shadowsocks", publicCheck: {
        checkedAt: fresh, availability: "available", reachable: true, probe: "sing-box-tools-fetch",
        layers: { port: "passed", handshake: "passed", public: "passed" }
      } }], usageMetering: { supported: true, status: "healthy", lastSampleAt: fresh }
    }],
    deployments: [{ status: "active", rolloutStatus: "complete", config: { secret: "SECRET" },
      targets: [{ hostId: "local", status: "applied" }] }],
    backups: [{ integrity: "ok", createdAt: fresh, path: "/secret/database.sqlite" }],
    routingPolicy: { mode: "smart" }, ruleSets: { available: true, degraded: false }, alerts: [],
    backupVerification: { valid: true }
  };
}

test("readiness reports only observed control-plane health and exports allowlisted evidence", () => {
  const report = buildReadinessReport(fixture());
  assert.equal(report.status, "healthy");
  assert.equal(report.summary.fail, 0);
  assert.ok(report.checks.length >= 6);
  assert.ok(report.limitations.some((text) => /移动网络/.test(text)));
  assert.doesNotMatch(JSON.stringify(report), /SECRET|sensitive\.example|private-hostname|secret\/database/);
});

test("no client entry and missing live backup verification cannot be called healthy", () => {
  const input = fixture();
  input.hosts[0].protocols[0].enabled = false;
  input.backupVerification = null;
  const report = buildReadinessReport(input);
  assert.equal(report.status, "attention");
  assert.equal(report.checks.find((check) => check.id === "client-entry").status, "unknown");
  assert.equal(report.checks.find((check) => check.id === "backup").status, "unknown");
  input.backupVerification = { valid: false };
  assert.equal(buildReadinessReport(input).checks.find((check) => check.id === "backup").status, "fail");
});

test("a failed newer publication takes precedence over the previous active configuration", () => {
  const input = fixture();
  input.deployments.unshift({ status: "failed", createdAt: fresh });
  assert.equal(buildReadinessReport(input).checks.find((check) => check.id === "deployment").status, "fail");
});

test("private socks, http and mixed listeners are not deliverable subscription entries", () => {
  for (const type of ["socks", "http", "mixed"]) {
    const input = fixture();
    input.hosts[0].protocols = [{ enabled: true, type }];
    assert.equal(buildReadinessReport(input).checks.find((check) => check.id === "client-entry").status, "unknown");
  }
});

test("stale protocol/metering evidence and empty target lists never pass readiness", () => {
  const input = fixture();
  input.hosts[0].protocolActivations[0].publicCheck.checkedAt = "2026-09-01T10:00:00Z";
  input.hosts[0].usageMetering.lastSampleAt = "2026-09-01T10:00:00Z";
  input.deployments[0].targets = [];
  const report = buildReadinessReport(input);
  assert.equal(report.status, "attention");
  for (const id of ["host:0:protocol:shadowsocks", "host:0:metering", "deployment"]) {
    assert.notEqual(report.checks.find((check) => check.id === id).status, "pass");
  }
});

test("stopped Runtime, failed target and pending revocation are blockers", () => {
  const input = fixture();
  Object.assign(input.hosts[0], { kind: "remote", lastSeenAt: fresh,
    telemetry: { serviceStatus: "stopped", updatedAt: fresh }, deploymentSync: { critical: true } });
  input.deployments[0].targets[0].status = "failed";
  const report = buildReadinessReport(input);
  assert.equal(report.status, "blocked");
  for (const id of ["host:0:runtime", "host:0:revocation", "deployment"]) {
    assert.equal(report.checks.find((check) => check.id === id).status, "fail");
  }
});

test("dry-run, TCP-only probes and unavailable rule sets cannot establish production readiness", () => {
  const input = fixture();
  input.runtime.mode = "dry-run";
  input.hosts[0].protocolActivations[0].publicCheck.probe = "tcp-connect";
  input.ruleSets.available = false;
  input.backups[0].createdAt = "2026-09-01T00:00:00Z";
  const report = buildReadinessReport(input);
  assert.notEqual(report.status, "healthy");
  for (const id of ["host:0:runtime", "host:0:protocol:shadowsocks", "rule-sets", "backup"]) {
    assert.notEqual(report.checks.find((check) => check.id === id).status, "pass");
  }
});

test("certificate synchronization must be fresh and healthy before readiness passes", () => {
  const input = fixture();
  input.tlsRenewal = { status: "error", checkedAt: fresh, certificates: [{ domain: "private-node.example", validTo: "2026-10-26" }] };
  assert.equal(buildReadinessReport(input).checks.find((item) => item.id === "tls-renewal").status, "fail");
  input.tlsRenewal.status = "healthy";
  assert.equal(buildReadinessReport(input).checks.find((item) => item.id === "tls-renewal").status, "pass");
  input.tlsRenewal.checkedAt = "2026-09-01T00:00:00Z";
  const stale = buildReadinessReport(input);
  assert.equal(stale.checks.find((item) => item.id === "tls-renewal").status, "warning");
  assert.doesNotMatch(JSON.stringify(stale), /private-node/);
});
