import {
  buildProtocolInbounds,
  defaultProtocolConfigs
} from "./protocol-catalog.js";

function isEligibleUser(user, hostRegion, now) {
  if (!["active", "warning"].includes(user.state)) return false;
  if (user.portalStatus !== "active") return false;
  if (user.usedGb >= user.quotaGb) return false;
  const expiresAt = new Date(`${user.expiresAt}T23:59:59.999Z`);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt < now) return false;
  return user.nodeScope.includes("all") || user.nodeScope.includes(hostRegion);
}

export function buildSingBoxConfig(snapshot, options = {}) {
  const now = options.now || new Date();
  const listenPort = options.listenPort || 8388;
  const users = snapshot.users.filter((user) => isEligibleUser(user, snapshot.host.region, now));
  const profiles = snapshot.protocols || defaultProtocolConfigs(listenPort);

  const config = {
    log: {
      level: "info",
      timestamp: true
    },
    inbounds: buildProtocolInbounds({
      profiles,
      users,
      masterPassword: snapshot.masterPassword,
      runtimeVersion: snapshot.host.runtimeVersion || "1.13.0"
    }),
    outbounds: [{
      type: "direct",
      tag: "direct"
    }],
    route: {
      final: "direct"
    }
  };
  if (snapshot.host.buildTags?.includes("with_v2ray_api")) {
    config.experimental = {
      v2ray_api: {
        listen: "127.0.0.1:10085",
        stats: {
          enabled: true,
          users: users.map((user) => user.email)
        }
      }
    };
  }
  return config;
}
