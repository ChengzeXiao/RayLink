import { z } from "zod/v4";
import { protocolCatalog } from "./singbox/protocol-catalog.js";

const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
const userView = (value) => pick(value, ["id", "name", "initials", "email", "portalStatus", "state", "usedGb", "quotaGb", "nodeScope", "expiresAt", "runtimeSync"]);
const runtimeView = (value) => pick(value, ["state", "mode", "runtimeVersion", "version", "installed", "platform", "architecture", "tags", "binaryPath", "configPath", "validation", "checksum"]);
const previewView = (value) => pick(value, ["checksum", "eligibleUsers", "inboundCount", "listenPort", "protocols"]);
const profileView = (value) => pick(value, ["type", "enabled", "listen", "port", "tls", "transport"]);
const hostView = (value) => ({
  ...pick(value, ["id", "name", "address", "endpointDomain", "region", "status", "kind", "hostname", "platform", "architecture", "agentVersion", "runtimeVersion", "buildTags", "assetEncryptionReady", "usageMetering", "lastSeenAt", "enrolledAt", "telemetry", "deploymentSync", "runtimeUpgrade", "nodeUpgrade", "bbrTask", "protocolActivations", "protocolCatalog"]),
  ...(value?.protocols ? { protocols: value.protocols.map(profileView) } : {}),
  ...(value?.appliedProtocols ? { appliedProtocols: value.appliedProtocols.map(profileView) } : {})
});

function findResource(items, resourceId, kind, key = "id") {
  const value = items?.find((entry) => entry[key] === resourceId);
  if (value) return value;
  const error = new Error(`${kind}不存在`);
  error.code = "RESOURCE_NOT_FOUND";
  error.statusCode = 404;
  throw error;
}

// Defense in depth after the resource allowlist. Advanced JSON and raw errors
// may embed credentials, so ordinary tools expose their status rather than text.
function safeOutput(value) {
  if (Array.isArray(value)) return value.map(safeOutput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    if (key === "passwordReset" && typeof child === "boolean") return [[key, child]];
    if (key === "tokenConfigured" && typeof child === "boolean") return [[key, child]];
    if (key === "subscriptionVerified" && typeof child === "boolean") return [[key, child]];
    if (key === "subscriptionStatus" && ["verified", "awaiting-users"].includes(child)) return [[key, child]];
    if (/password|secret|token|privatekey|runtimeuuid|subscription|authorization|cookie|credential|configtext|configjson|sealedtlsbundle/.test(normalized)
      || ["options", "config", "raw", "error", "lasterror", "rollbackerror"].includes(normalized)) return [];
    return [[key, safeOutput(child)]];
  }));
}

// Every route is fixed here; MCP callers cannot choose a URL, command or HTTP verb.
function defineTool({ name, description, permission = "read", secret = false, mutating = false, additionalScopes = [], preserveRequestId = false,
  fields = {}, method = "GET", path, params = [], body = false, select = (value) => value }) {
  const inputSchema = z.strictObject({ ...fields, ...(mutating ? { requestId } : {}) });
  return {
    name, description, permission, secret, mutating,
    requiresScopes: [permission, ...additionalScopes, ...(secret ? ["secrets.read"] : [])],
    inputSchema,
    request(input) {
      const args = inputSchema.parse(input);
      return {
        method,
        path: typeof path === "function" ? path(args) : path,
        ...(body ? { body: Object.fromEntries(Object.entries(args).filter(([key]) => (preserveRequestId || key !== "requestId") && !params.includes(key))) } : {})
      };
    },
    select: (payload, args = {}) => {
      const selected = select(payload, args);
      return secret ? selected : safeOutput(selected);
    }
  };
}

