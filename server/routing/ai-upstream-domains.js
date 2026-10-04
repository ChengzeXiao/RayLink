import { domainToASCII } from "node:url";
import { AI_DOMAIN_NAMES, AI_DOMAIN_SUFFIXES } from "./policy.js";

// Client routing also covers shared login/challenge dependencies. Residential
// egress is narrower: those shared providers serve ordinary websites as well,
// and an encrypted connection cannot reveal which website initiated it.
const sharedDomains = new Set([
  "challenges.cloudflare.com", "cdn.workos.com", "forwarder.workos.com",
  "setup.workos.com", "images.workoscdn.com", "workos.imgix.net"
]);
export const AI_UPSTREAM_DOMAIN_NAMES = Object.freeze(AI_DOMAIN_NAMES.filter(domain => !sharedDomains.has(domain)));
export const AI_UPSTREAM_DOMAIN_SUFFIXES = Object.freeze(AI_DOMAIN_SUFFIXES.filter(domain => !sharedDomains.has(domain)));

export function isAiUpstreamDomain(value) {
  if (typeof value !== "string") return false;
  const domain = domainToASCII(value.trim().replace(/\.$/, "").toLowerCase());
  if (!domain || domain.length > 253 || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  return AI_UPSTREAM_DOMAIN_NAMES.includes(domain)
    || AI_UPSTREAM_DOMAIN_SUFFIXES.some(suffix => domain === suffix || domain.endsWith(`.${suffix}`));
}
