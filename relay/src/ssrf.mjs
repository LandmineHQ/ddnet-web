import net from 'node:net';
import dns from 'node:dns/promises';
import { RelayError, ErrorCodes } from './errors.mjs';

/**
 * SSRF protection.
 *
 * Design notes:
 *  - Every target host is either a literal IP or resolved through DNS once.
 *  - *All* DNS answers are validated; if any answer is private/reserved the
 *    target is rejected (prevents "public A record + private A record" DNS
 *    rebinding tricks).
 *  - The validated IP is pinned and passed to dgram.connect()/send(); the
 *    hostname is never resolved a second time, so a rebinding DNS server cannot
 *    redirect the packet after the check.
 *  - Operators can allow private targets explicitly (ALLOW_PRIVATE=true) or
 *    allowlist specific hostnames / IPs / CIDRs (LAN / self-hosted servers).
 */

function cidrList(ranges, type) {
  const list = new net.BlockList();
  for (const cidr of ranges) {
    const [address, prefix] = cidr.split('/');
    list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

const IPv4_CATEGORIES = [
  ['unspecified', cidrList(['0.0.0.0/8'], 'ipv4')],
  ['loopback', cidrList(['127.0.0.0/8'], 'ipv4')],
  ['private', cidrList(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], 'ipv4')],
  ['link_local', cidrList(['169.254.0.0/16'], 'ipv4')],
  ['cgnat', cidrList(['100.64.0.0/10'], 'ipv4')],
  ['broadcast', cidrList(['255.255.255.255/32'], 'ipv4')],
  ['multicast', cidrList(['224.0.0.0/4'], 'ipv4')],
  ['reserved', cidrList([
    '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '198.18.0.0/15',
    '198.51.100.0/24', '203.0.113.0/24', '240.0.0.0/4',
  ], 'ipv4')],
];

const IPv6_CATEGORIES = [
  ['unspecified', cidrList(['::/128'], 'ipv6')],
  ['loopback', cidrList(['::1/128'], 'ipv6')],
  ['ipv4_mapped', cidrList(['::ffff:0:0/96'], 'ipv6')],
  ['private', cidrList(['fc00::/7'], 'ipv6')],
  ['link_local', cidrList(['fe80::/10'], 'ipv6')],
  ['multicast', cidrList(['ff00::/8'], 'ipv6')],
  ['reserved', cidrList(['100::/64', '2001:db8::/32', '64:ff9b:1::/48', '3fff::/20'], 'ipv6')],
];

/**
 * Normalize an IP address string:
 *  - strips an IPv6 zone index (%eth0)
 *  - converts dotted IPv4-mapped IPv6 (::ffff:127.0.0.1) to plain IPv4
 * @returns {{address: string, family: 4|6, mapped: boolean}|null}
 */
export function normalizeAddress(ip) {
  if (typeof ip !== 'string') return null;
  let value = ip.trim().toLowerCase();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped && net.isIP(mapped[1]) === 4) return { address: mapped[1], family: 4, mapped: true };
  const family = net.isIP(value);
  if (family === 0) return null;
  return { address: value, family, mapped: false };
}

/**
 * @returns {{valid: boolean, normalized: string|null, family: 0|4|6, mapped: boolean,
 *            forbidden: boolean, category: string}}
 */
export function classifyAddress(ip) {
  const normalized = normalizeAddress(ip);
  if (!normalized) {
    return { valid: false, normalized: null, family: 0, mapped: false, forbidden: true, category: 'invalid' };
  }
  const { address, family } = normalized;
  const categories = family === 4 ? IPv4_CATEGORIES : IPv6_CATEGORIES;
  const hit = categories.find(([, list]) => list.check(address, family === 4 ? 'ipv4' : 'ipv6'));
  return {
    valid: true,
    normalized: address,
    family,
    mapped: normalized.mapped,
    forbidden: Boolean(hit),
    category: hit ? hit[0] : 'public',
  };
}

/**
 * Compile the operator allowlist.
 * Entries may be:
 *   - hostnames (case-insensitive exact match, bypasses IP classification)
 *   - literal IPs
 *   - CIDR ranges ("10.0.0.0/8", "fd00::/8")
 */
