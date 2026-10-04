import assert from "node:assert/strict";
import { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiServiceDiagnostics } from "../server/routing/ai-diagnostics.js";
import { createAiUpstreamProbe } from "../server/routing/ai-upstream-probe.js";

test("AI checks distinguish HTTP proxy authentication from an AI account response", async (t) => {
  let connects = 0;
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    connects++;
    assert.equal(request.headers["proxy-authorization"], "Basic " + Buffer.from("proxy-user:proxy-password").toString("base64"));
    assert.equal(request.url, "1.1.1.1:443");
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const diagnostics = new AiServiceDiagnostics({ source: "control-plane-via-upstream", configRevision: 3,
    probe: createAiUpstreamProbe({ type: "http", server: "127.0.0.1", port: proxy.address().port,
      username: "proxy-user", password: "proxy-password" }, { resolve: async () => [{ address: "1.1.1.1", family: 4 }] }) });
  const report = await diagnostics.run({ service: "claude" });
  assert.equal(report.source, "control-plane-via-upstream");
  assert.equal(report.configRevision, 3);
  assert.equal(connects, 2);
  assert.ok(report.results.every((row) => row.status === "upstream_authentication_required" && row.stage === "connect"));
  assert.doesNotMatch(JSON.stringify(report), /proxy-password|proxy-user|Basic /);
});

test("SOCKS5, HTTP and HTTPS diagnostics reach TLS AI targets without forwarding proxy credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-upstream-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=claude.ai",
    "-addext", "subjectAltName=DNS:claude.ai,DNS:api.anthropic.com,DNS:proxy.test", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
  const key = await readFile(join(directory, "key.pem")), cert = await readFile(join(directory, "cert.pem"));
  let targetRequests = 0;
  const target = https.createServer({ key, cert }, (request, response) => {
    targetRequests++;
    assert.equal(request.headers["proxy-authorization"], undefined);
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200); response.end("AI fixture");
  });
  const sockets = new Set();
  const track = (server) => server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  track(target);
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); target.close(); });
  for (const type of ["socks5", "http", "https"]) {
    await t.test(type, async (t) => {
      let tunnels = 0;
      const bridge = (client) => {
        tunnels++;
        const upstream = net.connect(target.address().port, "127.0.0.1", () => { client.pipe(upstream); upstream.pipe(client); });
        sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
        client.once("close", () => upstream.destroy()); upstream.once("error", () => client.destroy());
      };
      const proxy = type === "socks5" ? net.createServer((socket) => {
        let buffer = Buffer.alloc(0), stage = 0;
        const data = (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (stage === 0 && buffer.length >= 3) {
            assert.deepEqual([...buffer.subarray(0, 3)], [5, 1, 2]); buffer = buffer.subarray(3); stage = 1;
            // Deliberately split the reply to exercise incremental parsing.
            socket.write(Buffer.from([5])); setImmediate(() => socket.write(Buffer.from([2])));
          }
          if (stage === 1 && buffer.length >= 2) {
            const usernameLength = buffer[1];
            if (buffer.length < 3 + usernameLength) return;
            const length = 3 + usernameLength + buffer[2 + usernameLength];
            if (buffer.length < length) return;
            assert.equal(buffer.subarray(2, 2 + usernameLength).toString(), "proxy-user");
            assert.equal(buffer.subarray(3 + usernameLength, length).toString(), "proxy-password");
            buffer = buffer.subarray(length); stage = 2; socket.write(Buffer.from([1, 0]));
          }
          if (stage === 2 && buffer.length >= 10) {
            assert.deepEqual([...buffer.subarray(0, 10)], [5, 1, 0, 1, 1, 1, 1, 1, 1, 187]);
            socket.off("data", data); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); bridge(socket);
          }
        };
        socket.on("data", data);
      }) : type === "https" ? https.createServer({ key, cert }) : createServer();
      if (type !== "socks5") proxy.on("connect", (request, socket) => {
        assert.equal(request.url, "1.1.1.1:443");
        assert.equal(request.headers["proxy-authorization"], "Basic " + Buffer.from("proxy-user:proxy-password").toString("base64"));
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); bridge(socket);
      });
      track(proxy);
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      t.after(() => proxy.close());
      const config = { type, server: "127.0.0.1", port: proxy.address().port, username: "proxy-user", password: "proxy-password", tlsServerName: "proxy.test" };
      const resolve = async () => [{ address: "1.1.1.1", family: 4 }];
      const checks = new AiServiceDiagnostics({ source: "control-plane-via-upstream", configRevision: 1,
        probe: createAiUpstreamProbe(config, { resolve, ca: cert }) });
      const report = await checks.run({ service: "claude" });
      assert.ok(report.results.every((row) => row.status === "reachable" && row.httpStatus === 200), JSON.stringify(report));
      assert.equal(tunnels, 2);
      assert.ok(report.results.every((row) => row.remoteAddress === null), "do not claim a proxy socket is the remote target or egress IP");
      if (type === "https") {
        const untrusted = new AiServiceDiagnostics({ probe: createAiUpstreamProbe(config, { resolve }) });
        const failure = await untrusted.run({ service: "claude" });
        assert.ok(failure.results.every((row) => row.status === "tls_error"));
        assert.equal(tunnels, 2, "an untrusted HTTPS proxy never receives CONNECT credentials");
      }
    });
  }
  assert.equal(targetRequests, 6);
});

test("aborting a stalled proxy handshake closes both HTTP and SOCKS transports", async (t) => {
  for (const type of ["http", "socks5"]) {
    await t.test(type, async (t) => {
      let connected;
      const connection = new Promise((resolve) => { connected = resolve; });
      const sockets = new Set();
      const proxy = net.createServer((socket) => {
        sockets.add(socket); socket.on("data", () => {});
        socket.on("close", () => sockets.delete(socket)); connected();
      });
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
      const controller = new AbortController();
      const probe = createAiUpstreamProbe({ type, server: "127.0.0.1", port: proxy.address().port, username: "", password: "" });
      const pending = probe.request({ url: new URL("https://claude.ai/"), address: "1.1.1.1", family: 4, signal: controller.signal });
      await connection;
      controller.abort();
      await assert.rejects(pending);
      for (let attempt = 0; sockets.size && attempt < 30; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(sockets.size, 0, "no half-open socket remains after the diagnostic deadline");
    });
  }
});
