import fs from 'node:fs';
import path from 'node:path';
import { splitHostPort, formatTarget } from './url.mjs';

export const VERSION = '1.0.0';
/** Wire protocol advertised by GET /api/info. */
export const RELAY_PROTOCOL = 'ws-udp-datagram/1';

export const DEFAULT_CONFIG = Object.freeze({
  name: 'DDNet Relay',
  region: '',
  host: '127.0.0.1',
  port: 8390,
  udpPath: '/udp',
  logLevel: 'info',
  trustProxy: false,
  auth: {
    tokens: [],
    originAllowlist: [],
    allowNoOrigin: true,
    tokenHeader: 'x-relay-token',
  },
  security: {
    allowPrivate: false,
    allowlist: [],
    dnsTimeoutMs: 5000,
  },
  limits: {
    maxConnectionsPerIp: 8,
    maxConnectionsTotal: 1000,
    maxFrameBytes: 2048,
    hardMaxFrameBytes: 65536,
    maxPacketsPerSecond: 300,
    packetBurst: 600,
    maxBytesPerSecond: 256 * 1024,
    byteBurst: 512 * 1024,
    idleTimeoutMs: 60000,
    maxConnectionMs: 0,
    maxBufferedBytes: 512 * 1024,
    pingIntervalMs: 20000,
    maxPendingPackets: 256,
  },
  api: {
    statsEnabled: true,
    serversEnabled: true,
    corsOrigins: ['*'],
  },
  rtc: {
    enabled: true,
    maxPeers: 16,
    maxLifetimeMs: 60000,
    maxOfferBytes: 262144,
    maxOffersPerIpPerMinute: 30,
    offerBurst: 10,
    gatherTimeoutMs: 5000,
    iceServers: [],
  },
  servers: [],
});

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge plain objects; arrays and scalars are replaced. */
export function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = deepMerge(base[key], value);
    else out[key] = value;
  }
  return out;
}

export function parseBool(value, name = 'value') {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`Invalid boolean for ${name}: ${value}`);
}

export function parseNumber(value, name = 'value') {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid number for ${name}: ${value}`);
  return number;
}

export function parseList(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array');
    return parsed.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeServers(input) {
  const list = Array.isArray(input) ? input : input?.servers;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('config.servers must be an array');
  return list.map((entry, index) => {
    if (typeof entry === 'string') {
      const parsed = splitHostPort(entry);
      return { name: entry, host: parsed.host, port: parsed.port, address: formatTarget(parsed) };
    }
    if (!isPlainObject(entry)) throw new Error(`config.servers[${index}] must be an object or string`);
    const raw = entry.address ?? (entry.host ? `${entry.host}:${entry.port ?? 8303}` : undefined);
    if (!raw) throw new Error(`config.servers[${index}] needs host/port or address`);
    const parsed = splitHostPort(raw);
    return {
      ...entry,
      name: entry.name ?? formatTarget(parsed),
      host: parsed.host,
      port: parsed.port,
      address: formatTarget(parsed),
    };
  });
}

function readJsonFile(filePath) {
  const resolved = path.resolve(filePath);
  const text = fs.readFileSync(resolved, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${resolved}: ${error.message}`);
  }
}

export function loadServersFile(filePath) {
  const data = readJsonFile(filePath);
  return normalizeServers(data);
}