const userFields = {
  name: z.string().trim().min(1),
  email: z.email(),
  quotaGb: z.number().finite().positive(),
  nodeScope: z.array(z.string().regex(/^(?:all|[a-z0-9][a-z0-9-]{1,31})$/)).min(1),
  expiresAt: z.iso.date(),
  state: z.enum(["active", "warning", "disabled"]).optional(),
  portalStatus: z.enum(["active", "invited"]).optional(),
  usedGb: z.number().finite().nonnegative().optional(),
  password: z.string().min(8).optional()
};
const optionalFields = (fields) => Object.fromEntries(Object.entries(fields).map(([name, schema]) => [name, schema.optional()]));
const userPath = ({ userId }) => `/api/users/${encodeURIComponent(userId)}`;
const hostPath = ({ hostId }) => `/api/hosts/${encodeURIComponent(hostId)}`;
const hostFields = {
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().regex(/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\])$/i),
  region: z.string().trim().regex(/^[a-z0-9-]{2,32}$/i)
};
const subscriptionView = (value) => pick(value, ["subscriptionUrl", "formats", "imports"]);
const enrollmentView = (value) => ({ host: safeOutput(hostView(value.host)), enrollmentToken: value.enrollmentToken });
const deploymentView = (value) => ({ ...pick(value, ["id", "version", "status", "rolloutStatus", "targets", "checksum", "eligibleUsers", "publisherUsername", "createdAt", "publishedAt", "remoteQueued"]),
  ...(value?.error ? { errorPresent: true } : {}), ...(value?.runtime ? { runtime: runtimeView(value.runtime) } : {}) });
const backupView = (value) => pick(value, ["schemaVersion", "filename", "createdAt", "checksum", "sizeBytes", "integrity"]);
const adminView = (value) => pick(value, ["id", "username", "role", "createdAt"]);
const adminFields = { username: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/), role: z.enum(["owner", "operator", "support", "auditor"]), password: z.string().min(12) };
const protocolType = z.enum(protocolCatalog.map((entry) => entry.type));
const port = z.number().int().min(1).max(65535);
const sshCredentialFields = {
  password: z.string().min(1).max(4096).optional(), privateKey: z.string().min(1).max(65536).optional(),
  passphrase: z.string().max(4096).optional(), sudoPassword: z.string().max(4096).optional()
};
const provisioningPath = ({ jobId }) => `/api/hosts/provision/${encodeURIComponent(jobId)}`;
const protocolFields = {
  enabled: z.boolean().optional(), listen: z.string().trim().min(1).optional(), port: port.nullable().optional(),
  tls: z.strictObject({
    mode: z.enum(["none", "certificate", "reality", "acme"]).optional(),
    serverName: z.string().optional(), certificatePath: z.string().optional(), keyPath: z.string().optional(),
    handshakeServer: z.string().optional(), handshakePort: port.optional(),
    privateKey: z.string().optional(), publicKey: z.string().optional(), shortId: z.string().optional(),
    acmeEmail: z.string().optional(), acmeDataDirectory: z.string().optional()
  }).optional(),
  transport: z.strictObject({ type: z.enum(["none", "http", "ws", "quic", "grpc", "httpupgrade"]).optional(), path: z.string().optional(), serviceName: z.string().optional() }).optional(),
  // This named escape hatch is the existing advanced sing-box JSON API, not a
  // free-form REST request. Core identity/auth/listener fields stay managed.
  options: z.record(z.string(), z.json()).refine((value) => !["type", "tag", "listen", "listen_port", "users", "tls", "transport", "__proto__", "constructor", "prototype"].some((key) => Object.hasOwn(value, key)), "Advanced options cannot override managed fields").optional()
};
const protocolPath = (args) => `${hostPath(args)}/protocols/${encodeURIComponent(args.protocolType)}`;
const routingFields = {
  mode: z.enum(["smart", "global-proxy", "direct"]),
  unknownDomain: z.literal("resolve-geoip").optional(),
  rules: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
    match: z.enum(["domain", "domain_suffix", "ip", "ip_cidr"]), value: z.string().trim().min(1).max(253),
    action: z.enum(["direct", "proxy", "ai", "block"]), dns: z.enum(["auto", "domestic", "remote", "system"]).optional(),
    priority: z.number().int().min(0).max(100000).optional(), enabled: z.boolean().optional(), note: z.string().max(160).optional()
  })).max(500)
};

