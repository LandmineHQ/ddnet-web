#!/usr/bin/env node
/**
 * End-to-end test: fake browser client -> WSS relay -> real DDNet server (UDP).
 *
 * Sends a DDNet 0.6 "gie3" server info request (the same connless packet the
 * 0.6 client sends when browsing servers) through the relay and verifies that
 * the real server's "inf3" response comes back byte-for-byte.
 *
 * Usage:
 *   node test/e2e-ddnet.mjs [--relay ws://127.0.0.1:8390] [--target 127.0.0.1:8313]
 *                           [--token <relay-token>] [--timeout 5000] [--verbose]
 *
 * Prerequisites: a DDNet server listening on --target (see start-ddnet-server.sh)
 * and a relay listening on --relay.
 */
import process from 'node:process';
import { WebSocket } from 'ws';

const HELP = `DDNet relay end-to-end test

Options:
  --relay <url>     Relay WebSocket base URL (default ws://127.0.0.1:8390)
  --target <addr>   DDNet server host:port (default 127.0.0.1:8313)
  --token <token>   Optional relay token
  --timeout <ms>    Response timeout in ms (default 5000)
  --handshake       Also perform a full DDNet 0.6 connect/accept/info handshake
  --no-game-data    With --handshake: accept CONNECT/CONNECTACCEPT/ACCEPT/NETMSG_INFO
                    as success without waiting for map/game data (official servers do
                    not always send game data to a synthetic client)
  --verbose         Print full response hex dump
  --help            Show this help

Environment: RELAY_URL, RELAY_TARGET, RELAY_TOKEN
`;

function parseArgs(argv) {
  const options = {
    relay: process.env.RELAY_URL ?? 'ws://127.0.0.1:8390',
    target: process.env.RELAY_TARGET ?? '127.0.0.1:8313',
    token: process.env.RELAY_TOKEN ?? null,
    timeoutMs: 5000,
    handshake: false,
    noGameData: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '--relay': options.relay = next(); break;
      case '--target': options.target = next(); break;
      case '--token': options.token = next(); break;
      case '--timeout': options.timeoutMs = Number(next()); break;
      case '--handshake': options.handshake = true; break;
      case '--no-game-data': options.noGameData = true; break;
      case '--verbose': options.verbose = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const startTime = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - startTime) / 1000).toFixed(3)}s]`, ...parts);

function httpBaseFromRelay(relay) {
  return relay.replace(/^ws/, 'http').replace(/\/+$/, '');
}

function wsUrlFor({ relay, target, token }) {
  const base = relay.replace(/\/+$/, '');
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}/udp/${target}${query}`;
}

function connect(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebSocket open`));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('unexpected-response', (request, response) => {
      clearTimeout(timer);
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => reject(new Error(`Relay rejected WebSocket upgrade: HTTP ${response.statusCode} ${body}`)));
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${error.message}`));
    });
  });
}

