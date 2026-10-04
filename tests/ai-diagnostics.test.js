import assert from "node:assert/strict";
import test from "node:test";

import { AI_DIAGNOSTIC_SERVICES, AiServiceDiagnostics } from "../server/routing/ai-diagnostics.js";

const publicProbe = (request = async () => ({ httpStatus: 200 })) => ({
  resolve: async () => [{ address: "1.1.1.1", family: 4 }],
  request
});

test("AI diagnostics separates a website challenge from API authentication and scopes evidence to the control plane", async () => {
  const diagnostics = new AiServiceDiagnostics({ probe: publicProbe(async ({ url }) => (
    url.hostname === "claude.ai"
      ? { httpStatus: 403, headers: { "cf-mitigated": "challenge" }, body: "private challenge body" }
      : { httpStatus: 401, body: "sensitive API response", remoteAddress: "1.1.1.1" }
  )) });
  assert.equal(diagnostics.snapshot(), null);
  const report = await diagnostics.run({ service: "claude" });
  assert.equal(report.service, "claude");
  assert.equal(report.source, "control-plane-egress");
  assert.equal(report.clientMeasured, false);
  assert.equal(report.authenticated, false);
  assert.deepEqual(report.results.map(({ host, status }) => [host, status]), [
    ["claude.ai", "challenge"], ["api.anthropic.com", "authentication_required"]
  ]);
  assert.equal(report.results[1].remoteAddress, "1.1.1.1");
  assert.match(report.limitations.join(" "), /客户端|协议/);
  assert.doesNotMatch(JSON.stringify(report), /private challenge body|sensitive API response|cf-mitigated/);
  assert.deepEqual(diagnostics.snapshot(), report);
  assert.deepEqual(AI_DIAGNOSTIC_SERVICES.map(({ id }) => id), ["claude", "openai", "gemini", "copilot", "perplexity", "grok"]);
});

test("AI diagnostics rejects arbitrary destinations and DNS answers that could reach private or reserved networks", async () => {
  let connections = 0;
  const blockedAddresses = [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "fc00::1", "fe80::1", "fe80::1%lo0", "::ffff:127.0.0.1", "64:ff9b::a00:1",
    "2001:db8::1", "2002:a00:1::", "3fff::1", "not-an-address"
  ];
  for (const address of blockedAddresses) {
    const diagnostics = new AiServiceDiagnostics({ probe: {
      resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }, { address: "1.1.1.1", family: 4 }],
      request: async () => { connections++; return { httpStatus: 200 }; }
    } });
    const report = await diagnostics.run({ service: "grok" });
    assert.equal(report.results[0].status, "dns_error", address);
    assert.equal(report.results[0].stage, "dns");
    assert.equal(report.results[0].remoteAddress, null);
  }
  assert.equal(connections, 0, "even mixed safe/unsafe DNS answers must not be connected");
  const diagnostics = new AiServiceDiagnostics({ probe: publicProbe() });
  await assert.rejects(diagnostics.run({ service: "https://127.0.0.1/private" }), { code: "AI_DIAGNOSTIC_INVALID_SERVICE", statusCode: 422 });
  assert.equal(diagnostics.snapshot(), null);
});

test("AI diagnostics never follows redirects or exposes response bodies, response headers, or raw errors", async () => {
  const visited = [];
  const diagnostics = new AiServiceDiagnostics({ probe: publicProbe(async ({ url }) => {
    visited.push(url.href);
    return { httpStatus: 302, headers: { location: "http://127.0.0.1/admin?token=secret", "set-cookie": "session=secret" }, body: "SECRET_RESPONSE" };
  }) });
  const report = await diagnostics.run({ service: "grok" });
  assert.deepEqual(visited, ["https://grok.com/"]);
  assert.equal(report.results[0].status, "redirect");
  assert.doesNotMatch(JSON.stringify(report), /127\.0\.0\.1|secret|SECRET_RESPONSE|set-cookie/);
  const failed = new AiServiceDiagnostics({ probe: publicProbe(async () => {
    throw Object.assign(new Error("credential=secret; /private/path"), { code: "ECONNRESET", stage: "http" });
  }) });
  const failedReport = await failed.run({ service: "grok" });
  assert.equal(failedReport.results[0].status, "network_error");
  assert.equal(failedReport.results[0].stage, "http");
  assert.doesNotMatch(JSON.stringify(failedReport), /credential|secret|private/);
});