/** Translate RELAY_* / ALLOW_PRIVATE environment variables into config overrides. */
export function envOverrides(env = process.env) {
  const overrides = {};
  if (env.RELAY_NAME !== undefined) overrides.name = env.RELAY_NAME;
  if (env.RELAY_REGION !== undefined) overrides.region = env.RELAY_REGION;
  if (env.RELAY_HOST) overrides.host = env.RELAY_HOST;
  if (env.RELAY_PORT) overrides.port = parseNumber(env.RELAY_PORT, 'RELAY_PORT');
  if (env.RELAY_UDP_PATH) overrides.udpPath = env.RELAY_UDP_PATH;
  if (env.RELAY_LOG_LEVEL) overrides.logLevel = env.RELAY_LOG_LEVEL;
  if (env.RELAY_TRUST_PROXY) overrides.trustProxy = parseBool(env.RELAY_TRUST_PROXY, 'RELAY_TRUST_PROXY');

  const tokens = parseList(env.RELAY_TOKENS ?? env.RELAY_TOKEN);
  if (tokens !== undefined) overrides.auth = { ...(overrides.auth ?? {}), tokens };
  const origins = parseList(env.RELAY_ORIGINS ?? env.RELAY_ORIGIN_ALLOWLIST);
  if (origins !== undefined) overrides.auth = { ...(overrides.auth ?? {}), originAllowlist: origins };
  if (env.RELAY_ALLOW_NO_ORIGIN !== undefined) {
    overrides.auth = { ...(overrides.auth ?? {}), allowNoOrigin: parseBool(env.RELAY_ALLOW_NO_ORIGIN, 'RELAY_ALLOW_NO_ORIGIN') };
  }

  if (env.ALLOW_PRIVATE !== undefined) {
    overrides.security = { ...(overrides.security ?? {}), allowPrivate: parseBool(env.ALLOW_PRIVATE, 'ALLOW_PRIVATE') };
  }
  const allowlist = parseList(env.RELAY_ALLOWLIST);
  if (allowlist !== undefined) overrides.security = { ...(overrides.security ?? {}), allowlist };
  if (env.RELAY_DNS_TIMEOUT_MS) {
    overrides.security = { ...(overrides.security ?? {}), dnsTimeoutMs: parseNumber(env.RELAY_DNS_TIMEOUT_MS, 'RELAY_DNS_TIMEOUT_MS') };
  }

  const numberEnv = {
    MAX_CONNS_PER_IP: 'maxConnectionsPerIp',
    MAX_CONNECTIONS_TOTAL: 'maxConnectionsTotal',
    MAX_FRAME_BYTES: 'maxFrameBytes',
    HARD_MAX_FRAME_BYTES: 'hardMaxFrameBytes',
    MAX_PACKETS_PER_SEC: 'maxPacketsPerSecond',
    PACKET_BURST: 'packetBurst',
    MAX_BYTES_PER_SEC: 'maxBytesPerSecond',
    BYTE_BURST: 'byteBurst',
    IDLE_TIMEOUT_MS: 'idleTimeoutMs',
    MAX_CONNECTION_MS: 'maxConnectionMs',
    MAX_BUFFERED_BYTES: 'maxBufferedBytes',
    PING_INTERVAL_MS: 'pingIntervalMs',
  };
  for (const [envName, key] of Object.entries(numberEnv)) {
    if (env[envName] !== undefined) {
      overrides.limits = { ...(overrides.limits ?? {}), [key]: parseNumber(env[envName], envName) };
    }
  }

  const apiCors = parseList(env.RELAY_API_CORS);
  if (apiCors !== undefined) overrides.api = { ...(overrides.api ?? {}), corsOrigins: apiCors };

  const rtc = {};
  if (env.RTC_ENABLED !== undefined) rtc.enabled = parseBool(env.RTC_ENABLED, 'RTC_ENABLED');
  const rtcNumberEnv = {
    RTC_MAX_PEERS: 'maxPeers',
    RTC_MAX_LIFETIME_MS: 'maxLifetimeMs',
    RTC_MAX_OFFER_BYTES: 'maxOfferBytes',
    RTC_MAX_OFFERS_PER_IP_PER_MINUTE: 'maxOffersPerIpPerMinute',
    RTC_OFFER_BURST: 'offerBurst',
    RTC_GATHER_TIMEOUT_MS: 'gatherTimeoutMs',
  };
  for (const [envName, key] of Object.entries(rtcNumberEnv)) {
    if (env[envName] !== undefined) rtc[key] = parseNumber(env[envName], envName);
  }
  if (env.RTC_ICE_SERVERS !== undefined) rtc.iceServers = parseList(env.RTC_ICE_SERVERS);
  if (Object.keys(rtc).length > 0) overrides.rtc = rtc;

  if (env.RELAY_SERVERS_FILE) overrides.servers = loadServersFile(env.RELAY_SERVERS_FILE);
  return overrides;
}

