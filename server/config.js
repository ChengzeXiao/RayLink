import { isIP } from "node:net";
import { join, resolve } from "node:path";

import { DEFAULT_ROUTE_PROBE_URL } from "./routing/policy.js";

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function optionalHttpUrl(value, name) {
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL`);
  }
  return parsed;
}

function optionalIpAddress(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!isIP(normalized)) throw new Error(`${name} must be a valid IP address`);
  return normalized;
}

function ipAddressList(value, fallback, name) {
  const addresses = String(value || "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  const normalized = addresses.length ? addresses : fallback;
  if (!normalized.length || normalized.some((address) => !isIP(address))) {
    throw new Error(`${name} must contain valid IP addresses`);
  }
  return normalized;
}

export function loadConfig(env = process.env) {
  const host = env.RAYLINK_HOST || "127.0.0.1";
  const port = positiveInteger(env.RAYLINK_PORT, 4173, "RAYLINK_PORT");
  const dataDir = resolve(env.RAYLINK_DATA_DIR || "./data");
  const publicOrigin = env.RAYLINK_PUBLIC_ORIGIN || `http://${host}:${port}`;
  const subscriptionOrigin = env.RAYLINK_SUBSCRIPTION_ORIGIN || publicOrigin;
  const protocolProbeUrl = env.RAYLINK_PROTOCOL_PROBE_URL
    || DEFAULT_ROUTE_PROBE_URL;
  const alertWebhookUrl = env.RAYLINK_ALERT_WEBHOOK_URL || "";
  const parsedAlertWebhookUrl = optionalHttpUrl(
    alertWebhookUrl,
    "RAYLINK_ALERT_WEBHOOK_URL"
  );
  const setupRequired = env.RAYLINK_SETUP_REQUIRED === "true";
  if (env.NODE_ENV === "production" && new URL(publicOrigin).protocol !== "https:") {
    throw new Error("RAYLINK_PUBLIC_ORIGIN must use HTTPS in production");
  }
  if (env.NODE_ENV === "production" && new URL(subscriptionOrigin).protocol !== "https:") {
    throw new Error("RAYLINK_SUBSCRIPTION_ORIGIN must use HTTPS in production");
  }
  if (env.NODE_ENV === "production" && new URL(protocolProbeUrl).protocol !== "https:") {
    throw new Error("RAYLINK_PROTOCOL_PROBE_URL must use HTTPS in production");
  }
  if (
    parsedAlertWebhookUrl
    && env.NODE_ENV === "production"
    && parsedAlertWebhookUrl.protocol !== "https:"
  ) {
    throw new Error("RAYLINK_ALERT_WEBHOOK_URL must use HTTPS in production");
  }
  if (Boolean(env.RAYLINK_SETUP_TOKEN_HASH) !== Boolean(env.RAYLINK_SETUP_TOKEN_EXPIRES_AT)) {
    throw new Error("RAYLINK_SETUP_TOKEN_HASH and RAYLINK_SETUP_TOKEN_EXPIRES_AT must be set together");
  }
  const runtimeMode = env.RAYLINK_RUNTIME_MODE || "dry-run";
  if (!["dry-run", "systemd"].includes(runtimeMode)) {
    throw new Error("RAYLINK_RUNTIME_MODE must be dry-run or systemd");
  }
  const adminPassword = env.RAYLINK_ADMIN_PASSWORD || "Admin@2026";
  if (env.NODE_ENV === "production" && adminPassword === "Admin@2026") {
    throw new Error("RAYLINK_ADMIN_PASSWORD must be changed in production");
  }
  const subscriptionEncryptionKey = env.RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY
    || (env.NODE_ENV === "production" ? "" : adminPassword);
  if (env.NODE_ENV === "production" && !subscriptionEncryptionKey) {
    throw new Error("RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY must be set in production");
  }

  return {
    host,
    port,
    dataDir,
    ruleSetManifestPath: env.RAYLINK_RULE_SET_MANIFEST
      ? resolve(env.RAYLINK_RULE_SET_MANIFEST) : null,
    adminUsername: env.RAYLINK_ADMIN_USERNAME || "admin",
    adminPassword,
    subscriptionEncryptionKey,
    seedDemoData: env.NODE_ENV !== "production",
    trustProxy: env.RAYLINK_TRUST_PROXY === "true",
    publicOrigin,
    subscriptionOrigin,
    proxyHost: env.RAYLINK_PROXY_HOST || new URL(publicOrigin).hostname,
    localHostDialAddress: optionalIpAddress(
      env.RAYLINK_LOCAL_HOST_DIAL_ADDRESS,
      "RAYLINK_LOCAL_HOST_DIAL_ADDRESS"
    ),
    endpointDnsServers: ipAddressList(
      env.RAYLINK_ENDPOINT_DNS_SERVERS,
      ["1.1.1.1", "8.8.8.8"],
      "RAYLINK_ENDPOINT_DNS_SERVERS"
    ),
    endpointProbeTimeoutMs: positiveInteger(
      env.RAYLINK_ENDPOINT_PROBE_TIMEOUT_MS,
      1_500,
      "RAYLINK_ENDPOINT_PROBE_TIMEOUT_MS"
    ),
    endpointDnsTimeoutMs: positiveInteger(
      env.RAYLINK_ENDPOINT_DNS_TIMEOUT_MS,
      2_000,
      "RAYLINK_ENDPOINT_DNS_TIMEOUT_MS"
    ),
    protocolProbeUrl,
    alertWebhookUrl,
    alertIntervalMs: nonNegativeInteger(
      env.RAYLINK_ALERT_INTERVAL_MS,
      60_000,
      "RAYLINK_ALERT_INTERVAL_MS"
    ),
    runtimeMode,
    preferMeteredRuntime: env.RAYLINK_USER_METERING !== "false",
    singBoxBinary: env.SING_BOX_BIN || "sing-box",
    systemdUnit: env.SING_BOX_SYSTEMD_UNIT || "sing-box.service",
    listenPort: positiveInteger(env.RAYLINK_PROXY_PORT, 8388, "RAYLINK_PROXY_PORT"),
    setupRequired,
    setupTokenHash: env.RAYLINK_SETUP_TOKEN_HASH || "",
    setupTokenExpiresAt: env.RAYLINK_SETUP_TOKEN_EXPIRES_AT || "",
    caddyBinary: env.RAYLINK_CADDY_BIN || "caddy",
    caddyfilePath: resolve(env.RAYLINK_CADDYFILE || "/etc/caddy/Caddyfile"),
    environmentFilePath: resolve(env.RAYLINK_ENV_FILE || "/etc/raylink/raylink.env"),
    bbrConfigPath: resolve(
      env.RAYLINK_BBR_CONFIG || "/var/lib/raylink/managed/99-raylink-bbr.conf"
    ),
    backupDir: resolve(env.RAYLINK_BACKUP_DIR || join(dataDir, "backups")),
    backupRetentionCount: positiveInteger(
      env.RAYLINK_BACKUP_RETENTION_COUNT,
      14,
      "RAYLINK_BACKUP_RETENTION_COUNT"
    ),
    backupIntervalMs: nonNegativeInteger(
      env.RAYLINK_BACKUP_INTERVAL_MS,
      24 * 60 * 60 * 1000,
      "RAYLINK_BACKUP_INTERVAL_MS"
    ),
    controlPlaneCertificatePath: resolve(
      env.RAYLINK_CONTROL_CERT || "/etc/caddy/raylink/control-plane.crt"
    ),
    controlPlanePrivateKeyPath: resolve(
      env.RAYLINK_CONTROL_KEY || "/etc/caddy/raylink/control-plane.key"
    )
  };
}
