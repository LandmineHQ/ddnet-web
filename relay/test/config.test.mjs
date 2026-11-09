import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, deepMerge, parseList, parseBool, describeConfig, printableConfig, DEFAULT_CONFIG } from '../src/config.mjs';

test('defaults are safe: private targets blocked, frame limit 2048, idle 60s', () => {
  const config = loadConfig({ env: {} });
  assert.equal(config.security.allowPrivate, false);
  assert.equal(config.limits.maxFrameBytes, 2048);
  assert.equal(config.limits.idleTimeoutMs, 60000);
  assert.equal(config.port, 8390);
  assert.equal(config.auth.tokens.length, 0);
  assert.equal(config.name, 'DDNet Relay');
  assert.equal(config.region, '');
  assert.equal(config.rtc.enabled, true);
  assert.equal(config.rtc.maxPeers, 16);
  assert.equal(config.rtc.maxLifetimeMs, 60000);
  assert.equal(config.rtc.maxOfferBytes, 262144);
  assert.equal(config.rtc.maxOffersPerIpPerMinute, 30);
  assert.equal(config.rtc.offerBurst, 10);
});

test('environment overrides tokens, allowPrivate, limits and origins', () => {
  const config = loadConfig({
    env: {
      RELAY_TOKENS: 'alpha,beta',
      RELAY_ORIGINS: 'https://relay.example.com,http://localhost:5173',
      ALLOW_PRIVATE: 'true',
      RELAY_ALLOWLIST: '192.168.0.0/16,internal.lan',
      MAX_FRAME_BYTES: '4096',
      MAX_CONNS_PER_IP: '3',
      IDLE_TIMEOUT_MS: '5000',
      RELAY_PORT: '8391',
    },
  });
  assert.deepEqual(config.auth.tokens, ['alpha', 'beta']);
  assert.deepEqual(config.auth.originAllowlist, ['https://relay.example.com', 'http://localhost:5173']);
  assert.equal(config.security.allowPrivate, true);
  assert.deepEqual(config.security.allowlist, ['192.168.0.0/16', 'internal.lan']);
  assert.equal(config.limits.maxFrameBytes, 4096);
  assert.equal(config.limits.maxConnectionsPerIp, 3);
  assert.equal(config.limits.idleTimeoutMs, 5000);
  assert.equal(config.port, 8391);
});

test('invalid env booleans/numbers fail fast', () => {
  assert.throws(() => loadConfig({ env: { ALLOW_PRIVATE: 'maybe' } }), /Invalid boolean/);
  assert.throws(() => loadConfig({ env: { MAX_CONNS_PER_IP: 'NaN' } }), /Invalid number/);
  assert.throws(() => loadConfig({ env: { RELAY_PORT: '70000' } }), /port must be an integer/);
});

test('config file is merged with defaults and overridden by env', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-'));
  const file = path.join(dir, 'relay.json');
  fs.writeFileSync(file, JSON.stringify({
    port: 9000,
    auth: { tokens: ['file-token'] },
    limits: { maxFrameBytes: 3000 },
    servers: [{ name: 'Local', host: '127.0.0.1', port: 8313 }],
  }));
  try {
    const config = loadConfig({ configPath: file, env: { RELAY_PORT: '9001' } });
    assert.equal(config.port, 9001);
    assert.deepEqual(config.auth.tokens, ['file-token']);
    assert.equal(config.limits.maxFrameBytes, 3000);
    assert.equal(config.limits.maxBytesPerSecond, DEFAULT_CONFIG.limits.maxBytesPerSecond);
    assert.equal(config.servers.length, 1);
    assert.equal(config.servers[0].address, '127.0.0.1:8313');
    const safe = describeConfig(config);
    assert.equal(safe.auth.tokensConfigured, 1);
    assert.equal(JSON.stringify(safe).includes('file-token'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('frame limit larger than hard limit is rejected', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { limits: { maxFrameBytes: 70000 } } }),
    /maxFrameBytes must be <=/,
  );
});