export function validateConfig(config) {
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('config.name must be a non-empty string');
  if (config.name.length > 120) throw new Error('config.name must be at most 120 characters');
  config.name = config.name.trim();
  if (typeof config.region !== 'string') throw new Error('config.region must be a string');
  config.region = config.region.trim();

  const { rtc } = config;
  if (!isPlainObject(rtc)) throw new Error('config.rtc must be an object');
  if (typeof rtc.enabled !== 'boolean') throw new Error('config.rtc.enabled must be boolean');
  for (const key of ['maxPeers', 'maxOfferBytes', 'offerBurst', 'gatherTimeoutMs']) {
    if (!Number.isInteger(rtc[key]) || rtc[key] <= 0) throw new Error(`config.rtc.${key} must be a positive integer`);
  }
  for (const key of ['maxLifetimeMs', 'maxOffersPerIpPerMinute']) {
    if (typeof rtc[key] !== 'number' || !Number.isFinite(rtc[key]) || rtc[key] <= 0) {
      throw new Error(`config.rtc.${key} must be a positive number`);
    }
  }
  if (rtc.maxOfferBytes > 8 * 1024 * 1024) throw new Error('config.rtc.maxOfferBytes must be <= 8 MiB');
  if (!Array.isArray(rtc.iceServers)) throw new Error('config.rtc.iceServers must be an array');
  rtc.iceServers = rtc.iceServers.map((entry) => String(entry).trim()).filter(Boolean);
  for (const entry of rtc.iceServers) {
    if (!/^(stun|turn|turns):\S+$/i.test(entry)) throw new Error(`Invalid config.rtc.iceServers entry: ${entry}`);
  }

  if (typeof config.host !== 'string' || !config.host) throw new Error('config.host must be a non-empty string');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('config.port must be an integer between 0 and 65535');
  }
  if (typeof config.udpPath !== 'string' || !config.udpPath.startsWith('/')) {
    throw new Error('config.udpPath must start with /');
  }
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(config.logLevel)) {
    throw new Error('config.logLevel must be one of debug, info, warn, error, silent');
  }
  if (typeof config.auth.tokens === 'string') config.auth.tokens = parseList(config.auth.tokens);
  if (!Array.isArray(config.auth.tokens)) throw new Error('config.auth.tokens must be an array of strings');
  config.auth.tokens = config.auth.tokens.map((token) => String(token)).filter(Boolean);
  if (typeof config.auth.originAllowlist === 'string') config.auth.originAllowlist = parseList(config.auth.originAllowlist);
  if (!Array.isArray(config.auth.originAllowlist)) throw new Error('config.auth.originAllowlist must be an array');
  config.auth.originAllowlist = config.auth.originAllowlist.map((entry) => String(entry).trim()).filter(Boolean);
  if (config.auth.tokenHeader !== undefined && typeof config.auth.tokenHeader !== 'string') {
    throw new Error('config.auth.tokenHeader must be a string');
  }
  if (typeof config.security.allowPrivate !== 'boolean') throw new Error('config.security.allowPrivate must be boolean');
  if (typeof config.security.allowlist === 'string') config.security.allowlist = parseList(config.security.allowlist);
  if (!Array.isArray(config.security.allowlist)) throw new Error('config.security.allowlist must be an array');
  if (!(config.security.dnsTimeoutMs >= 1)) throw new Error('config.security.dnsTimeoutMs must be >= 1');

  const numericLimits = [
    'maxConnectionsPerIp', 'maxConnectionsTotal', 'maxFrameBytes', 'hardMaxFrameBytes',
    'maxPacketsPerSecond', 'packetBurst', 'maxBytesPerSecond', 'byteBurst',
  ];
  for (const key of numericLimits) {
    const value = config.limits[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`config.limits.${key} must be a positive number`);
    }
    if (key !== 'maxBytesPerSecond' && key !== 'byteBurst' && !Number.isInteger(value)) {
      throw new Error(`config.limits.${key} must be an integer`);
    }
  }
  for (const key of ['idleTimeoutMs', 'maxConnectionMs', 'maxBufferedBytes', 'pingIntervalMs', 'maxPendingPackets']) {
    const value = config.limits[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`config.limits.${key} must be a non-negative number`);
    }
  }
  if (config.limits.maxFrameBytes > config.limits.hardMaxFrameBytes) {
    throw new Error('config.limits.maxFrameBytes must be <= config.limits.hardMaxFrameBytes');
  }
  if (config.limits.maxConnectionsPerIp > config.limits.maxConnectionsTotal) {
    throw new Error('config.limits.maxConnectionsPerIp must be <= config.limits.maxConnectionsTotal');
  }
  if (typeof config.trustProxy !== 'boolean') throw new Error('config.trustProxy must be boolean');
  if (!Array.isArray(config.api.corsOrigins)) throw new Error('config.api.corsOrigins must be an array');
  config.servers = normalizeServers(config.servers);
  return config;
}

