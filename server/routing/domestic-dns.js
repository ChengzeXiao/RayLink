import { getBundledRoutingRules } from "./rule-sets/bundled.js";

const IPV4_SIZE = 2 ** 32;
let fallbackCidrs;

function ipv4Range(cidr) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!match) throw new Error(`Invalid bundled China IPv4 network: ${cidr}`);
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) throw new Error(`Invalid bundled China IPv4 network: ${cidr}`);
  const start = octets.reduce((address, octet) => address * 256 + octet, 0);
  const size = 2 ** (32 - prefix);
  if (start % size !== 0) throw new Error(`Unaligned bundled China IPv4 network: ${cidr}`);
  return [start, start + size - 1];
}

function appendRange(cidrs, start, end) {
  while (start <= end) {
    // All calculations remain exact within JavaScript's integer range. Only
    // the trailing-zero calculation uses unsigned 32-bit arithmetic.
    const alignedBits = start === 0 ? 32 : 31 - Math.clz32((start & -start) >>> 0);
    const hostBits = Math.min(alignedBits, Math.floor(Math.log2(end - start + 1)));
    const address = [24, 16, 8, 0].map((bits) => Math.floor(start / 2 ** bits) % 256).join(".");
    cidrs.push(`${address}/${32 - hostBits}`);
    start += 2 ** hostBits;
  }
}

// Mihomo fallback-filter.ipcidr rejects matching DNS answers. Its exact CN
// complement accepts only the same geographical IPv4 addresses used by our
// DIRECT rule set, without relying on a client's unrelated GeoIP database.
export function getDomesticDnsFallbackCidrs() {
  if (fallbackCidrs) return fallbackCidrs;
  const networks = getBundledRoutingRules().geoip.flatMap((rule) => rule.ip_cidr || [])
    .filter((cidr) => !cidr.includes(":"))
    .map(ipv4Range)
    .sort(([left], [right]) => left - right);
  if (!networks.length) throw new Error("Bundled China IPv4 networks are required for domestic DNS filtering");
  const complement = [];
  let cursor = 0;
  for (const [start, end] of networks) {
    if (start > cursor) appendRange(complement, cursor, start - 1);
    // Advancing monotonically merges overlapping and adjacent CN ranges.
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor < IPV4_SIZE) appendRange(complement, cursor, IPV4_SIZE - 1);
  // Generated clients currently disable IPv6. Reject unexpected IPv6 answers
  // as well, rather than let them bypass an IPv4-only geographic check.
  complement.push("::/0");
  fallbackCidrs = Object.freeze(complement);
  return fallbackCidrs;
}
