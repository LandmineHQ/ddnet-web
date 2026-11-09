import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelayServer, getClientIp } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';

function silentLogger() {
  return createLogger({ level: 'silent', stream: { write() {} } });
}

async function startEchoServer() {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, rinfo) => {
    socket.send(message, rinfo.port, rinfo.address);
  });
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  return {
    socket,
    port: socket.address().port,
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}

function makeConfig(overrides = {}) {
  return loadConfig({
    env: {},
    overrides: {
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      security: { allowPrivate: true },
      ...overrides,
    },
  });
}

async function startRelay(overrides = {}, options = {}) {
  const config = makeConfig(overrides);
  const relay = createRelayServer(config, { logger: silentLogger(), ...options });
  await relay.listen(0, '127.0.0.1');
  return relay;
}

function relayBaseUrl(relay) {
  const address = relay.address;
  return `http://127.0.0.1:${address.port}`;
}

function connect(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (request, response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        const error = new Error(`Unexpected HTTP ${response.statusCode}`);
        error.statusCode = response.statusCode;
        error.body = body;
        reject(error);
      });
    });
    ws.once('error', (error) => reject(error));
  });
}

function nextBinary(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for a binary message'));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      cleanup();
      resolve({ data: Buffer.from(data), isBinary });
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    ws.on('message', onMessage);
  });
}

function nextClose(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.CLOSED) {
      resolve({ code: ws.readyState, reason: '' });
      return;
    }
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}

function sendBinary(ws, buffer) {
  return new Promise((resolve, reject) => {
    ws.send(buffer, { binary: true }, (error) => (error ? reject(error) : resolve()));
  });
}

async function assertEcho(ws, payload) {
  const expected = Buffer.from(payload);
  const received = nextBinary(ws);
  await sendBinary(ws, expected);
  const message = await received;
  assert.equal(message.isBinary, true);
  assert.equal(message.data.length, expected.length);
  assert.deepEqual(message.data, expected);
}

test('UDP echo round trips are byte-identical (1, 14 and 1400 byte frames)', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay({
    auth: { tokens: ['secret'] },
    servers: [{ name: 'Echo', host: '127.0.0.1', port: echo.port }],
  });
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}?token=secret`);
    try {
      await assertEcho(ws, Buffer.from([0x01]));
      await assertEcho(ws, Buffer.from('\xff\xff\xff\xffgie3\x00', 'latin1'));
      await assertEcho(ws, Buffer.alloc(1400, 0xab));
    } finally {
      ws.close();
    }
  } finally {
    await relay.close();
    await echo.close();
  }
});

test('HTTP endpoints expose health, stats and recommended servers', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay({
    auth: { tokens: ['stats-secret'] },
    servers: [{ name: 'Local echo', host: '127.0.0.1', port: echo.port, note: 'test' }],
  });
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}?token=stats-secret`);
    try {
      const health = await fetch(`${relayBaseUrl(relay)}/healthz`);
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('access-control-allow-origin'), '*');
      const healthBody = await health.json();
      assert.equal(healthBody.status, 'ok');
      assert.equal(healthBody.activeConnections, 1);

      const stats = await fetch(`${relayBaseUrl(relay)}/api/stats`);
      assert.equal(stats.status, 200);
      const statsBody = await stats.json();
      assert.equal(statsBody.activeConnections, 1);
      assert.equal(statsBody.totalConnections, 1);
      assert.ok(statsBody.targets.some((entry) => entry.target === `127.0.0.1:${echo.port}`));
      assert.equal(statsBody.limits.maxFrameBytes, 2048);
      // Effective config is exposed for debugging, but never token values.
      assert.equal(statsBody.config.auth.tokensConfigured, 1);
      assert.equal(statsBody.config.limits.maxFrameBytes, 2048);
      assert.equal(statsBody.config.udpPath, '/udp');
      assert.equal(JSON.stringify(statsBody).includes('stats-secret'), false);

      const servers = await fetch(`${relayBaseUrl(relay)}/api/servers`);
      assert.equal(servers.status, 200);
      const serversBody = await servers.json();
      assert.equal(serversBody.count, 1);
      assert.equal(serversBody.servers[0].name, 'Local echo');
      assert.equal(serversBody.servers[0].address, `127.0.0.1:${echo.port}`);

      const missing = await fetch(`${relayBaseUrl(relay)}/nope`);
      assert.equal(missing.status, 404);
    } finally {
      ws.close();
    }
  } finally {
    await relay.close();
    await echo.close();
  }
});

