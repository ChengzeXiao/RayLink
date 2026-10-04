import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";

export const DEFAULT_AI_UPSTREAM = Object.freeze({
  enabled: false, hostId: "local", type: "socks5", server: "", port: 1080,
  username: "", tlsServerName: "", password: "", revision: 0
});
const INPUT_FIELDS = new Set(["enabled", "hostId", "type", "server", "port", "username", "tlsServerName", "password", "clearPassword"]);
const invalid = () => Object.assign(new Error("AI 上游配置无效，请检查主机、协议、地址、端口和认证信息"), {
  code: "INVALID_AI_UPSTREAM", statusCode: 422
});
export function aiUpstreamSecretError() {
  return Object.assign(new Error("AI 上游凭据不可用，请检查加密密钥或重新保存凭据"), {
    code: "AI_UPSTREAM_SECRET_UNAVAILABLE", statusCode: 503
  });
}
function hostname(value, { optional = false, ipAllowed = true } = {}) {
  if (typeof value !== "string" || /[\s\u0000-\u001f\u007f%]/u.test(value)) throw invalid();
  if (optional && value === "") return value;
  if (isIP(value)) {
    if (!ipAllowed) throw invalid();
    return value.toLowerCase();
  }
  if (value.length > 253 || !value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw invalid();
  return value.toLowerCase();
}

export function normalizeAiUpstreamSettings(input, previous = DEFAULT_AI_UPSTREAM) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !INPUT_FIELDS.has(key))) throw invalid();
  const value = { ...previous };
  for (const key of ["enabled", "hostId", "type", "server", "port", "username", "tlsServerName"]) {
    if (input[key] !== undefined) value[key] = input[key];
  }
  if (typeof value.enabled !== "boolean" || value.hostId !== "local"
    || !["socks5", "http", "https"].includes(value.type)
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.username !== "string" || Buffer.byteLength(value.username, "utf8") > 255
    || (input.clearPassword !== undefined && typeof input.clearPassword !== "boolean")) throw invalid();
  value.server = hostname(value.server, { optional: !value.enabled });
  value.tlsServerName = hostname(value.tlsServerName, { optional: true, ipAllowed: false });
  if (input.password !== undefined && (typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") > 255)) throw invalid();
  if (input.clearPassword && input.password) throw invalid();
  if (input.password) value.password = input.password;
  if (input.clearPassword) value.password = "";
  if (Boolean(value.username) !== Boolean(value.password)) throw invalid();
  if (value.type !== "socks5" && value.username.includes(":")) throw invalid();
  const comparable = ({ revision, ...configuration }) => configuration;
  value.revision = previous.revision + Number(!isDeepStrictEqual(comparable(value), comparable(previous)));
  return value;
}

export function publicAiUpstreamSettings(value) {
  return {
    enabled: value.enabled, hostId: value.hostId, type: value.type, server: value.server, port: value.port,
    username: value.username, tlsServerName: value.tlsServerName,
    passwordConfigured: Boolean(value.passwordEncrypted || value.password), revision: value.revision
  };
}
function encryptionKey(material) {
  if (!material) throw aiUpstreamSecretError();
  return createHash("sha256").update(`raylink-ai-upstream-secret-v1\0${material}`).digest();
}
export function encryptAiUpstreamSecret(secret, material, context) {
  if (!secret) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(material), iv);
  cipher.setAAD(Buffer.from(`raylink-ai-upstream-v1:${context}`));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
export function decryptAiUpstreamSecret(envelope, material, context) {
  if (!envelope) return "";
  try {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error();
    const bytes = parts.slice(1).map((part) => {
      if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error();
      const value = Buffer.from(part, "base64url");
      if (value.toString("base64url") !== part) throw new Error();
      return value;
    });
    if (bytes[0].length !== 12 || bytes[1].length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(material), bytes[0]);
    decipher.setAAD(Buffer.from(`raylink-ai-upstream-v1:${context}`));
    decipher.setAuthTag(bytes[1]);
    return Buffer.concat([decipher.update(bytes[2]), decipher.final()]).toString("utf8");
  } catch { throw aiUpstreamSecretError(); }
}

// Deployment history contains rollback candidates, so retain the original key
// order and change only this managed outbound's password value. Native configs
// are restored in memory before publication, never given an encrypted object.
export function protectAiUpstreamConfig(config, material, context) {
  const protectedConfig = structuredClone(config);
  for (const outbound of protectedConfig?.outbounds || []) {
    if (outbound.tag !== "ai-residential" || typeof outbound.password !== "string" || !outbound.password) continue;
    outbound.password = { raylinkAiUpstreamSecret: encryptAiUpstreamSecret(outbound.password, material, `${context}:ai-residential`) };
  }
  return protectedConfig;
}

export function revealAiUpstreamConfig(config, material, context) {
  const restored = structuredClone(config);
  for (const outbound of restored?.outbounds || []) {
    if (outbound.tag !== "ai-residential" || !outbound.password || typeof outbound.password === "string") continue;
    if (typeof outbound.password.raylinkAiUpstreamSecret !== "string" || !outbound.password.raylinkAiUpstreamSecret) throw aiUpstreamSecretError();
    outbound.password = decryptAiUpstreamSecret(outbound.password.raylinkAiUpstreamSecret, material, `${context}:ai-residential`);
  }
  return restored;
}
