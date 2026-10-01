import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { connect, isIP } from "node:net";
import { dirname } from "node:path";

import { protocolActivationPolicy } from "../protocol-activation.js";

function trustedDnsLookup(servers) {
  return async (hostname, { signal } = {}) => {
    // Resolver.cancel() cancels all its queries, so each lookup needs its own
    // instance: one timed-out Host must not cancel another Host's resolution.
    const resolver = new Resolver();
    resolver.setServers(servers);
    const cancel = () => resolver.cancel();
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await resolver.resolve4(hostname, { ttl: true });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
}

function tcpProbe({ address, port, timeoutMs }) {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(healthy);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function tcpPorts(protocols) {
  return [...new Set((protocols || []).flatMap((protocol) => {
    let usesTcp = false;
    try {
      usesTcp = protocolActivationPolicy(protocol.type).network === "tcp"
        && protocol.transport?.type !== "quic";
    } catch {
      usesTcp = false;
    }
    const port = Number(protocol.port ?? protocol.listen_port ?? protocol.listenPort);
    return protocol.enabled !== false && usesTcp && Number.isInteger(port) && port > 0
      ? [port]
      : [];
  }))];
}

function normalizeAnswers(answers) {
  return (answers || []).flatMap((answer) => {
    const address = typeof answer === "string" ? answer : answer?.address;
    const ttl = Number(typeof answer === "string" ? 60 : answer?.ttl);
    return isIP(address) === 4
      ? [{ address, ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 60 }]
      : [];
  });
}

async function withDeadline(operation, timeoutMs) {
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new Error(`trusted DNS lookup timed out after ${timeoutMs}ms`);
            controller.abort(error);
            reject(error);
          },
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class EndpointResolver {
  constructor({
    cachePath,
    dnsServers = ["1.1.1.1", "8.8.8.8"],
    lookup = trustedDnsLookup(dnsServers),
    probe = tcpProbe,
    lookupTimeoutMs = 2_000,
    probeTimeoutMs = 1_500,
    minCacheTtlMs = 1_000,
    maxCacheTtlMs = 5 * 60_000,
    now = () => Date.now()
  }) {
    this.cachePath = cachePath;
    this.lookup = lookup;
    this.probe = probe;
    this.lookupTimeoutMs = lookupTimeoutMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.minCacheTtlMs = minCacheTtlMs;
    this.maxCacheTtlMs = maxCacheTtlMs;
    this.now = now;
    this.records = new Map();
    this.inflight = new Map();
    this.loadPromise = null;
  }

  async resolve({ hostname, protocols = [], fallbackAddress = "" }) {
    if (isIP(hostname)) return { address: hostname, source: "literal" };
    await this.#load();
    const cached = this.records.get(hostname);
    if (cached && cached.expiresAt > this.now() && isIP(cached.address)) {
      return { address: cached.address, source: "cache" };
    }
    if (this.inflight.has(hostname)) return this.inflight.get(hostname);
    const resolution = this.#resolveFresh({ hostname, protocols, fallbackAddress })
      .finally(() => this.inflight.delete(hostname));
    this.inflight.set(hostname, resolution);
    return resolution;
  }

  async #resolveFresh({ hostname, protocols, fallbackAddress }) {
    let answers = [];
    try {
      answers = normalizeAnswers(await withDeadline(
        (signal) => this.lookup(hostname, { signal }),
        this.lookupTimeoutMs
      ));
    } catch {
      answers = [];
    }
    const ports = tcpPorts(protocols);
    const health = await Promise.all(answers.map((answer) => (
      !ports.length || this.#hasHealthyPort(answer.address, ports)
    )));
    const answer = answers.find((_, index) => health[index]);
    if (answer) {
      const ttlMs = Math.max(
        this.minCacheTtlMs,
        Math.min(this.maxCacheTtlMs, answer.ttl * 1_000)
      );
      this.records.set(hostname, {
        address: answer.address,
        expiresAt: this.now() + ttlMs
      });
      try {
        await this.#save();
      } catch (error) {
        console.warn(`[RayLink] Endpoint cache could not be saved: ${error.message}`);
      }
      return { address: answer.address, source: "dns" };
    }

    const lastKnownGood = this.records.get(hostname);
    if (lastKnownGood && isIP(lastKnownGood.address)) {
      return { address: lastKnownGood.address, source: "last-known-good" };
    }
    if (isIP(fallbackAddress)) {
      return { address: fallbackAddress, source: "configured-fallback" };
    }
    return null;
  }

  async #hasHealthyPort(address, ports) {
    const results = await Promise.all(ports.map(async (port) => {
      try {
        return await this.probe({ address, port, timeoutMs: this.probeTimeoutMs });
      } catch {
        return false;
      }
    }));
    return results.some(Boolean);
  }

  async #load() {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      if (!this.cachePath) return;
      try {
        const payload = JSON.parse(await readFile(this.cachePath, "utf8"));
        for (const [hostname, record] of Object.entries(payload.hosts || {})) {
          if (isIP(record?.address)) this.records.set(hostname, record);
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.warn(`[RayLink] Endpoint cache could not be loaded: ${error.message}`);
        }
      }
    })();
    return this.loadPromise;
  }

  async #save() {
    if (!this.cachePath) return;
    await mkdir(dirname(this.cachePath), { recursive: true });
    const temporaryPath = `${this.cachePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const payload = JSON.stringify({
      version: 1,
      hosts: Object.fromEntries(this.records)
    });
    await writeFile(temporaryPath, payload, { mode: 0o600 });
    await rename(temporaryPath, this.cachePath);
  }
}