test('token authentication rejects missing/incorrect tokens and accepts header tokens', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay({ auth: { tokens: ['s3cret'] } });
  const target = `127.0.0.1:${echo.port}`;
  const port = relay.address.port;
  try {
    await assert.rejects(connect(`ws://127.0.0.1:${port}/udp/${target}`), (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(JSON.parse(error.body).code, 'unauthorized');
      return true;
    });
    await assert.rejects(connect(`ws://127.0.0.1:${port}/udp/${target}?token=wrong`), (error) => error.statusCode === 401);
    const ws = await connect(`ws://127.0.0.1:${port}/udp/${target}`, {
      headers: { authorization: 'Bearer s3cret' },
    });
    try {
      await assertEcho(ws, Buffer.from('hello'));
    } finally {
      ws.close();
    }
    const wsQuery = await connect(`ws://127.0.0.1:${port}/udp/${target}?token=s3cret`);
    wsQuery.close();
  } finally {
    await relay.close();
    await echo.close();
  }
});

test('SSRF protection rejects private targets unless allowlisted', async () => {
  const echo = await startEchoServer();
  try {
    const relay = await startRelay({ security: { allowPrivate: false, allowlist: [] } });
    try {
      await assert.rejects(connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`), (error) => {
        assert.equal(error.statusCode, 403);
        const body = JSON.parse(error.body);
        assert.equal(body.code, 'target_not_allowed');
        assert.match(body.error, /loopback/);
        return true;
      });
    } finally {
      await relay.close();
    }

    // Hostname resolving to a private address is also rejected (protects against
    // DNS answers that point into the LAN / metadata service).
    const dnsRelay = await startRelay(
      { security: { allowPrivate: false, allowlist: [] } },
      { lookup: async () => [{ address: '169.254.169.254', family: 4 }] },
    );
    try {
      await assert.rejects(
        connect(`ws://127.0.0.1:${dnsRelay.address.port}/udp/metadata.example.com:80`),
        (error) => error.statusCode === 403 && JSON.parse(error.body).code === 'target_not_allowed',
      );
    } finally {
      await dnsRelay.close();
    }

    // Explicit allowlist entry permits a loopback target.
    const allowedRelay = await startRelay({ security: { allowPrivate: false, allowlist: ['127.0.0.1/32'] } });
    try {
      const ws = await connect(`ws://127.0.0.1:${allowedRelay.address.port}/udp/127.0.0.1:${echo.port}`);
      ws.close();
    } finally {
      await allowedRelay.close();
    }
  } finally {
    await echo.close();
  }
});

test('origin allowlist rejects unknown browser origins', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay({ auth: { originAllowlist: ['https://relay.example.com'] } });
  try {
    await assert.rejects(
      connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`, {
        headers: { origin: 'https://evil.example.com' },
      }),
      (error) => error.statusCode === 403 && JSON.parse(error.body).code === 'origin_denied',
    );
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`, {
      headers: { origin: 'https://relay.example.com' },
    });
    ws.close();
  } finally {
    await relay.close();
    await echo.close();
  }
});

test('frames larger than 2048 bytes are dropped and counted, connection survives', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay();
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`);
    try {
      await sendBinary(ws, Buffer.alloc(3000, 0x11));
      // The oversized frame must not be forwarded; the next valid frame still works.
      await assertEcho(ws, Buffer.alloc(64, 0x22));
      // Exactly maxFrameBytes is still accepted.
      await assertEcho(ws, Buffer.alloc(2048, 0x33));
      const snapshot = relay.stats.snapshot();
      assert.ok(snapshot.droppedFrames >= 1);
      assert.ok((snapshot.dropsByReason.frame_too_large ?? 0) >= 1);
    } finally {
      ws.close();
    }
  } finally {
    await relay.close();
    await echo.close();
  }
});

test('per-connection packet rate limit drops excess packets', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay({
    limits: { maxPacketsPerSecond: 2, packetBurst: 2 },
  });
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`);
    try {
      let received = 0;
      ws.on('message', () => { received += 1; });
      for (let i = 0; i < 10; i += 1) await sendBinary(ws, Buffer.from([i]));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(received <= 4, `expected at most 4 echoed packets, got ${received}`);
      const snapshot = relay.stats.snapshot();
      assert.ok((snapshot.dropsByReason.packet_rate ?? 0) >= 6, JSON.stringify(snapshot.dropsByReason));
    } finally {
      ws.close();
    }
  } finally {
    await relay.close();
    await echo.close();
  }
});


