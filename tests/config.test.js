import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../server/config.js";

const productionSecrets = {
  RAYLINK_ADMIN_PASSWORD: "a-production-password",
  RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY: "a-production-subscription-key"
};

test("production control plane requires an HTTPS public origin", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "http://panel.example.com",
      ...productionSecrets
    }),
    /must use HTTPS/
  );
  assert.equal(
    loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      ...productionSecrets
    }).publicOrigin,
    "https://panel.example.com"
  );
});

test("subscription origin is independent from the control-plane and Host addresses", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
    RAYLINK_SUBSCRIPTION_ORIGIN: "https://sub.example.com",
    RAYLINK_PROXY_HOST: "node.example.com",
    RAYLINK_LOCAL_HOST_DIAL_ADDRESS: "203.0.113.10",
    ...productionSecrets
  });

  assert.equal(config.publicOrigin, "https://panel.example.com");
  assert.equal(config.subscriptionOrigin, "https://sub.example.com");
  assert.equal(config.proxyHost, "node.example.com");
  assert.equal(config.localHostDialAddress, "203.0.113.10");
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      RAYLINK_LOCAL_HOST_DIAL_ADDRESS: "not-an-ip",
      ...productionSecrets
    }),
    /RAYLINK_LOCAL_HOST_DIAL_ADDRESS must be a valid IP address/
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      RAYLINK_SUBSCRIPTION_ORIGIN: "http://sub.example.com",
      ...productionSecrets
    }),
    /RAYLINK_SUBSCRIPTION_ORIGIN must use HTTPS/
  );
});

test("smart endpoint resolution uses configurable trusted DNS and probe timeout", () => {
  const config = loadConfig({
    RAYLINK_ENDPOINT_DNS_SERVERS: "1.1.1.1, 8.8.8.8",
    RAYLINK_ENDPOINT_DNS_TIMEOUT_MS: "1800",
    RAYLINK_ENDPOINT_PROBE_TIMEOUT_MS: "2500"
  });

  assert.deepEqual(config.endpointDnsServers, ["1.1.1.1", "8.8.8.8"]);
  assert.equal(config.endpointDnsTimeoutMs, 1_800);
  assert.equal(config.endpointProbeTimeoutMs, 2_500);
  assert.deepEqual(loadConfig({}).endpointDnsServers, ["1.1.1.1", "8.8.8.8"]);
  assert.throws(
    () => loadConfig({ RAYLINK_ENDPOINT_DNS_SERVERS: "1.1.1.1,not-an-ip" }),
    /RAYLINK_ENDPOINT_DNS_SERVERS must contain valid IP addresses/
  );
});

test("Runtime DNS environment selects verified resolvers and private zones while validating startup settings", () => {
  const defaults = loadConfig({}).runtimeDns;
  assert.equal(defaults?.mode, "auto");
  assert.equal(defaults.primary, "1.1.1.1");
  assert.equal(defaults.secondary, "9.9.9.9");
  const configured = loadConfig({ RAYLINK_RUNTIME_DNS_MODE: "auto", RAYLINK_RUNTIME_DNS_PRIMARY: "192.0.2.53",
    RAYLINK_RUNTIME_DNS_PRIMARY_SERVER_NAME: " Resolver.Example. ", RAYLINK_RUNTIME_DNS_SECONDARY: "2001:db8::53",
    RAYLINK_RUNTIME_DNS_SECONDARY_SERVER_NAME: "backup.example", RAYLINK_RUNTIME_DNS_PRIVATE_SUFFIXES: "corp.example, .Internal.Example.,corp.example" }).runtimeDns;
  assert.equal(configured.primary, "192.0.2.53");
  assert.equal(configured.primaryServerName, "resolver.example");
  assert.equal(configured.secondary, "2001:db8::53");
  assert.equal(configured.secondaryServerName, "backup.example");
  assert.deepEqual(configured.privateSuffixes, ["corp.example", "internal.example"]);
  assert.equal(loadConfig({ RAYLINK_RUNTIME_DNS_MODE: "system" }).runtimeDns.mode, "system");
  for (const settings of [{ RAYLINK_RUNTIME_DNS_MODE: "typo" }, { RAYLINK_RUNTIME_DNS_PRIMARY: "resolver.example" },
    { RAYLINK_RUNTIME_DNS_SECONDARY: "invalid" }, { RAYLINK_RUNTIME_DNS_PRIMARY_SERVER_NAME: "*.example" },
    { RAYLINK_RUNTIME_DNS_SECONDARY_SERVER_NAME: "https://dns.example" }, { RAYLINK_RUNTIME_DNS_PRIVATE_SUFFIXES: "*.corp.example" }]) {
    assert.throws(() => loadConfig(settings), { code: "INVALID_RUNTIME_DNS" });
  }
});

test("TLS renewal inspection interval defaults to fifteen minutes and permits explicit disable", () => {
  assert.equal(loadConfig({}).tlsRenewalIntervalMs, 900_000);
  assert.equal(loadConfig({ RAYLINK_TLS_RENEWAL_INTERVAL_MS: "0" }).tlsRenewalIntervalMs, 0);
  assert.equal(loadConfig({ RAYLINK_TLS_RENEWAL_INTERVAL_MS: "60000" }).tlsRenewalIntervalMs, 60_000);
  for (const value of ["-1", "1.5", "NaN", "9007199254740992"]) {
    assert.throws(() => loadConfig({ RAYLINK_TLS_RENEWAL_INTERVAL_MS: value }), /RAYLINK_TLS_RENEWAL_INTERVAL_MS must be a non-negative integer/);
  }
});