test('parseList supports comma separated and JSON array forms', () => {
  assert.deepEqual(parseList('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseList('["x","y"]'), ['x', 'y']);
  assert.deepEqual(parseList(''), []);
});

test('parseBool accepts common truthy/falsy values', () => {
  assert.equal(parseBool('yes'), true);
  assert.equal(parseBool('0'), false);
  assert.throws(() => parseBool('perhaps'), /Invalid boolean/);
});

test('printableConfig exposes effective key settings but never token values', () => {
  const config = loadConfig({
    env: {
      RELAY_TOKENS: 'top-secret-token',
      RELAY_ORIGINS: 'https://relay.example.com',
      ALLOW_PRIVATE: 'true',
      RELAY_ALLOWLIST: '127.0.0.1/32',
      MAX_PACKETS_PER_SEC: '120',
      PACKET_BURST: '240',
    },
  });
  const printable = printableConfig(config);
  const text = JSON.stringify(printable);
  assert.equal(printable.auth.tokensConfigured, 1);
  assert.equal(text.includes('top-secret-token'), false);
  assert.equal(printable.security.allowPrivate, true);
  assert.deepEqual(printable.security.allowlist, ['127.0.0.1/32']);
  assert.deepEqual(printable.auth.originAllowlist, ['https://relay.example.com']);
  assert.equal(printable.limits.maxPacketsPerSecond, 120);
  assert.equal(printable.limits.packetBurst, 240);
  assert.equal(printable.udpPath, '/udp');
});

test('name, region and WebRTC config are configurable via env', () => {
  const config = loadConfig({
    env: {
      RELAY_NAME: 'Edge Relay',
      RELAY_REGION: 'eu-west',
      RTC_ENABLED: 'false',
      RTC_MAX_PEERS: '4',
      RTC_MAX_LIFETIME_MS: '1500',
      RTC_MAX_OFFER_BYTES: '1024',
      RTC_MAX_OFFERS_PER_IP_PER_MINUTE: '6',
      RTC_OFFER_BURST: '2',
      RTC_GATHER_TIMEOUT_MS: '2000',
      RTC_ICE_SERVERS: 'stun:stun.example.org:3478',
    },
  });
  assert.equal(config.name, 'Edge Relay');
  assert.equal(config.region, 'eu-west');
  assert.equal(config.rtc.enabled, false);
  assert.equal(config.rtc.maxPeers, 4);
  assert.equal(config.rtc.maxLifetimeMs, 1500);
  assert.equal(config.rtc.maxOfferBytes, 1024);
  assert.equal(config.rtc.maxOffersPerIpPerMinute, 6);
  assert.equal(config.rtc.offerBurst, 2);
  assert.equal(config.rtc.gatherTimeoutMs, 2000);
  assert.deepEqual(config.rtc.iceServers, ['stun:stun.example.org:3478']);

  const printable = printableConfig(config);
  assert.equal(printable.name, 'Edge Relay');
  assert.equal(printable.region, 'eu-west');
  assert.equal(printable.rtc.enabled, false);
  assert.equal(printable.rtc.maxPeers, 4);
  assert.deepEqual(printable.rtc.iceServers, ['stun:stun.example.org:3478']);
});

test('invalid WebRTC/name config fails fast', () => {
  assert.throws(() => loadConfig({ env: { RTC_MAX_PEERS: '0' } }), /rtc.maxPeers/);
  assert.throws(() => loadConfig({ env: { RTC_MAX_LIFETIME_MS: '-1' } }), /rtc.maxLifetimeMs/);
  assert.throws(() => loadConfig({ env: { RTC_ENABLED: 'nope' } }), /Invalid boolean/);
  assert.throws(() => loadConfig({ env: { RTC_ICE_SERVERS: 'http://not-a-stun-server' } }), /Invalid config.rtc.iceServers/);
  assert.throws(() => loadConfig({ env: {}, overrides: { name: '   ' } }), /config.name/);
});

test('deepMerge merges nested objects and replaces arrays', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});