test('DDNet-like ~60 packets/sec client stream is not rate limited', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay();
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`);
    try {
      let received = 0;
      ws.on('message', () => { received += 1; });
      const started = Date.now();
      for (let i = 0; i < 60; i += 1) {
        await sendBinary(ws, Buffer.alloc(64, i & 0xff));
        // ~62.5 packets/s, i.e. DDNet's per-tick client send rate.
        const elapsedInSlot = (Date.now() - started) % 16;
        await new Promise((resolve) => setTimeout(resolve, 16 - elapsedInSlot));
      }
      const deadline = Date.now() + 3000;
      while (received < 60 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(received, 60, `expected all 60 echoes, got ${received}`);
      const snapshot = relay.stats.snapshot();
      assert.equal(snapshot.dropsByReason.packet_rate ?? 0, 0);
      assert.equal(snapshot.dropsByReason.byte_rate ?? 0, 0);
      assert.equal(snapshot.packetsToTarget, 60);
      assert.equal(snapshot.packetsFromTarget, 60);
    } finally {
      ws.close();
    }
  } finally {
    await relay.close();
    await echo.close();
  }
});

test('WS ping/pong keepalive does not consume the packet rate budget', async () => {
  const echo = await startEchoServer();
  // Tiny packet budget so that ping/pong traffic would be obvious if it were counted.
  const relay = await startRelay({
    limits: { maxPacketsPerSecond: 1, packetBurst: 2, pingIntervalMs: 100, idleTimeoutMs: 0 },
  });
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`);
    try {
      await assertEcho(ws, Buffer.from('a'));
      await assertEcho(ws, Buffer.from('b'));
      // Several ping/pong exchanges happen here; pongs must not spend packet tokens.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await assertEcho(ws, Buffer.from('c'));
      assert.equal(relay.stats.snapshot().dropsByReason.packet_rate ?? 0, 0);
    } finally {
      ws.close();
    }
  } finally {
    await relay.close();
    await echo.close();
  }
});
test('idle connections are closed after the idle timeout', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay({ limits: { idleTimeoutMs: 200, pingIntervalMs: 0 } });
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`);
    const closed = await nextClose(ws, 3000);
    assert.equal(closed.code, 1001);
    assert.equal(closed.reason, 'idle_timeout');
    assert.equal(relay.stats.snapshot().closeReasons.idle_timeout, 1);
  } finally {
    await relay.close();
    await echo.close();
  }
});

test('per-IP connection limit rejects the second connection from one IP', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay({ limits: { maxConnectionsPerIp: 1, maxConnectionsTotal: 10 } });
  const url = `ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`;
  try {
    const first = await connect(url);
    await assert.rejects(connect(url), (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(JSON.parse(error.body).code, 'too_many_connections');
      return true;
    });
    const closed = nextClose(first);
    first.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await connect(url);
    third.close();
  } finally {
    await relay.close();
    await echo.close();
  }
});

test('unreachable UDP target closes the session without crashing the relay', async () => {
  const echo = await startEchoServer();
  const deadPort = echo.port;
  await echo.close();
  const relay = await startRelay();
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${deadPort}`);
    const closed = nextClose(ws, 4000);
    await sendBinary(ws, Buffer.from('ping'));
    const result = await closed;
    assert.equal(result.code, 1011);
    assert.equal(result.reason, 'target_unreachable');
    assert.equal(relay.stats.snapshot().closeReasons.target_unreachable, 1);
    // Relay still serves HTTP afterwards.
    const health = await fetch(`${relayBaseUrl(relay)}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await relay.close();
  }
});

test('graceful shutdown closes active WebSockets with code 1001', async () => {
  const echo = await startEchoServer();
  const relay = await startRelay();
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.address.port}/udp/127.0.0.1:${echo.port}`);
    const closed = nextClose(ws);
    await relay.close();
    const result = await closed;
    assert.equal(result.code, 1001);
    assert.equal(result.reason, 'server_shutdown');
    assert.equal(relay.sessions.size, 0);
    await relay.close(); // idempotent
  } finally {
    await echo.close();
  }
});

test('getClientIp uses X-Forwarded-For only when trustProxy is enabled', () => {
  const req = {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    socket: { remoteAddress: '::ffff:127.0.0.1' },
  };
  assert.equal(getClientIp(req, false), '127.0.0.1');
  assert.equal(getClientIp(req, true), '203.0.113.9');
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': 'garbage' }, socket: { remoteAddress: '127.0.0.1' } }, true), '127.0.0.1');
});