export const mcpTools = [
  defineTool({ name: "system_update_check", description: "Check the official RayLink control-plane release and installation capability; never installs packages.", path: "/api/system/update" }),
  defineTool({ name: "system_upgrade", description: "Start a durable RayLink control-plane update with archive checksum verification, backup and rollback. The control plane restarts; inspect system_overview afterward.", permission: "system.manage", mutating: true, method: "POST", path: "/api/system/upgrade" }),
  defineTool({ name: "hosts_bbr_configure", description: "Enable Linux BBR and fq on a local Host or queue the operation on Node 0.9+. Inspect Host telemetry and bbrTask; queued does not mean enabled. Does not upgrade the kernel or reboot.", permission: "runtime.manage", mutating: true, fields: { hostId: id }, method: "POST", path: (args) => `${hostPath(args)}/bbr` }),
  defineTool({ name: "hosts_node_upgrade", description: "Queue a Node program update from the current control plane, preserving identity and Runtime. Old Nodes lacking the self-update capability need the one-time migration command.", permission: "system.manage", mutating: true, fields: { hostId: id }, method: "POST", path: (args) => `${hostPath(args)}/node-upgrade` }),
  defineTool({ name: "hosts_provision_start", description: "Automatically install a Linux/systemd Node over SSH, enroll it, activate Shadowsocks, publish configuration and verify eligible subscriptions. Requires a reachable HTTPS control plane and root/sudo on the supplied IP. Returns a durable job; poll hosts_provision_get until succeeded. SSH credentials are not stored. Reuse requestId for transport retries.",
    permission: "runtime.manage", additionalScopes: ["hosts.provision"], mutating: true, preserveRequestId: true,
    fields: { host: z.union([z.ipv4(), z.ipv6()]), port: port.optional(), username: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/).optional(),
      name: hostFields.name.optional(), region: hostFields.region.optional(), domainMode: z.enum(["auto", "existing", "none"]).optional(),
      endpointDomain: z.string().trim().min(1).max(253).optional(), inheritProtocols: z.boolean().optional(), ...sshCredentialFields },
    method: "POST", path: "/api/hosts/provision", body: true }),
  defineTool({ name: "hosts_provision_list", description: "List durable SSH onboarding jobs and safe progress, including interrupted attempts.", path: "/api/hosts/provision" }),
  defineTool({ name: "hosts_provision_get", description: "Read onboarding status and evidence. succeeded verifies node, protocol and metering; subscriptionStatus awaiting-users means no entitled user exists yet.", fields: { jobId: id }, path: provisioningPath }),
  defineTool({ name: "hosts_provision_retry", description: "Resume a failed or interrupted onboarding job without creating another Host. Supply SSH credentials again if installation/enrollment is incomplete. Use a NEW requestId for this intentional retry; transport retries reuse that requestId.",
    permission: "runtime.manage", additionalScopes: ["hosts.provision"], mutating: true, preserveRequestId: true, fields: { jobId: id, ...sshCredentialFields }, params: ["jobId"],
    method: "POST", path: (args) => `${provisioningPath(args)}/retry`, body: true }),
  defineTool({ name: "system_overview", description: "Read a curated control-plane overview; excludes user records, administrator lists, audit records and credentials.", path: "/api/bootstrap",
    select: (payload) => ({ currentAdmin: pick(payload.currentAdmin, ["id", "username", "role"]), userCount: payload.users?.length || 0,
      hostCount: payload.hosts?.length || 0, runtime: runtimeView(payload.runtime), runtimePreview: previewView(payload.runtimePreview),
      installation: runtimeView(payload.installation), bbr: payload.bbr, runtimeSetup: payload.runtimeSetup, systemUpdate: payload.systemUpdate, routingRuleSets: payload.routingRuleSets }) }),
  defineTool({ name: "users_list", description: "List users and their independent entitlements without subscription credentials.", path: "/api/bootstrap", select: (payload) => ({ users: payload.users.map(userView) }) }),
  defineTool({ name: "users_get", description: "Read one user's entitlement and state without subscription credentials.", fields: { userId: id }, path: "/api/bootstrap", select: (payload, args) => userView(findResource(payload.users, args.userId, "用户")) }),
  defineTool({ name: "hosts_list", description: "List Hosts, applied protocol summaries and operational evidence without private keys or advanced configuration JSON.", path: "/api/bootstrap", select: (payload) => ({ hosts: payload.hosts.map(hostView) }) }),
  defineTool({ name: "hosts_get", description: "Read one Host without private keys or advanced configuration JSON.", fields: { hostId: id }, path: "/api/bootstrap", select: (payload, args) => hostView(findResource(payload.hosts, args.hostId, "主机")) }),
  defineTool({ name: "users_create", description: "Create a user-owned entitlement. Returns no subscription secret; runtimeSync distinguishes saved from published.",
    permission: "users.manage", mutating: true, fields: userFields, method: "POST", path: "/api/users", body: true, select: userView }),
  defineTool({ name: "users_update", description: "Update user entitlement or state. Disabling or exhausting quota schedules credential revocation; inspect runtimeSync for pending publication.",
    permission: "users.manage", mutating: true, fields: { userId: id, ...optionalFields(userFields) }, method: "PATCH", path: userPath, params: ["userId"], body: true, select: userView }),
  defineTool({ name: "users_reset_password", description: "Replace a user's portal password and revoke portal sessions; preserves subscription and entitlement.",
    permission: "users.manage", mutating: true, fields: { userId: id, password: z.string().min(8) }, method: "POST", path: (args) => `${userPath(args)}/password/reset`, params: ["userId"], body: true,
    select: (value) => pick(value, ["passwordReset", "sessionsRevoked"]) }),
  defineTool({ name: "users_subscription_get", description: "Read the existing secret subscription URL, client format URLs and import links. Does not rotate credentials.",
    secret: true, fields: { userId: id }, path: (args) => `${userPath(args)}/subscription`, select: subscriptionView }),
  defineTool({ name: "users_subscription_rotate", description: "Generate a new secret subscription URL and revoke the previous URL. Update every client that used it.",
    permission: "users.manage", secret: true, mutating: true, fields: { userId: id }, method: "POST", path: (args) => `${userPath(args)}/subscription/rotate`, select: subscriptionView }),
  defineTool({ name: "hosts_create", description: "Create a remote Host and return its one-time enrollment token. Installing RayLink Node and receiving a heartbeat are separate steps; this does not SSH into the Host.",
    permission: "runtime.manage", secret: true, mutating: true, fields: hostFields, method: "POST", path: "/api/hosts", body: true, select: enrollmentView }),
  defineTool({ name: "hosts_update", description: "Update Host name, client address or region. Address changes invalidate protocol health evidence; remeasure before trusting readiness.",
    permission: "runtime.manage", mutating: true, fields: { hostId: id, ...optionalFields(hostFields) }, method: "PATCH", path: hostPath, params: ["hostId"], body: true, select: hostView }),
  defineTool({ name: "hosts_enrollment_rotate", description: "Replace the one-time enrollment token for a Host that has not enrolled. Previously issued enrollment tokens stop working.",
    permission: "runtime.manage", secret: true, mutating: true, fields: { hostId: id }, method: "POST", path: (args) => `${hostPath(args)}/enrollment-token`, select: enrollmentView }),
  defineTool({ name: "hosts_runtime_upgrade", description: "Queue the approved Runtime upgrade on an enrolled remote Host. Node compatibility and build gates still apply; queued does not mean completed.",
    permission: "runtime.manage", mutating: true, fields: { hostId: id }, method: "POST", path: (args) => `${hostPath(args)}/runtime-upgrade`, select: (value) => pick(value, ["taskId", "status", "targetVersion"]) }),
  defineTool({ name: "hosts_protocol_get", description: "Read a Host's complete configured protocol, including private keys and advanced options. Requires secrets.read; use hosts_get for a safe summary.",
    permission: "runtime.manage", secret: true, fields: { hostId: id, protocolType }, path: "/api/bootstrap", select: (payload, args) => {
      const host = findResource(payload.hosts, args.hostId, "主机");
      return findResource(host.protocols, args.protocolType, "协议", "type");
    } }),
  defineTool({ name: "hosts_protocol_update", description: "Save a protocol configuration without publishing it. TLS and transport fields are explicit; options supports existing advanced sing-box JSON but cannot override managed listener or user fields.",
    permission: "runtime.manage", mutating: true, fields: { hostId: id, protocolType, ...protocolFields }, method: "PATCH", path: protocolPath, params: ["hostId", "protocolType"], body: true, select: profileView }),
  defineTool({ name: "hosts_protocol_activate", description: "Enable a protocol through the managed port, certificate, firewall, publication and connectivity workflow. Remote activation may remain pending until the Node reports completion.",
    permission: "runtime.manage", mutating: true, fields: { hostId: id, protocolType }, method: "POST", path: (args) => `${protocolPath(args)}/activate`, select: (value) => ({ profile: profileView(value.profile), activation: value.activation, deployment: value.deployment }) }),
  defineTool({ name: "hosts_protocol_measure", description: "Run protocol connection samples and save health evidence for a Host. Configuration changes cause skipped results that should be retried after publication; server probes do not prove mobile-client reachability.",
    permission: "runtime.manage", mutating: true, fields: { hostId: id }, method: "POST", path: (args) => `${hostPath(args)}/protocols/latency`, select: (value) => pick(value, ["hostId", "checkedAt", "results"]) }),
  defineTool({ name: "routing_get", description: "Read routing policy and verified rule-set status.", path: "/api/bootstrap", select: (value) => ({ policy: value.routingPolicy, ruleSets: value.routingRuleSets }) }),
  defineTool({ name: "routing_update", description: "Replace the routing policy. Supply the full rules array; omitted rules are not preserved. Regenerate or refresh client subscriptions to consume the new policy.",
    permission: "runtime.manage", mutating: true, fields: routingFields, method: "PATCH", path: "/api/settings/routing", body: true, select: (value) => pick(value, ["mode", "unknownDomain", "rules"]) }),
  defineTool({ name: "routing_diagnose", description: "Diagnose a domain using current routing policy and rule sets without changing settings. This may perform DNS/rule matching; it does not prove the user's final network path.",
    permission: "runtime.manage", fields: { domain: z.string().trim().min(1).max(253) }, method: "POST", path: "/api/routing/diagnose", body: true }),
  defineTool({ name: "certificate_get", description: "Read automatic-certificate notification settings, not certificate private keys.", path: "/api/bootstrap", select: (value) => pick(value.certificate, ["mode", "email"]) }),
  defineTool({ name: "node_domains_get", description: "Read node DNS automation settings and whether a credential is configured; never returns the DNS API Token.", path: "/api/settings/node-domains" }),
  defineTool({ name: "node_domains_update", description: "Configure Cloudflare node subdomain automation. Token needs Zone Read and DNS Edit for the selected zone; blank apiToken preserves it. Existing resolved domains work without Cloudflare. DNS changes occur during onboarding, not while saving settings.",
    permission: "system.manage", mutating: true, fields: { provider: z.enum(["disabled", "cloudflare"]).optional(), zoneId: z.string().max(32).optional(), baseDomain: z.string().max(253).optional(),
      apiToken: z.string().max(4096).optional(), clearToken: z.boolean().optional(), autoProvision: z.boolean().optional(), inheritProtocols: z.boolean().optional() },
    method: "PATCH", path: "/api/settings/node-domains", body: true }),
  defineTool({ name: "certificate_update", description: "Update the ACME notification email. Does not issue or replace certificates by itself.",
    permission: "system.manage", mutating: true, fields: { email: z.email() }, method: "PATCH", path: "/api/settings/certificate", body: true, select: (value) => pick(value, ["mode", "email"]) }),
  defineTool({ name: "runtime_status", description: "Inspect the local managed Runtime service. Staged configuration does not mean the service is running.", path: "/api/runtime/status", select: runtimeView }),
  defineTool({ name: "runtime_installation", description: "Inspect local Runtime version, platform and build capabilities.", path: "/api/runtime/installation", select: runtimeView }),
  defineTool({ name: "runtime_update_check", description: "Check the control-plane-approved Runtime release and compatibility gates; does not install an update.", path: "/api/runtime/update" }),
  defineTool({ name: "runtime_install", description: "Install and configure the approved Linux Runtime, enable Shadowsocks, apply BBR when supported, publish and verify service health. Unsupported development mode is rejected.",
    permission: "runtime.manage", mutating: true, method: "POST", path: "/api/runtime/install", select: (value) => ({ ...runtimeView(value), ready: value.ready, bbr: value.bbr, warnings: value.warnings, runtime: runtimeView(value.runtime), runtimeSetup: value.runtimeSetup }) }),
  defineTool({ name: "runtime_upgrade", description: "Upgrade the local Runtime to the approved available version, validate active configuration and restart with automatic rollback on failure. May interrupt connections.",
    permission: "runtime.manage", mutating: true, method: "POST", path: "/api/runtime/upgrade" }),
  defineTool({ name: "runtime_reality_keypair", description: "Generate a Reality public/private key pair and short ID. Treat the returned private key as a secret; generation alone does not configure a protocol.",
    permission: "runtime.manage", secret: true, mutating: true, method: "POST", path: "/api/runtime/reality-keypair", select: (value) => pick(value, ["privateKey", "publicKey", "shortId"]) }),
  defineTool({ name: "deployments_list", description: "List immutable publication summaries and per-Host application status without raw configuration or credentials.", path: "/api/deployments", select: (value) => ({ deployments: value.deployments.map(deploymentView) }) }),
  defineTool({ name: "deployments_preview", description: "Preview configuration checksum, eligible user count and inbound types without publishing or revealing credentials.", permission: "runtime.manage", method: "POST", path: "/api/deployments/preview", select: previewView }),
  defineTool({ name: "deployments_publish", description: "Publish the current managed configuration locally and queue enrolled remote Hosts. Inspect rollout targets; local success does not prove every remote applied it.",
    permission: "runtime.manage", mutating: true, method: "POST", path: "/api/deployments", select: deploymentView }),
  defineTool({ name: "deployments_rollback", description: "Republish a historical immutable configuration as a new deployment. Historical credentials and protocol settings can be restored; assess revoked users before rollback.",
    permission: "runtime.manage", mutating: true, fields: { deploymentId: id }, method: "POST", path: ({ deploymentId }) => `/api/deployments/${encodeURIComponent(deploymentId)}/rollback`, select: deploymentView }),
  defineTool({ name: "backups_list", description: "List database backup manifests. Creation-time integrity evidence does not verify the current file; use backups_verify.", path: "/api/backups", select: (value) => ({ backups: value.backups.map(backupView) }) }),
  defineTool({ name: "backups_create", description: "Create a checksummed online SQLite backup and apply configured retention. Does not export or restore database contents.",
    permission: "system.manage", mutating: true, method: "POST", path: "/api/backups", select: backupView }),
  defineTool({ name: "backups_verify", description: "Read and verify an existing backup's checksum and SQLite integrity without restoring it.", permission: "system.manage", fields: { filename: z.string().regex(/^raylink-\d{8}T\d{6}-[a-f0-9]{8}\.sqlite$/) }, method: "POST",
    path: ({ filename }) => `/api/backups/${encodeURIComponent(filename)}/verify`, select: (value) => pick(value, ["filename", "valid", "checksum", "expectedChecksum", "integrity"]) }),
  defineTool({ name: "alerts_get", description: "Read operational alerts and webhook delivery status without sending an alert.", path: "/api/alerts", select: (value) => ({ alerts: value.alerts.map((alert) => pick(alert, ["id", "code", "severity", "title", "resourceType", "resourceId", "createdAt"])), delivery: pick(value.delivery, ["enabled", "active", "lastSuccessAt"]) }) }),
  defineTool({ name: "readiness_get", description: "Run a read-only control-plane readiness report and reverify the latest backup. Does not run throughput tests, restart services or establish real mobile-network availability.", path: "/api/operations/readiness", select: (value) => pick(value, ["schemaVersion", "generatedAt", "status", "summary", "checks", "limitations"]) }),
  defineTool({ name: "admins_list", description: "List administrator identities and roles; requires the same administrator-management role permission as the HTTP endpoint.", permission: "admins.manage", path: "/api/admins", select: (value) => ({ admins: value.admins.map(adminView) }) }),
  defineTool({ name: "admins_create", description: "Create an administrator with an explicit role. Only the existing admins.manage role can do this; token scope cannot elevate that role.",
    permission: "admins.manage", mutating: true, fields: adminFields, method: "POST", path: "/api/admins", body: true, select: adminView }),
  defineTool({ name: "admins_update", description: "Update another administrator's username, password or role. Password reset revokes their browser sessions and MCP tokens. Self username/password changes require the browser account workflow and current password. Last-owner protections apply.",
    permission: "admins.manage", mutating: true, fields: { adminId: id, ...optionalFields(adminFields) }, method: "PATCH", path: ({ adminId }) => `/api/admins/${encodeURIComponent(adminId)}`, params: ["adminId"], body: true, select: adminView }),
  defineTool({ name: "audit_list", description: "Read recent audit event identities, actions and status codes. Raw metadata and secrets are excluded.", permission: "audit.read", fields: { limit: z.number().int().min(1).max(500).optional() }, path: ({ limit }) => `/api/audit${limit === undefined ? "" : `?limit=${limit}`}`,
    select: (value) => ({ events: value.events.map((event) => ({ ...pick(event, ["id", "adminId", "actorUsername", "actorRole", "action", "resourceType", "resourceId", "createdAt"]), metadata: pick(event.metadata, ["statusCode", "tool", "requestId", "replayed", "durationMs"]) })) }) })
];
