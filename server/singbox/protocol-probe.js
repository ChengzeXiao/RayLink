import { createPrivateKey, createPublicKey } from "node:crypto";

import { DEFAULT_ROUTE_PROBE_URL } from "../routing/policy.js";

const supportedTypes = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "naive",
  "anytls",
  "hysteria",
  "tuic",
  "hysteria2"
]);

export const DEFAULT_PROTOCOL_PROBE_URL = DEFAULT_ROUTE_PROBE_URL;

function realityPublicKey(privateKey) {
  const raw = Buffer.from(String(privateKey || ""), "base64url");
  if (raw.length !== 32) throw new Error("Reality 探针私钥无效");
  const prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  const key = createPrivateKey({
    key: Buffer.concat([prefix, raw]),
    type: "pkcs8",
    format: "der"
  });
  return createPublicKey(key)
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64url");
}

function applyTls(outbound, inbound) {
  if (inbound.tls?.enabled !== true) return;
  const serverName = inbound.tls.server_name;
  if (!serverName) throw new Error(`${inbound.type} 外部探针缺少 TLS 服务器名称`);
  outbound.tls = { enabled: true, server_name: serverName };
  if (Array.isArray(inbound.tls.alpn) && inbound.tls.alpn.length) {
    outbound.tls.alpn = [...inbound.tls.alpn];
  }
  if (inbound.tls.reality?.enabled === true) {
    outbound.tls.reality = {
      enabled: true,
      public_key: realityPublicKey(inbound.tls.reality.private_key),
      short_id: inbound.tls.reality.short_id?.[0] || ""
    };
    outbound.tls.utls = { enabled: true, fingerprint: "chrome" };
  }
}

function probeOutbound({ type, address, port, inbound, user }) {
  const common = {
    type,
    tag: "raylink-probe",
    server: address,
    server_port: port
  };
  let outbound;
  if (type === "shadowsocks") {
    outbound = {
      ...common,
      method: inbound.method,
      password: `${inbound.password}:${user.password}`
    };
  } else if (type === "vmess") {
    outbound = { ...common, uuid: user.uuid, security: "auto" };
  } else if (type === "vless") {
    outbound = { ...common, uuid: user.uuid };
  } else if (type === "naive") {
    outbound = {
      ...common,
      username: user.username,
      password: user.password
    };
  } else if (type === "tuic") {
    outbound = {
      ...common,
      uuid: user.uuid,
      password: user.password,
      congestion_control: "bbr"
    };
  } else if (type === "hysteria") {
    outbound = {
      ...common,
      auth_str: user.auth_str,
      up_mbps: inbound.up_mbps,
      down_mbps: inbound.down_mbps
    };
  } else {
    outbound = { ...common, password: user.password };
  }
  applyTls(outbound, inbound);
  if (inbound.transport) outbound.transport = structuredClone(inbound.transport);
  return outbound;
}

export function buildProtocolProbeConfig({
  type,
  address,
  port,
  serverConfig
}) {
  if (!supportedTypes.has(type)) {
    throw new Error(`协议 ${type} 不支持外部握手探针`);
  }
  const inbound = serverConfig.inbounds?.find((entry) => (
    entry.type === type && Number(entry.listen_port) === Number(port)
  ));
  if (!inbound) throw new Error(`找不到 ${type} 的已发布入站配置`);
  const user = inbound.users?.find((entry) => (
    entry.name === "raylink-probe@internal"
    || entry.username === "raylink-probe@internal"
  ))
    || inbound.users?.[0];
  if (!user) throw new Error(`${type} 外部探针需要至少一个有效用户`);

  return {
    log: { disabled: true },
    dns: {
      servers: [{ type: "local", tag: "raylink-probe-dns" }],
      final: "raylink-probe-dns",
      strategy: "prefer_ipv4"
    },
    outbounds: [probeOutbound({ type, address, port, inbound, user })],
    route: {
      final: "raylink-probe",
      default_domain_resolver: "raylink-probe-dns"
    }
  };
}

export const buildUdpProtocolProbeConfig = buildProtocolProbeConfig;
