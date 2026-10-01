import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { EndpointResolver } from "../server/subscriptions/endpoint-resolver.js";

test("endpoint DNS deadline cancels outstanding lookup before accepting another request", async () => {
  let active = 0;
  let peak = 0;
  const resolver = new EndpointResolver({
    lookupTimeoutMs: 10,
    lookup: (_hostname, { signal } = {}) => new Promise((_resolve, reject) => {
      active++; peak = Math.max(peak, active);
      signal?.addEventListener("abort", () => { active--; reject(signal.reason); }, { once: true });
    })
  });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await resolver.resolve({ hostname: "blackhole.example", fallbackAddress: "203.0.113.1" }), {
      address: "203.0.113.1", source: "configured-fallback"
    });
    assert.equal(active, 0, "timed-out DNS work must be canceled");
  }
  assert.equal(peak, 1);
});

test("canceling one real DNS lookup leaves a concurrent Host lookup intact", async (t) => {
  const server = createSocket("udp4");
  let sawBlackhole;
  const blackholeSeen = new Promise((resolve) => { sawBlackhole = resolve; });
  server.on("message", (query, peer) => {
    let end = 12; const labels = [];
    while (query[end]) { const size = query[end++]; labels.push(query.toString("ascii", end, end + size)); end += size; }
    if (labels.join(".") === "blackhole.example") { sawBlackhole(); return; }
    end += 5;
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6);
    header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
    const response = Buffer.concat([header, query.subarray(12, end), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 203, 0, 113, 22])]);
    setTimeout(() => server.send(response, peer.port, peer.address), 100);
  });
  server.bind(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const resolver = new EndpointResolver({ dnsServers: [`127.0.0.1:${server.address().port}`], lookupTimeoutMs: 175 });
  const blackhole = resolver.resolve({ hostname: "blackhole.example", fallbackAddress: "203.0.113.1" });
  await blackholeSeen; await delay(100);
  const healthy = resolver.resolve({ hostname: "healthy.example" });
  assert.deepEqual(await blackhole, { address: "203.0.113.1", source: "configured-fallback" });
  assert.deepEqual(await healthy, { address: "203.0.113.22", source: "dns" });
});

test("endpoint resolver caches healthy DNS answers until their TTL expires", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = 1_000;
  let lookupCalls = 0;
  let probeCalls = 0;
  const resolver = new EndpointResolver({
    cachePath: join(dataDir, "endpoint-cache.json"),
    now: () => now,
    lookup: async () => {
      lookupCalls += 1;
      return [{
        address: lookupCalls === 1 ? "203.0.113.20" : "203.0.113.21",
        ttl: 60
      }];
    },
    probe: async ({ port }) => {
      probeCalls += 1;
      return port === 8388;
    }
  });
  const input = {
    hostname: "node.example.com",
    protocols: [{ type: "shadowsocks", port: 8388, enabled: true }],
    fallbackAddress: "203.0.113.10"
  };

  assert.deepEqual(await resolver.resolve(input), {
    address: "203.0.113.20",
    source: "dns"
  });
  assert.deepEqual(await resolver.resolve(input), {
    address: "203.0.113.20",
    source: "cache"
  });
  assert.equal(lookupCalls, 1);
  assert.equal(probeCalls, 1);

  now += 60_001;
  assert.deepEqual(await resolver.resolve(input), {
    address: "203.0.113.21",
    source: "dns"
  });
  assert.equal(lookupCalls, 2);
  assert.equal(probeCalls, 2);
});

test("endpoint resolver skips unhealthy DNS answers", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const resolver = new EndpointResolver({
    cachePath: join(dataDir, "endpoint-cache.json"),
    lookup: async () => [
      { address: "203.0.113.20", ttl: 60 },
      { address: "203.0.113.21", ttl: 60 }
    ],
    probe: async ({ address }) => address === "203.0.113.21"
  });

  assert.deepEqual(await resolver.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "naive", port: 8443, enabled: true }],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.21",
    source: "dns"
  });
});

test("endpoint resolver probes every candidate and TCP port in one health window", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const releases = [];
  let probeCalls = 0;
  const resolver = new EndpointResolver({
    cachePath: join(dataDir, "endpoint-cache.json"),
    lookup: async () => [
      { address: "203.0.113.20", ttl: 60 },
      { address: "203.0.113.21", ttl: 60 }
    ],
    probe: async ({ address, port }) => new Promise((resolve) => {
      probeCalls += 1;
      releases.push(() => resolve(address === "203.0.113.21" && port === 8443));
      if (releases.length === 4) queueMicrotask(() => releases.forEach((release) => release()));
    })
  });

  assert.deepEqual(await resolver.resolve({
    hostname: "node.example.com",
    protocols: [
      { type: "shadowsocks", port: 8388, enabled: true },
      { type: "naive", port: 8443, enabled: true }
    ],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.21",
    source: "dns"
  });
  assert.equal(probeCalls, 4);
});

test("endpoint resolver reaches fallback within its trusted DNS deadline", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const resolver = new EndpointResolver({
    cachePath: join(dataDir, "endpoint-cache.json"),
    lookupTimeoutMs: 10,
    lookup: async () => new Promise(() => {}),
    probe: async () => true
  });
  const startedAt = Date.now();

  assert.deepEqual(await resolver.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "shadowsocks", port: 8388, enabled: true }],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.10",
    source: "configured-fallback"
  });
  assert.ok(Date.now() - startedAt < 250);
});

test("endpoint resolver persists last-known-good and then uses the configured fallback", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cachePath = join(dataDir, "endpoint-cache.json");
  const healthy = new EndpointResolver({
    cachePath,
    lookup: async () => [{ address: "203.0.113.20", ttl: 1 }],
    probe: async () => true,
    now: () => 1_000
  });
  await healthy.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "trojan", port: 9443, enabled: true }],
    fallbackAddress: "203.0.113.10"
  });

  const unavailable = new EndpointResolver({
    cachePath,
    lookup: async () => {
      throw new Error("trusted DNS unavailable");
    },
    probe: async () => false,
    now: () => 10_000
  });
  assert.deepEqual(await unavailable.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "trojan", port: 9443, enabled: true }],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.20",
    source: "last-known-good"
  });

  assert.deepEqual(await unavailable.resolve({
    hostname: "new-node.example.com",
    protocols: [{ type: "trojan", port: 9443, enabled: true }],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.10",
    source: "configured-fallback"
  });
});

test("endpoint resolver still serves a healthy DNS answer when persistence fails", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const invalidDirectory = join(dataDir, "not-a-directory");
  await writeFile(invalidDirectory, "occupied");
  const resolver = new EndpointResolver({
    cachePath: join(invalidDirectory, "endpoint-cache.json"),
    lookup: async () => [{ address: "203.0.113.20", ttl: 60 }],
    probe: async () => true
  });

  assert.deepEqual(await resolver.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "shadowsocks", port: 8388, enabled: true }]
  }), {
    address: "203.0.113.20",
    source: "dns"
  });
});
