import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSingBoxConfig } from "../server/singbox/config.js";
import {
  buildProtocolProbeConfig as buildLocalProtocolProbeConfig
} from "../server/singbox/protocol-probe.js";
import {
  buildProtocolClientConfig,
  defaultProtocolConfigs,
  normalizeProtocolConfig,
  protocolCatalog
} from "../server/singbox/protocol-catalog.js";
import { buildProtocolProbeConfig } from "../web/node/raylink-node.mjs";

const singBoxBinary = process.env.SING_BOX_BIN || "sing-box";
const temporaryDirectory = await mkdtemp(join(tmpdir(), "raylink-protocol-check-"));
const certificatePath = join(temporaryDirectory, "certificate.pem");
const keyPath = join(temporaryDirectory, "private-key.pem");
const user = {
  email: "protocol-check@example.com",
  runtimeName: `rl-user-${randomUUID()}`,
  runtimeUuid: randomUUID(),
  runtimePassword: randomBytes(16).toString("base64"),
  state: "active",
  portalStatus: "active",
  usedGb: 0,
  quotaGb: 100,
  expiresAt: "2030-12-31",
  nodeScope: ["all"]
};
const masterPassword = randomBytes(16).toString("base64");
let realityKeyPair = null;
let singBoxVersionLine = "";

function command(binary, args, options = {}) {
  return execFileSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

function enabledProfile(type) {
  const fallback = defaultProtocolConfigs().find((profile) => profile.type === type);
  const catalog = protocolCatalog.find((protocol) => protocol.type === type);
  const tls = catalog.tls === "required"
    ? {
        ...fallback.tls,
        mode: "certificate",
        serverName: "node.example.com",
        certificatePath,
        keyPath
      }
    : fallback.tls;
  const options = {
    ...fallback.options,
    ...(type === "shadowtls"
      ? {
          version: 3,
          handshake: { server: "www.cloudflare.com", server_port: 443 }
        }
      : {}),
    ...(type === "tun"
      ? { address: ["172.19.0.1/30"], auto_route: false }
      : {})
  };
  return normalizeProtocolConfig({
    ...fallback,
    enabled: true,
    tls,
    options
  });
}

function realityProfile(type) {
  const fallback = defaultProtocolConfigs().find((profile) => profile.type === type);
  return normalizeProtocolConfig({
    ...fallback,
    enabled: true,
    tls: {
      ...fallback.tls,
      mode: "reality",
      serverName: "www.cloudflare.com",
      handshakeServer: "www.cloudflare.com",
      handshakePort: 443,
      privateKey: realityKeyPair.privateKey,
      publicKey: realityKeyPair.publicKey,
      shortId: "0123456789abcdef"
    }
  });
}

function acmeProfile(type) {
  const fallback = defaultProtocolConfigs().find((profile) => profile.type === type);
  return normalizeProtocolConfig({
    ...fallback,
    enabled: true,
    tls: {
      ...fallback.tls,
      mode: "acme",
      serverName: "node.example.com",
      acmeEmail: "ops@example.com",
      acmeDataDirectory: join(temporaryDirectory, `acme-${type}`)
    }
  });
}

async function checkConfig(name, config) {
  const configPath = join(temporaryDirectory, `${name}.json`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  try {
    command(singBoxBinary, ["check", "-c", configPath]);
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`${name} failed sing-box check: ${detail}`);
  }
}

async function checkConfigStarts(name, config) {
  const configPath = join(temporaryDirectory, `${name}.json`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const child = spawn(singBoxBinary, ["run", "-c", configPath], {
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  const earlyExit = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 500))
  ]);
  if (earlyExit) {
    throw new Error(
      `${name} failed sing-box runtime startup (${earlyExit.code ?? earlyExit.signal}): ${stderr.trim()}`
    );
  }
  child.kill("SIGTERM");
  await exited;
}

