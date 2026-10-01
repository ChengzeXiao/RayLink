// Optional native integration check: node tests/mihomo-routing-check.mjs
// Requires mihomo and curl. All traffic stays on loopback; no TUN/system changes.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const binary = process.env.MIHOMO_BIN || "mihomo";
await run(binary, ["-v"]);
await run("curl", ["--version"]);

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const origin = createServer((_request, response) => response.end("split-dns-direct-ok"));
const dns = createSocket("udp4");
// Minimal local fixture DNS: answer A queries with loopback, and AAAA with NODATA.
dns.on("message", (query, remote) => {
  let end = 12;
  while (query[end]) end += query[end] + 1;
  end += 5;
  const isA = query.readUInt16BE(end - 4) === 1;
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(isA ? 1 : 0, 6);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 10, 0, 4, 127, 0, 0, 1]);
  dns.send(Buffer.concat([
    header, query.subarray(12, end), ...(isA ? [answer] : [])
  ]), remote.port, remote.address);
});
await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => dns.bind(0, "127.0.0.1", resolve));

try {
  const artifact = buildSubscriptionArtifact({
    format: "mihomo",
    routePolicy: { mode: "global-proxy" },
    singBoxConfig: { outbounds: [{
      type: "shadowsocks", tag: "unavailable-proxy", server: "127.0.0.1",
      server_port: await unusedPort(), network: "tcp",
      method: "2022-blake3-aes-128-gcm", password: "AAAAAAAAAAAAAAAAAAAAAA=="
    }] }
  });
  for (const variant of ["without-late-bypass", "fixed"]) {
    const directory = await mkdtemp(join(tmpdir(), "raylink-split-dns-"));
    const proxyPort = await unusedPort();
    let yaml = artifact.body
      .replace("mixed-port: 7890", `mixed-port: ${proxyPort}`)
      .replaceAll("https://1.1.1.1/dns-query#RayLink 代理", `udp://127.0.0.1:${dns.address().port}#DIRECT`);
    if (variant === "without-late-bypass") {
      yaml = yaml.replace(/^  - "IP-CIDR6?,[^\n]+,DIRECT"\n/gm, "");
    }
    const path = join(directory, "config.yaml");
    await writeFile(path, yaml);
    const child = spawn(binary, ["-d", directory, "-f", path], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let logs = "";
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    try {
      const deadline = Date.now() + 5000;
      while (!logs.includes("proxy listening at") && Date.now() < deadline && child.exitCode === null) {
        await delay(25);
      }
      assert.ok(logs.includes("proxy listening at"), logs);
      let body = "";
      try {
        ({ stdout: body } = await run("curl", [
          "-fsS", "--max-time", "5", "--noproxy", "", "--socks5-hostname",
          `127.0.0.1:${proxyPort}`, `http://split.example.com:${origin.address().port}/`
        ]));
      } catch (error) {
        if (variant === "fixed") throw error;
      }
      if (variant === "fixed") {
        assert.equal(body, "split-dns-direct-ok");
        assert.match(logs, /IPCIDR\(127\.0\.0\.0\/8\).*DIRECT/);
      } else {
        assert.notEqual(body, "split-dns-direct-ok");
        assert.match(logs, /dial RayLink 代理/);
      }
      console.log(`${variant}: passed`);
    } finally {
      child.kill("SIGTERM");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  dns.close();
  await new Promise((resolve) => origin.close(resolve));
}