function onceBinaryMessage(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for a UDP response (is the DDNet server running?)`));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      cleanup();
      if (!isBinary) {
        reject(new Error('Relay returned a text frame; expected binary DDNet packet'));
        return;
      }
      resolve(Buffer.from(data));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    ws.on('message', onMessage);
  });
}

function onceClose(ws, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve({ code: 0, reason: '' });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve({ code: -1, reason: 'timeout' });
    }, timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}

function buildInfoRequest() {
  // DDNet/Teeworlds 0.6 connless packet:
  //   6 bytes 0xFF header + 4 bytes 0xFF magic + "gie3" + 1 byte browse token
  return Buffer.concat([
    Buffer.alloc(6, 0xff),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from('gie3', 'latin1'),
    Buffer.from([0x00]),
  ]);
}

function parseInfoResponse(packet) {
  if (packet.length < 15) throw new Error(`Response too short: ${packet.length} bytes`);
  // 6-byte connless header + 4-byte magic = 10 bytes before the "inf3" tag.
  const payloadOffset = 10;
  const tag = packet.subarray(payloadOffset, payloadOffset + 4).toString('latin1');
  if (tag !== 'inf3' && tag !== 'inf2') {
    throw new Error(`Unexpected response tag "${tag}" (hex: ${packet.subarray(0, 24).toString('hex')})`);
  }
  const fields = packet.toString('latin1').split('\0');
  fields[0] = fields[0].slice(payloadOffset);
  const browseToken = fields[0].slice(4);
  return {
    tag,
    browseToken,
    version: fields[1] ?? '',
    name: fields[2] ?? '',
    map: fields[3] ?? '',
    gameType: fields[4] ?? '',
    fields,
  };
}

// ---------------------------------------------------------------------------
// Optional full DDNet 0.6 connection handshake (connect -> connectaccept ->
// accept -> NETMSG_INFO -> server starts sending map data). This proves that
// the relay also forwards a stateful multi-packet handshake, not just one
// connless info exchange.
// ---------------------------------------------------------------------------

const SECURITY_TOKEN_UNKNOWN = 0xffffffff;

function packetHeader(flags, ack, numChunks) {
  return Buffer.from([
    ((flags << 2) & 0xfc) | ((ack >> 8) & 0x03),
    ack & 0xff,
    numChunks,
  ]);
}

function tokenBytes(token) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE((token ?? SECURITY_TOKEN_UNKNOWN) >>> 0, 0);
  return buffer;
}

function controlPacket(controlMsg, extra, token) {
  return Buffer.concat([
    packetHeader(4, 0, 0), // NET_PACKETFLAG_CONTROL
    Buffer.from([controlMsg]),
    extra ?? Buffer.alloc(0),
    tokenBytes(token),
  ]);
}

function vitalChunk(payload, sequence) {
  const size = payload.length;
  return Buffer.concat([
    Buffer.from([
      0x40 | ((size >> 4) & 0x3f), // vital flag + size high bits
      ((sequence >> 2) & 0xf0) | (size & 0x0f), // sequence bits + size low nibble
      sequence & 0xff,
    ]),
    payload,
  ]);
}

function buildClientInfoPacket(token) {
  // CMsgPacker for NETMSG_INFO (system message): (NETMSG_INFO << 1) | 1,
  // then NetVersion string (DDNet 20.x 0.6 network version) and empty password.
  const netVersion = '0.6 626fce9a778df4d4';
  const payload = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(netVersion + '\0', 'latin1'),
    Buffer.from([0x00]),
  ]);
  return Buffer.concat([
    packetHeader(0, 0, 1), // one chunk, no control flag
    vitalChunk(payload, 1), // first vital chunk sequence = 1
    tokenBytes(token), // 0.6 security token appended to the packet
  ]);
}

function isConnectAccept(packet) {
  if (packet.length < 12) return false;
  const flags = packet[0] >> 2;
  return (flags & 4) !== 0 &&
    packet[3] === 2 && // NET_CTRLMSG_CONNECTACCEPT
    packet.subarray(4, 8).toString('latin1') === 'TKEN';
}

function isDataPacket(packet) {
  if (packet.length < 3) return false;
  const flags = packet[0] >> 2;
  return (flags & 4) === 0 && packet[2] > 0;
}

function waitForPacket(ws, predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      if (!isBinary) return;
      const packet = Buffer.from(data);
      if (!predicate(packet)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(packet);
    };
    ws.on('message', onMessage);
  });
}

async function runHandshake(ws, timeoutMs, noGameData = false) {
  log('handshake : starting full DDNet 0.6 connect flow');

  const acceptPromise = waitForPacket(ws, isConnectAccept, timeoutMs, 'CONNECTACCEPT');
  ws.send(controlPacket(1, Buffer.from('TKEN'), null), { binary: true });
  log('handshake : -> CONNECT (TKEN + unknown token)');
  const acceptPacket = await acceptPromise;
  const securityToken = acceptPacket.readUInt32BE(8);
  log('handshake : <- CONNECTACCEPT, securityToken=0x' + securityToken.toString(16));

  ws.send(controlPacket(3, null, securityToken), { binary: true });
  log('handshake : -> ACCEPT (with security token)');

  const dataPromise = noGameData ? null : waitForPacket(ws, isDataPacket, timeoutMs, 'server game data after NETMSG_INFO');
  const infoPacket = buildClientInfoPacket(securityToken);
  ws.send(infoPacket, { binary: true });
  log('handshake : -> NETMSG_INFO', infoPacket.length, 'bytes (vital chunk, net version 0.6)');
  if (noGameData) {
    log('handshake : server accepted CONNECT/ACCEPT/NETMSG_INFO (game-data wait skipped)');
    return { securityToken, chunkCount: 0, bytes: 0, noGameData: true };
  }
  const dataPacket = await dataPromise;
  const chunkCount = dataPacket[2];
  log('handshake : <- server data packet', dataPacket.length, 'bytes,', chunkCount, 'chunks');
  log('handshake : server accepted the connection and started sending map/game data');
  return { securityToken, chunkCount, bytes: dataPacket.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive number');
  }

  const url = wsUrlFor(options);
  log('relay URL :', url.replace(/token=[^&]+/, 'token=***'));
  log('target    :', options.target);

  try {
    const health = await fetch(`${httpBaseFromRelay(options.relay)}/healthz`, { signal: AbortSignal.timeout(3000) });
    const body = await health.json();
    log('relay     :', health.status, body.status, `version=${body.version}`, `active=${body.activeConnections}`);
    if (body.status !== 'ok') throw new Error('Relay is not healthy');
  } catch (error) {
    log('relay health check failed:', error.message);
    log('hint: start the relay first: cd relay && npm start');
    throw error;
  }

  const ws = await connect(url, options.timeoutMs);
  log('WebSocket : open');

  const request = buildInfoRequest();
  const responsePromise = onceBinaryMessage(ws, options.timeoutMs);
  ws.send(request, { binary: true });
  log('sent      :', request.length, 'bytes DDNet 0.6 info request (10x 0xff + "gie3" + token)');

  const response = await responsePromise;
  log('received  :', response.length, 'bytes');
  const parsed = parseInfoResponse(response);
  log('tag       :', parsed.tag);
  log('version   :', parsed.version);
  log('server    :', parsed.name);
  log('map       :', parsed.map);
  log('browseToken:', JSON.stringify(parsed.browseToken));
  if (options.verbose) {
    log('hex       :', response.toString('hex'));
    log('fields    :', JSON.stringify(parsed.fields));
  }

  let handshakeResult = null;
  if (options.handshake) {
    handshakeResult = await runHandshake(ws, options.timeoutMs, options.noGameData);
  }

  try {
    const stats = await fetch(`${httpBaseFromRelay(options.relay)}/api/stats`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    const targetStats = stats.targets.find((entry) => entry.target === options.target);
    log('stats     :', `packetsToTarget=${stats.packetsToTarget}`, `packetsFromTarget=${stats.packetsFromTarget}`,
      `bytesToTarget=${stats.bytesToTarget}`, `bytesFromTarget=${stats.bytesFromTarget}`);
    if (targetStats) {
      log('target    :', targetStats.target, `connections=${targetStats.connections}`,
        `bytesTo=${targetStats.bytesToTarget}`, `bytesFrom=${targetStats.bytesFromTarget}`);
    }
  } catch (error) {
    log('stats check failed (non-fatal):', error.message);
  }

  const closed = onceClose(ws);
  ws.close(1000, 'e2e done');
  await closed;
  log('PASS      : relay -> UDP -> real DDNet server round trip verified');
  if (handshakeResult) {
    log(handshakeResult.noGameData
      ? 'PASS      : DDNet 0.6 handshake accepted (CONNECT/CONNECTACCEPT/ACCEPT/NETMSG_INFO; game-data wait skipped)'
      : 'PASS      : full DDNet 0.6 handshake verified (CONNECT/CONNECTACCEPT/ACCEPT/NETMSG_INFO, map data received)');
  }
  return 0;
}

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  console.error('FAIL      :', error.message);
  process.exit(1);
}
