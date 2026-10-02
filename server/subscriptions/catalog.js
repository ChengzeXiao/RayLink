const subscriptionFormats = Object.freeze([
  Object.freeze({
    id: "mihomo-modern",
    responseKey: "mihomoModern",
    aliases: Object.freeze(["mihomo-modern"]),
    portalAliases: Object.freeze(["mihomo-modern"]),
    pathSuffix: "mihomo-modern.yaml"
  }),
  Object.freeze({
    id: "mihomo",
    responseKey: "mihomo",
    aliases: Object.freeze(["mihomo", "clash", "clash-meta"]),
    portalAliases: Object.freeze(["mihomo"]),
    pathSuffix: "mihomo.yaml",
    userAgentPriority: 20,
    userAgent: /(?:clash|mihomo|flclash|stash)/
  }),
  Object.freeze({
    id: "loon",
    responseKey: "loon",
    aliases: Object.freeze(["loon"]),
    portalAliases: Object.freeze(["loon"]),
    pathSuffix: "loon.list",
    useUniversalUrl: true,
    userAgentPriority: 30,
    userAgent: /loon/
  }),
  Object.freeze({
    id: "egern",
    responseKey: "egern",
    aliases: Object.freeze(["egern"]),
    portalAliases: Object.freeze(["egern"]),
    pathSuffix: "egern.yaml",
    userAgentPriority: 40,
    userAgent: /egern/
  }),
  Object.freeze({
    id: "egern-profile",
    responseKey: "egernProfile",
    aliases: Object.freeze(["egern-profile"]),
    portalAliases: Object.freeze(["egern-profile"]),
    pathSuffix: "egern-profile.yaml"
  }),
  Object.freeze({
    id: "singbox",
    responseKey: "singbox",
    aliases: Object.freeze(["singbox", "sing-box"]),
    portalAliases: Object.freeze(["singbox", "sing-box"]),
    pathSuffix: "sing-box.json",
    userAgentPriority: 10,
    userAgent: /(?:sing-box|singbox|hiddify)/
  })
]);

const aliases = new Map(subscriptionFormats.flatMap((format) => (
  format.aliases.map((alias) => [alias, format.id])
)));
const pathFormats = new Map(subscriptionFormats.map((format) => (
  [format.pathSuffix, format.id]
)));
const userAgentFormats = [...subscriptionFormats]
  .filter((format) => format.userAgent)
  .sort((left, right) => right.userAgentPriority - left.userAgentPriority);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const subscriptionPathSuffixPattern = subscriptionFormats
  .map((format) => escapeRegex(format.pathSuffix))
  .join("|");

export const subscriptionPortalAliasPattern = subscriptionFormats
  .flatMap((format) => format.portalAliases)
  .map(escapeRegex)
  .join("|");

export function resolveSubscriptionFormat(value) {
  return aliases.get(String(value || "").toLowerCase()) || null;
}

export function subscriptionFormatForPath(pathSuffix) {
  return pathFormats.get(String(pathSuffix || "")) || null;
}

export function subscriptionFormatForUserAgent(userAgent) {
  const normalized = String(userAgent || "").toLowerCase();
  return userAgentFormats.find((format) => format.userAgent.test(normalized))?.id || null;
}

export function buildSubscriptionFormatUrls(subscriptionUrl) {
  return Object.fromEntries(subscriptionFormats.map((format) => {
    if (format.useUniversalUrl) return [format.responseKey, subscriptionUrl];
    const target = new URL(subscriptionUrl);
    target.searchParams.set("format", format.id);
    return [format.responseKey, target.toString()];
  }));
}
