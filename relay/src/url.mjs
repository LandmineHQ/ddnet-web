import net from 'node:net';
import { RelayError, ErrorCodes } from './errors.mjs';

export const DEFAULT_TARGET_PORT = 8303;

/** Hostnames: letters, digits, hyphen, dot, underscore (some game hosts use _). No spaces/@/slashes. */
const HOST_RE = /^[a-z0-9._-]+$/i;

export function parsePort(value) {
  const str = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(str)) {
    throw new RelayError(ErrorCodes.BAD_PORT, `Invalid target port: ${str || '(empty)'}`, 400);
  }
  const port = Number(str);
  if (port < 1 || port > 65535) {
    throw new RelayError(ErrorCodes.BAD_PORT, `Target port out of range: ${port}`, 400);
  }
  return port;
}

export function validateHost(host) {
  const value = String(host ?? '').trim();
  if (!value) throw new RelayError(ErrorCodes.BAD_TARGET, 'Target host is empty', 400);
  if (value.length > 253) throw new RelayError(ErrorCodes.BAD_TARGET, 'Target host is too long', 400);
  if (value.startsWith('[') || value.endsWith(']')) {
    throw new RelayError(ErrorCodes.BAD_TARGET, 'Target host must not contain brackets', 400);
  }
  const ipFamily = net.isIP(value);
  if (ipFamily !== 0) return value.toLowerCase();
  if (!HOST_RE.test(value) || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw new RelayError(ErrorCodes.BAD_TARGET, `Invalid target host: ${value}`, 400);
  }
  return value.toLowerCase();
}

/**
 * Parse "host:port", "[v6]:port", "host" (default port), "v6" (no brackets, default port).
 */
export function splitHostPort(input, defaultPort = DEFAULT_TARGET_PORT) {
  if (typeof input !== 'string') {
    throw new RelayError(ErrorCodes.BAD_TARGET, 'Target must be a string', 400);
  }
  const raw = input.trim();
  if (!raw) throw new RelayError(ErrorCodes.BAD_TARGET, 'Target is empty', 400);

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) throw new RelayError(ErrorCodes.BAD_TARGET, 'Unterminated IPv6 bracket in target', 400);
    const host = validateHost(raw.slice(1, end));
    if (net.isIP(host) !== 6) throw new RelayError(ErrorCodes.BAD_TARGET, 'Bracketed target is not an IPv6 address', 400);
    const rest = raw.slice(end + 1);
    if (rest === '') return { host, port: defaultPort, raw };
    if (!rest.startsWith(':')) throw new RelayError(ErrorCodes.BAD_TARGET, 'Invalid target after IPv6 address', 400);
    return { host, port: parsePort(rest.slice(1)), raw };
  }

  const colons = raw.split(':').length - 1;
  if (colons === 0) return { host: validateHost(raw), port: defaultPort, raw };
  if (colons > 1) {
    // Bare IPv6 address without a port (brackets required when a port is appended).
    if (net.isIP(raw) === 6) return { host: raw.toLowerCase(), port: defaultPort, raw };
    throw new RelayError(ErrorCodes.BAD_TARGET, 'IPv6 targets must be written as [address]:port', 400);
  }
  const index = raw.lastIndexOf(':');
  const host = validateHost(raw.slice(0, index));
  const port = parsePort(raw.slice(index + 1));
  return { host, port, raw };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function extractToken({ url, headers, tokenHeader = 'x-relay-token' } = {}) {
  let queryToken = null;
  try {
    queryToken = url?.searchParams?.get('token') ?? null;
  } catch {
    queryToken = null;
  }
  if (queryToken) return queryToken;

  const authorization = headerValue(headers, 'authorization');
  if (typeof authorization === 'string' && /^bearer\s+/i.test(authorization)) {
    const value = authorization.replace(/^bearer\s+/i, '').trim();
    if (value) return value;
  }
  const relayToken = headerValue(headers, tokenHeader) ?? headerValue(headers, 'x-relay-token');
  if (typeof relayToken === 'string' && relayToken.trim()) return relayToken.trim();
  return null;
}

export function extractOrigin(headers) {
  const origin = headerValue(headers, 'origin');
  return typeof origin === 'string' && origin.trim() ? origin.trim() : null;
}

/**
 * Parse a relay request URL into { target, token, url, pathname }.
 * Supported:
 *   /udp/<host>:<port>[?token=...]
 *   /udp?target=<host>:<port>[&token=...]
 *   /udp/[?target=...]  (with ?target also allowed alongside a path target, must match)
 */
export function parseRelayRequest({ url, headers, udpPath = '/udp', tokenHeader = 'x-relay-token' } = {}) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url), 'http://relay.invalid');
  } catch {
    throw new RelayError(ErrorCodes.BAD_TARGET, 'Malformed request URL', 400);
  }

  const base = udpPath.endsWith('/') ? udpPath.slice(0, -1) : udpPath;
  const pathname = parsed.pathname;
  if (pathname !== base && !pathname.startsWith(base + '/')) {
    throw new RelayError(ErrorCodes.BAD_PATH, `Unknown endpoint: ${pathname}`, 404);
  }

  let pathTarget = null;
  if (pathname !== base) {
    let segment;
    try {
      segment = decodeURIComponent(pathname.slice(base.length + 1));
    } catch {
      throw new RelayError(ErrorCodes.BAD_TARGET, 'Target contains invalid percent-encoding', 400);
    }
    if (segment.includes('/')) {
      throw new RelayError(ErrorCodes.BAD_TARGET, 'Target must be a single host:port segment', 400);
    }
    if (segment) pathTarget = segment;
  }

  const queryTarget = parsed.searchParams.get('target');
  let effectiveTarget = pathTarget;
  if (queryTarget !== null && queryTarget !== '') {
    if (pathTarget !== null && queryTarget !== pathTarget) {
      throw new RelayError(ErrorCodes.TARGET_CONFLICT, 'Path target and ?target disagree', 400);
    }
    effectiveTarget = queryTarget;
  } else if (queryTarget === '' && pathTarget === null) {
    throw new RelayError(ErrorCodes.BAD_TARGET, 'Empty ?target parameter', 400);
  }

  if (!effectiveTarget) {
    throw new RelayError(ErrorCodes.BAD_TARGET, 'Missing target; use /udp/host:port or ?target=host:port', 400);
  }

  const target = splitHostPort(effectiveTarget);
  const token = extractToken({ url: parsed, headers, tokenHeader });
  return { target, token, url: parsed, pathname, origin: extractOrigin(headers) };
}

export function formatTarget(target) {
  return net.isIP(target.host) === 6 ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
}