/**
 * Build the runtime config: defaults <- JSON file <- environment <- explicit overrides.
 * @param {{configPath?: string, env?: NodeJS.ProcessEnv, overrides?: object}} options
 */
export function loadConfig({ configPath, env = process.env, overrides = {} } = {}) {
  let config = structuredClone(DEFAULT_CONFIG);
  const file = configPath ?? env.RELAY_CONFIG;
  if (file) {
    const data = readJsonFile(file);
    if (!isPlainObject(data)) throw new Error(`Config file ${file} must contain a JSON object`);
    if (data.servers !== undefined) data.servers = normalizeServers(data.servers);
    config = deepMerge(config, data);
  }
  config = deepMerge(config, envOverrides(env));
  config = deepMerge(config, overrides);
  return validateConfig(config);
}

/**
 * Full effective config for troubleshooting (CLI --print-config / GET /api/stats).
 * Token *values* are never included.
 */
export function printableConfig(config) {
  return {
    name: config.name,
    region: config.region,
    host: config.host,
    port: config.port,
    udpPath: config.udpPath,
    logLevel: config.logLevel,
    trustProxy: config.trustProxy,
    auth: {
      tokensConfigured: config.auth.tokens.length,
      originAllowlist: [...config.auth.originAllowlist],
      allowNoOrigin: config.auth.allowNoOrigin,
      tokenHeader: config.auth.tokenHeader,
    },
    security: {
      allowPrivate: config.security.allowPrivate,
      allowlist: [...config.security.allowlist],
      dnsTimeoutMs: config.security.dnsTimeoutMs,
    },
    limits: { ...config.limits },
    api: { ...config.api, corsOrigins: [...config.api.corsOrigins] },
    rtc: { ...config.rtc, iceServers: [...config.rtc.iceServers] },
    servers: config.servers.map((entry) => ({
      name: entry.name,
      address: entry.address,
      ...(entry.note ? { note: entry.note } : {}),
    })),
  };
}

/** Compact log-safe view of the config (no secrets). */
export function describeConfig(config) {
  return {
    name: config.name,
    region: config.region,
    host: config.host,
    port: config.port,
    udpPath: config.udpPath,
    logLevel: config.logLevel,
    trustProxy: config.trustProxy,
    rtc: {
      enabled: config.rtc.enabled,
      maxPeers: config.rtc.maxPeers,
      maxLifetimeMs: config.rtc.maxLifetimeMs,
    },
    auth: {
      tokensConfigured: config.auth.tokens.length,
      originsConfigured: config.auth.originAllowlist.length,
      allowNoOrigin: config.auth.allowNoOrigin,
    },
    security: {
      allowPrivate: config.security.allowPrivate,
      allowlistEntries: config.security.allowlist.length,
      dnsTimeoutMs: config.security.dnsTimeoutMs,
    },
    limits: { ...config.limits },
    api: { ...config.api, corsOrigins: config.api.corsOrigins },
    serversConfigured: config.servers.length,
  };
}