test("subscription bearer encryption requires a dedicated production key", () => {
  const dedicated = loadConfig({
    RAYLINK_ADMIN_PASSWORD: "admin-password",
    RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY: "subscription-encryption-key"
  });
  assert.equal(
    dedicated.subscriptionEncryptionKey,
    "subscription-encryption-key"
  );

  const upgraded = loadConfig({
    RAYLINK_ADMIN_PASSWORD: "stable-bootstrap-password"
  });
  assert.equal(
    upgraded.subscriptionEncryptionKey,
    "stable-bootstrap-password"
  );
  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
    RAYLINK_ADMIN_PASSWORD: "a-production-password"
  }), /RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY must be set/);
});

test("protocol probe endpoint is configurable and must use HTTPS in production", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
    ...productionSecrets,
    RAYLINK_PROTOCOL_PROBE_URL: "https://probe.example.com/generate_204"
  });
  assert.equal(
    config.protocolProbeUrl,
    "https://probe.example.com/generate_204"
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      ...productionSecrets,
      RAYLINK_PROTOCOL_PROBE_URL: "http://probe.example.com/"
    }),
    /RAYLINK_PROTOCOL_PROBE_URL must use HTTPS/
  );
});

test("online backup schedule and retention are configurable and validated", () => {
  const config = loadConfig({
    RAYLINK_BACKUP_DIR: "/var/backups/raylink/database",
    RAYLINK_BACKUP_RETENTION_COUNT: "30",
    RAYLINK_BACKUP_INTERVAL_MS: "3600000"
  });
  assert.equal(config.backupDir, "/var/backups/raylink/database");
  assert.equal(config.backupRetentionCount, 30);
  assert.equal(config.backupIntervalMs, 3_600_000);
  assert.equal(
    loadConfig({ RAYLINK_DATA_DIR: "/var/lib/raylink" }).backupDir,
    "/var/lib/raylink/backups"
  );
  assert.throws(
    () => loadConfig({ RAYLINK_BACKUP_INTERVAL_MS: "-1" }),
    /must be a non-negative integer/
  );
});

test("alert webhook is configurable and requires HTTPS in production", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
    ...productionSecrets,
    RAYLINK_ALERT_WEBHOOK_URL: "https://alerts.example.com/raylink",
    RAYLINK_ALERT_INTERVAL_MS: "30000"
  });
  assert.equal(config.alertWebhookUrl, "https://alerts.example.com/raylink");
  assert.equal(config.alertIntervalMs, 30_000);
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      ...productionSecrets,
      RAYLINK_ALERT_WEBHOOK_URL: "http://alerts.example.com/raylink"
    }),
    /RAYLINK_ALERT_WEBHOOK_URL must use HTTPS/
  );
  assert.throws(
    () => loadConfig({
      RAYLINK_ALERT_WEBHOOK_URL: "not-a-url"
    }),
    /RAYLINK_ALERT_WEBHOOK_URL must be a valid HTTP or HTTPS URL/
  );
  assert.throws(
    () => loadConfig({
      RAYLINK_ALERT_WEBHOOK_URL: "file:///tmp/raylink-alerts"
    }),
    /RAYLINK_ALERT_WEBHOOK_URL must be a valid HTTP or HTTPS URL/
  );
});

test("production first-run mode still requires HTTPS and a hashed expiring token", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "http://203.0.113.10:4173",
      ...productionSecrets,
      RAYLINK_SETUP_REQUIRED: "true",
      RAYLINK_SETUP_TOKEN_HASH: "hashed-token",
      RAYLINK_SETUP_TOKEN_EXPIRES_AT: "2026-07-27T00:00:00.000Z"
    }),
    /must use HTTPS/
  );
  const uninitialized = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://203.0.113.10",
    ...productionSecrets,
    RAYLINK_SETUP_REQUIRED: "true"
  });
  assert.equal(uninitialized.setupRequired, true);
  assert.equal(uninitialized.setupTokenHash, "");
  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://203.0.113.10",
    ...productionSecrets,
    RAYLINK_SETUP_REQUIRED: "true",
    RAYLINK_SETUP_TOKEN_HASH: "hash-without-expiry"
  }), /must be set together/);
});

test("first-run configuration exposes the managed Caddy access paths", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://203.0.113.10",
    ...productionSecrets,
    RAYLINK_SETUP_REQUIRED: "true",
    RAYLINK_CADDY_BIN: "/usr/bin/caddy",
    RAYLINK_CADDYFILE: "/etc/caddy/Caddyfile",
    RAYLINK_ENV_FILE: "/etc/raylink/raylink.env",
    RAYLINK_BBR_CONFIG: "/var/lib/raylink/managed/99-raylink-bbr.conf",
    RAYLINK_CONTROL_CERT: "/etc/caddy/raylink/control-plane.crt",
    RAYLINK_CONTROL_KEY: "/etc/caddy/raylink/control-plane.key"
  });

  assert.deepEqual({
    caddyBinary: config.caddyBinary,
    caddyfilePath: config.caddyfilePath,
    environmentFilePath: config.environmentFilePath,
    bbrConfigPath: config.bbrConfigPath,
    controlPlaneCertificatePath: config.controlPlaneCertificatePath,
    controlPlanePrivateKeyPath: config.controlPlanePrivateKeyPath
  }, {
    caddyBinary: "/usr/bin/caddy",
    caddyfilePath: "/etc/caddy/Caddyfile",
    environmentFilePath: "/etc/raylink/raylink.env",
    bbrConfigPath: "/var/lib/raylink/managed/99-raylink-bbr.conf",
    controlPlaneCertificatePath: "/etc/caddy/raylink/control-plane.crt",
    controlPlanePrivateKeyPath: "/etc/caddy/raylink/control-plane.key"
  });
});