try {
  try {
    singBoxVersionLine = command(singBoxBinary, ["version"]).split("\n")[0];
  } catch {
    throw new Error(
      `找不到可执行的 sing-box；请安装 1.14.2 或设置 SING_BOX_BIN（当前：${singBoxBinary}）`
    );
  }
  assert.match(
    singBoxVersionLine,
    /^sing-box version 1\.14\.2\b/,
    `协议验收要求 sing-box 1.14.2，当前为：${singBoxVersionLine}`
  );
  try {
    command("openssl", ["version"]);
  } catch {
    throw new Error("协议验收需要 OpenSSL 生成临时自签名证书");
  }
  command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=node.example.com"
  ]);
  const realityOutput = command(singBoxBinary, ["generate", "reality-keypair"]);
  realityKeyPair = {
    privateKey: realityOutput.match(/PrivateKey:\s*(\S+)/)?.[1],
    publicKey: realityOutput.match(/PublicKey:\s*(\S+)/)?.[1]
  };
  assert.ok(realityKeyPair.privateKey && realityKeyPair.publicKey);

  const checkedProtocols = [];
  for (const protocol of protocolCatalog) {
    const profile = enabledProfile(protocol.type);
    const config = buildSingBoxConfig({
      host: {
        runtimeVersion: "1.14.2",
        region: "test",
        buildTags: []
      },
      users: [user],
      protocols: [profile],
      masterPassword
    });
    await checkConfig(`server-${protocol.type}`, config);
    checkedProtocols.push(protocol.type);
  }

  const checkedRealityProtocols = [];
  for (const protocol of protocolCatalog.filter((entry) => entry.reality)) {
    const profile = realityProfile(protocol.type);
    const serverConfig = buildSingBoxConfig({
      host: {
        runtimeVersion: "1.14.2",
        region: "test",
        buildTags: ["with_utls"]
      },
      users: [user],
      protocols: [profile],
      masterPassword
    });
    await checkConfig(`server-${protocol.type}-reality`, serverConfig);
    const clientConfig = buildProtocolClientConfig({
      profiles: [profile],
      credential: {
        email: user.email,
        runtimeName: user.runtimeName,
        runtimeUuid: user.runtimeUuid,
        runtimePassword: user.runtimePassword,
        serverPassword: masterPassword
      },
      server: "node.example.com"
    });
    await checkConfig(`client-${protocol.type}-reality`, clientConfig);
    const realityProbe = buildProtocolProbeConfig({
      activation: {
        type: protocol.type,
        address: "node.example.com",
        port: profile.port
      },
      configText: JSON.stringify(serverConfig)
    });
    assert.deepEqual(
      realityProbe,
      buildLocalProtocolProbeConfig({
        type: protocol.type,
        address: "node.example.com",
        port: profile.port,
        serverConfig
      })
    );
    await checkConfig(`probe-${protocol.type}-reality`, realityProbe);
    checkedRealityProtocols.push(protocol.type);
  }

  const checkedAcmeProtocols = [];
  const checkedProtocolProbes = [];
  for (const type of [
    "vmess",
    "vless",
    "trojan",
    "naive",
    "anytls",
    "hysteria",
    "tuic",
    "hysteria2"
  ]) {
    const profile = acmeProfile(type);
    const serverConfig = buildSingBoxConfig({
      host: {
        runtimeVersion: "1.14.2",
        region: "test",
        buildTags: ["with_acme", "with_quic"]
      },
      users: [user],
      protocols: [profile],
      masterPassword
    });
    await checkConfig(`server-${type}-acme`, serverConfig);
    const probeConfig = buildProtocolProbeConfig({
      activation: {
        type,
        address: "node.example.com",
        port: profile.port
      },
      configText: JSON.stringify(serverConfig)
    });
    if (type === "naive") {
      assert.equal(
        probeConfig.outbounds[0].username,
        "raylink-probe@internal",
        "Naive probe must not consume a real User credential"
      );
    }
    assert.deepEqual(
      probeConfig,
      buildLocalProtocolProbeConfig({
        type,
        address: "node.example.com",
        port: profile.port,
        serverConfig
      })
    );
    await checkConfig(`probe-${type}`, probeConfig);
    checkedProtocolProbes.push(type);
    checkedAcmeProtocols.push(type);
  }

  const shadowsocksProfile = normalizeProtocolConfig({
    ...defaultProtocolConfigs().find((profile) => profile.type === "shadowsocks"),
    enabled: true
  });
  const shadowsocksServerConfig = buildSingBoxConfig({
    host: { region: "test", buildTags: [] },
    users: [user],
    protocols: [shadowsocksProfile],
    masterPassword
  });
  const shadowsocksProbe = buildProtocolProbeConfig({
    activation: {
      type: "shadowsocks",
      address: "node.example.com",
      port: shadowsocksProfile.port
    },
    configText: JSON.stringify(shadowsocksServerConfig)
  });
  assert.deepEqual(
    shadowsocksProbe,
    buildLocalProtocolProbeConfig({
      type: "shadowsocks",
      address: "node.example.com",
      port: shadowsocksProfile.port,
      serverConfig: shadowsocksServerConfig
    })
  );
  await checkConfig("probe-shadowsocks", shadowsocksProbe);
  checkedProtocolProbes.push("shadowsocks");

  const clientProfiles = protocolCatalog
    .filter((protocol) => protocol.clientCapable)
    .map((protocol) => enabledProfile(protocol.type));
  const clientConfig = buildProtocolClientConfig({
    profiles: clientProfiles,
    credential: {
      email: user.email,
      runtimeName: user.runtimeName,
      runtimeUuid: user.runtimeUuid,
      runtimePassword: user.runtimePassword,
      serverPassword: masterPassword
    },
    server: "node.example.com"
  });
  await checkConfig("client-all-managed-protocols", clientConfig);
  await checkConfigStarts("client-dns-runtime", {
    log: { level: "info" },
    dns: {
      servers: [clientConfig.dns.servers.find((server) => server.tag === "dns-local")],
      final: "dns-local"
    },
    inbounds: [],
    outbounds: [{ type: "direct", tag: "direct" }],
    route: {
      final: "direct",
      auto_detect_interface: true
    }
  });

  // Start the complete generated DNS and routing graph as a cold client. Config
  // validation alone misses service-start errors (including invalid DNS detours).
  // Loopback endpoints and disabled listeners keep this check off the host network.
  const coldClientConfig = buildProtocolClientConfig({
    profiles: [shadowsocksProfile],
    credential: {
      email: user.email,
      runtimeName: user.runtimeName,
      runtimeUuid: user.runtimeUuid,
      runtimePassword: user.runtimePassword,
      serverPassword: masterPassword
    },
    server: "127.0.0.1",
    probeUrl: "http://127.0.0.1:1/probe"
  });
  coldClientConfig.inbounds = [];
  coldClientConfig.experimental.cache_file.path = join(temporaryDirectory, "cold-client.db");
  await checkConfigStarts("client-full-cold-start", coldClientConfig);

  assert.equal(checkedProtocols.length, protocolCatalog.length);
  console.log(JSON.stringify({
    singBoxVersion: singBoxVersionLine,
    serverProtocolsChecked: checkedProtocols,
    clientProtocolsChecked: clientConfig.outbounds.filter((outbound) => outbound.server_port).map((outbound) => outbound.type),
    realityProtocolsChecked: checkedRealityProtocols,
    acmeProtocolsChecked: checkedAcmeProtocols,
    protocolProbesChecked: checkedProtocolProbes,
    completeClientColdStart: true
  }));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