test("AI diagnostics classifies anonymous responses without confusing denied access with a broken network", async () => {
  const cases = [
    [200, {}, "", "reachable"], [307, {}, "", "redirect"], [401, {}, "", "authentication_required"],
    [403, {}, "blocked", "permission_denied"], [403, {}, '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>', "challenge"],
    [429, {}, "", "rate_limited"], [503, {}, "", "upstream_error"],
    [403, { "CF-Mitigated": "challenge" }, "", "challenge"]
  ];
  for (const [httpStatus, headers, body, expected] of cases) {
    const diagnostics = new AiServiceDiagnostics({ probe: publicProbe(async () => ({ httpStatus, headers, body })) });
    const result = (await diagnostics.run({ service: "grok" })).results[0];
    assert.equal(result.status, expected, String(httpStatus));
    assert.equal(result.httpStatus, httpStatus);
    assert.equal(result.stage, "http");
  }
  for (const [code, stage, expected] of [["ENOTFOUND", "dns", "dns_error"], ["CERT_HAS_EXPIRED", "tls", "tls_error"], ["ETIMEDOUT", "tls", "timeout"], ["ECONNREFUSED", "connect", "network_error"]]) {
    const diagnostics = new AiServiceDiagnostics({ probe: {
      ...publicProbe(),
      ...(stage === "dns" ? { resolve: async () => { throw Object.assign(new Error("raw error"), { code, stage }); } }
        : { request: async () => { throw Object.assign(new Error("raw error"), { code, stage }); } })
    } });
    const result = (await diagnostics.run({ service: "grok" })).results[0];
    assert.equal(result.status, expected);
    assert.equal(result.httpStatus, null);
  }
});

test("AI diagnostics rejects changed or malformed peer addresses even after public DNS answers", async () => {
  for (const remoteAddress of ["127.0.0.1", "8.8.8.8", "garbage", "fe80::1%en0"]) {
    const diagnostics = new AiServiceDiagnostics({ probe: publicProbe(async () => ({ httpStatus: 200, remoteAddress })) });
    const result = (await diagnostics.run({ service: "grok" })).results[0];
    assert.equal(result.status, "network_error", remoteAddress);
    assert.equal(result.remoteAddress, null);
  }
});

test("AI diagnostics preserves the failing DNS, connect, TLS, or HTTP phase at the total deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  for (const phase of ["dns", "connect", "tls", "http"]) {
    let aborted = false, releaseDns, reached;
    const ready = new Promise((resolve) => { reached = resolve; });
    const waitForAbort = ({ signal, onStage }) => {
      onStage?.(phase);
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      reached();
      return new Promise((resolve) => { if (phase === "dns") releaseDns = resolve; });
    };
    let connections = 0;
    const diagnostics = new AiServiceDiagnostics({ probe: {
      resolve: phase === "dns" ? (_host, options) => waitForAbort(options) : publicProbe().resolve,
      request: async (options) => { connections++; return waitForAbort(options); }
    } });
    const pending = diagnostics.run({ service: "grok" });
    await ready;
    t.mock.timers.tick(8_000);
    const result = (await pending).results[0];
    assert.equal(result.status, "timeout");
    assert.equal(result.stage, phase);
    assert.equal(aborted, true);
    if (releaseDns) {
      releaseDns([{ address: "1.1.1.1", family: 4 }]);
      await Promise.resolve();
      assert.equal(connections, 0, "a late DNS answer must not start a socket after its deadline");
    }
  }
});