export function createAddressPolicy({ allowPrivate = false, allowlist = [] } = {}) {
  const hosts = new Set();
  const ipRules = new net.BlockList();
  let hasIpRules = false;

  for (const raw of Array.isArray(allowlist) ? allowlist : []) {
    const entry = String(raw ?? '').trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('/')) {
      const [address, prefixText] = entry.split('/');
      const normalized = normalizeAddress(address);
      const prefix = Number(prefixText);
      if (!normalized || !Number.isInteger(prefix) || prefix < 0 || prefix > (normalized.family === 4 ? 32 : 128)) {
        throw new Error(`Invalid allowlist CIDR entry: ${entry}`);
      }
      ipRules.addSubnet(normalized.address, prefix, normalized.family === 4 ? 'ipv4' : 'ipv6');
      hasIpRules = true;
    } else if (net.isIP(entry) !== 0) {
      const normalized = normalizeAddress(entry);
      ipRules.addAddress(normalized.address, normalized.family === 4 ? 'ipv4' : 'ipv6');
      hasIpRules = true;
    } else {
      hosts.add(entry);
    }
  }

  return {
    allowPrivate,
    hosts,
    ipRules,
    hasIpRules,
    hostAllowed(host) {
      return hosts.has(String(host ?? '').trim().toLowerCase());
    },
    ipAllowed(ip) {
      const normalized = normalizeAddress(ip);
      if (!normalized) return false;
      return hasIpRules && ipRules.check(normalized.address, normalized.family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

/** Validate one resolved address against the policy, throwing a RelayError when blocked. */
export function evaluateAddress(ip, host, policy) {
  const classification = classifyAddress(ip);
  if (!classification.valid) {
    throw new RelayError(ErrorCodes.TARGET_NOT_ALLOWED, `Invalid target address: ${ip}`, 403);
  }
  const bypass = policy.allowPrivate || policy.hostAllowed(host) || policy.ipAllowed(classification.normalized);
  if (classification.forbidden && !bypass) {
    throw new RelayError(
      ErrorCodes.TARGET_NOT_ALLOWED,
      `Target ${host} resolves to a blocked ${classification.category} address (${classification.normalized}); set ALLOW_PRIVATE=true or add an allowlist entry to permit it`,
      403,
      { category: classification.category, address: classification.normalized },
    );
  }
  return classification;
}

export async function defaultLookup(host) {
  return dns.lookup(host, { all: true, verbatim: true });
}

function withTimeout(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('DNS lookup timed out');
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve + validate a target host. Returns the pinned address that must be
 * handed to dgram; the hostname is not resolved again afterwards.
 */
export async function resolveTarget(host, { policy, lookup = defaultLookup, timeoutMs = 5000 } = {}) {
  if (!policy) policy = createAddressPolicy();
  const literal = net.isIP(host);
  if (literal !== 0) {
    const classification = evaluateAddress(host, host, policy);
    return { host, address: classification.normalized, family: classification.family, addresses: [classification.normalized] };
  }

  let answers;
  try {
    answers = await withTimeout(Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })), timeoutMs);
  } catch (error) {
    throw new RelayError(
      ErrorCodes.DNS_FAILED,
      `DNS lookup failed for ${host}: ${error?.code || error?.message || 'unknown error'}`,
      502,
      { reason: error?.code || 'lookup_failed' },
    );
  }

  const list = Array.isArray(answers) ? answers : answers ? [answers] : [];
  if (list.length === 0) {
    throw new RelayError(ErrorCodes.DNS_FAILED, `DNS lookup returned no addresses for ${host}`, 502);
  }

  const examined = [];
  for (const answer of list) {
    const ip = typeof answer === 'string' ? answer : answer?.address;
    const classification = evaluateAddress(ip, host, policy);
    examined.push({ address: classification.normalized, family: classification.family });
  }
  const pinned = examined.find((entry) => entry.family === 4) ?? examined[0];
  return { host, address: pinned.address, family: pinned.family, addresses: examined.map((entry) => entry.address) };
}

export const FORBIDDEN_CATEGORIES = Object.freeze([
  'unspecified', 'loopback', 'private', 'link_local', 'cgnat', 'broadcast', 'multicast', 'reserved', 'ipv4_mapped',
]);