test("AI diagnostics coalesces overlapping requests, bounds sockets, and keeps service-specific snapshots correct", async () => {
  const visits = [], releases = [];
  let active = 0, peak = 0;
  const diagnostics = new AiServiceDiagnostics({ probe: publicProbe(async ({ url }) => {
    visits.push(url.hostname); active++; peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
    return { httpStatus: url.hostname.startsWith("api.") ? 401 : 200 };
  }) });
  const all = diagnostics.run();
  const claude = diagnostics.run({ service: "claude" });
  const duplicates = Array.from({ length: 12 }, () => diagnostics.run());
  for (let step = 0; step < 12; step++) {
    await new Promise((resolve) => setImmediate(resolve));
    releases.splice(0).forEach((release) => release());
  }
  const [report, claudeReport, ...copies] = await Promise.all([all, claude, ...duplicates]);
  assert.equal(peak, 3, "health checks must not fan out unlimited sockets");
  assert.equal(visits.length, 8, "concurrent service and all requests reuse each target probe");
  assert.equal(new Set(visits).size, 8);
  assert.equal(report.results.length, 8);
  assert.deepEqual(claudeReport.results.map(({ host }) => host), ["claude.ai", "api.anthropic.com"]);
  for (const copy of copies) assert.deepEqual(copy, report);
  const cachedClaude = await diagnostics.run({ service: "claude" });
  assert.equal(visits.length, 8);
  assert.deepEqual(cachedClaude, claudeReport);
  assert.deepEqual(diagnostics.snapshot(), claudeReport);
  cachedClaude.results[0].message = "caller mutation";
  report.results.length = 0;
  assert.equal((await diagnostics.run()).results.length, 8);
  assert.notEqual(diagnostics.snapshot().results[0].message, "caller mutation");
});

test("AI diagnostics retries targets only after their 60-second cooldown, including failed probes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  let requests = 0;
  const diagnostics = new AiServiceDiagnostics({ probe: publicProbe(async () => {
    requests++;
    return { httpStatus: requests === 1 ? 503 : 200 };
  }) });
  const first = await diagnostics.run({ service: "grok" });
  assert.equal(first.results[0].status, "upstream_error");
  t.mock.timers.tick(59_999);
  assert.deepEqual(await diagnostics.run({ service: "grok" }), first);
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  const second = await diagnostics.run({ service: "grok" });
  assert.equal(requests, 2);
  assert.equal(second.results[0].status, "reachable");
  assert.notEqual(second.checkedAt, first.checkedAt);
});

test("AI diagnostics supports a public IPv6 target and normalizes an IPv4-mapped public peer", async () => {
  const ipv6 = new AiServiceDiagnostics({ probe: {
    resolve: async () => [{ address: "2606:4700:4700::1111", family: 6 }],
    request: async ({ address, family }) => {
      assert.equal(address, "2606:4700:4700::1111");
      assert.equal(family, 6);
      return { httpStatus: 200, remoteAddress: "2606:4700:4700:0:0:0:0:1111" };
    }
  } });
  assert.equal((await ipv6.run({ service: "grok" })).results[0].remoteAddress, "2606:4700:4700::1111");
  const mapped = new AiServiceDiagnostics({ probe: publicProbe(async () => ({ httpStatus: 200, remoteAddress: "::ffff:1.1.1.1" })) });
  assert.equal((await mapped.run({ service: "grok" })).results[0].remoteAddress, "1.1.1.1");
});

test("AI diagnostics reports oversized HTTP headers as a probe limit instead of a network failure", async () => {
  const diagnostics = new AiServiceDiagnostics({ probe: publicProbe(async () => {
    throw Object.assign(new Error("Header overflow with private cookie=secret"), {
      code: "HPE_HEADER_OVERFLOW", stage: "http", rawPacket: Buffer.from("secret header bytes")
    });
  }) });
  const result = (await diagnostics.run({ service: "gemini" })).results[0];
  assert.equal(result.status, "response_too_large");
  assert.equal(result.stage, "http");
  assert.match(result.message, /响应头.*上限/);
  assert.doesNotMatch(JSON.stringify(result), /cookie|secret|rawPacket/);
});
