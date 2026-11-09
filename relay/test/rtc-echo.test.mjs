import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodeDataChannel from 'node-datachannel';
import { createRelayServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';

function silentLogger() {
  return createLogger({ level: 'silent', stream: { write() {} } });
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

function relayHttp(relay) {
  return `http://127.0.0.1:${relay.address.port}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Low-level node-datachannel client mimicking a browser RTCPeerConnection. */
function createClient(label = 'probe') {
  const name = 'test-' + label + '-' + crypto.randomUUID().slice(0, 8);
  const pc = new nodeDataChannel.PeerConnection(name, { iceServers: [] });
  const dc = pc.createDataChannel(label);
  const queue = { messages: [], waiters: [] };
  dc.onMessage((message) => {
    const waiter = queue.waiters.shift();
    if (waiter) waiter(message);
    else queue.messages.push(message);
  });
  dc.onError((error) => {
    for (const waiter of queue.waiters.splice(0)) waiter.reject?.(new Error(String(error)));
  });
  dc.onClosed(() => {
    for (const waiter of queue.waiters.splice(0)) waiter.reject?.(new Error('data channel closed'));
  });
  return { pc, dc, queue };
}

function nextMessage(queue, timeoutMs = 3000) {
  if (queue.messages.length > 0) return Promise.resolve(queue.messages.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = queue.waiters.indexOf(entry);
      if (index >= 0) queue.waiters.splice(index, 1);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for a data channel echo`));
    }, timeoutMs);
    const entry = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
    entry.reject = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    queue.waiters.push(entry);
  });
}

async function makeOffer(client, timeoutMs = 5000) {
  client.pc.setLocalDescription('offer');
  await waitFor(() => {
    const description = client.pc.localDescription();
    return Boolean(description?.sdp && /a=candidate/.test(description.sdp) && client.pc.gatheringState() === 'complete');
  }, timeoutMs, 'client ICE candidate gathering');
  return { type: 'offer', sdp: client.pc.localDescription().sdp };
}

async function applyAnswer(client, answer, timeoutMs = 5000) {
  client.pc.setRemoteDescription(answer.sdp, 'answer');
  await waitFor(() => client.dc.isOpen(), timeoutMs, 'data channel open');
}

async function postOffer(relay, offer, { query = '', headers = {} } = {}) {
  return fetch(`${relayHttp(relay)}/rtc/offer${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(offer),
  });
}

function closeClient(client) {
  try {
    client.dc.close();
  } catch {
    /* ignore */
  }
  try {
    client.pc.close();
  } catch {
    /* ignore */
  }
}

test('WebRTC offer/answer + data channel echo with RTT measurements', async () => {
  const relay = await startRelay();
  const client = createClient('ping');
  try {
    const info = await fetch(`${relayHttp(relay)}/api/info`).then((response) => response.json());
    assert.equal(info.name, 'DDNet Relay');
    assert.equal(info.version, '1.0.0');
    assert.equal(info.protocol, 'ws-udp-datagram/1');
    assert.equal(info.region, '');
    assert.equal(info.rtc, true);
    assert.equal(info.activeConnections, 0);
    assert.ok(info.uptimeSec >= 0);

    const offer = await makeOffer(client);
    const response = await postOffer(relay, offer);
    assert.equal(response.status, 200, await response.clone().text());
    const answer = await response.json();
    assert.equal(answer.type, 'answer');
    assert.match(answer.sdp, /^v=0/);
    assert.match(answer.sdp, /a=candidate/);
    await applyAnswer(client, answer);
    assert.equal(client.dc.isOpen(), true);

    const rtts = [];
    for (let i = 0; i < 5; i += 1) {
      const payload = `ping:${i}:${Date.now()}`;
      const sentAt = performance.now();
      client.dc.sendMessage(payload);
      const echo = await nextMessage(client.queue);
      assert.equal(echo, payload);
      rtts.push(performance.now() - sentAt);
      await wait(10);
    }
    console.log('RTC echo RTT (ms):', rtts.map((value) => value.toFixed(2)).join(', '));
    assert.ok(rtts.every((value) => value >= 0 && value < 2000));

    const binary = Buffer.from([0, 1, 2, 127, 128, 250, 255]);
    client.dc.sendMessageBinary(binary);
    const binaryEcho = await nextMessage(client.queue);
    assert.ok(Buffer.isBuffer(binaryEcho), 'binary payload must be echoed as binary');
    assert.deepEqual(Buffer.from(binaryEcho), binary);

    const text = 'DDNet relay 中文 echo ✅';
    client.dc.sendMessage(text);
    assert.equal(await nextMessage(client.queue), text);

    const stats = await fetch(`${relayHttp(relay)}/api/stats`).then((result) => result.json());
    assert.ok(stats.rtc.activePeers >= 1);
    assert.equal(stats.rtc.totalOffers, 1);
    assert.equal(stats.rtc.answersCreated, 1);
    assert.ok(stats.rtc.messagesEchoed >= 7);
    assert.equal(stats.config.rtc.enabled, true);
    assert.equal(stats.config.rtc.maxPeers, 16);
  } finally {
    closeClient(client);
    await relay.close();
  }
});

test('GET /api/info, /api/servers shape and CORS preflight', async () => {
  const relay = await startRelay({
    name: 'Test Relay',
    region: 'test-region',
    servers: [{ name: 'Local DDNet', host: '127.0.0.1', port: 8313 }],
  });
  try {
    const info = await fetch(`${relayHttp(relay)}/api/info`).then((response) => response.json());
    assert.deepEqual(
      { name: info.name, region: info.region, rtc: info.rtc, protocol: info.protocol },
      { name: 'Test Relay', region: 'test-region', rtc: true, protocol: 'ws-udp-datagram/1' },
    );

    const servers = await fetch(`${relayHttp(relay)}/api/servers`).then((response) => response.json());
    assert.equal(servers.count, 1);
    assert.equal(servers.servers[0].name, 'Local DDNet');
    assert.equal(servers.servers[0].host, '127.0.0.1');
    assert.equal(servers.servers[0].port, 8313);
    assert.equal(servers.servers[0].address, '127.0.0.1:8313');

    const preflight = await fetch(`${relayHttp(relay)}/rtc/offer`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://frontend.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-relay-token',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /x-relay-token/);

    const stats = await fetch(`${relayHttp(relay)}/api/stats`).then((response) => response.json());
    assert.equal(stats.config.name, 'Test Relay');
    assert.equal(stats.config.region, 'test-region');
    assert.equal(stats.config.rtc.maxPeers, 16);
    assert.equal(stats.rtc.available, true);
  } finally {
    await relay.close();
  }
});

test('RTC offer authentication accepts query token and x-relay-token header', async () => {
  const relay = await startRelay({ auth: { tokens: ['rtc-secret'] } });
  const clients = [];
  try {
    const first = createClient('auth-query');
    clients.push(first);
    const offer = await makeOffer(first);

    const missing = await postOffer(relay, offer);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, 'unauthorized');

    const wrong = await postOffer(relay, offer, { query: '?token=wrong' });
    assert.equal(wrong.status, 401);

    const viaQuery = await postOffer(relay, offer, { query: '?token=rtc-secret' });
    assert.equal(viaQuery.status, 200);
    const answer = await viaQuery.json();
    assert.equal(answer.type, 'answer');
    await applyAnswer(first, answer);

    const second = createClient('auth-header');
    clients.push(second);
    const viaHeader = await postOffer(relay, await makeOffer(second), {
      headers: { 'x-relay-token': 'rtc-secret' },
    });
    assert.equal(viaHeader.status, 200);
    await applyAnswer(second, await viaHeader.json());

    const stats = await fetch(`${relayHttp(relay)}/api/stats`).then((response) => response.json());
    assert.equal(stats.config.auth.tokensConfigured, 1);
    assert.equal(JSON.stringify(stats).includes('rtc-secret'), false);
  } finally {
    for (const client of clients) closeClient(client);
    await relay.close();
  }
});

test('RTC offer enforces the Origin allowlist', async () => {
  const relay = await startRelay({ auth: { originAllowlist: ['https://frontend.example.com'] } });
  const client = createClient('origin');
  try {
    const offer = await makeOffer(client);
    const denied = await postOffer(relay, offer, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'origin_denied');
    const allowed = await postOffer(relay, offer, { headers: { origin: 'https://frontend.example.com' } });
    assert.equal(allowed.status, 200);
    await applyAnswer(client, await allowed.json());
  } finally {
    closeClient(client);
    await relay.close();
  }
});

test('RTC endpoint enforces disabled, busy, invalid, oversized and per-IP rate limits', async () => {
  const disabled = await startRelay({ rtc: { enabled: false } });
  try {
    const response = await fetch(`${relayHttp(disabled)}/rtc/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'rtc_disabled');
    const info = await fetch(`${relayHttp(disabled)}/api/info`).then((result) => result.json());
    assert.equal(info.rtc, false);
  } finally {
    await disabled.close();
  }

  const busyRelay = await startRelay({ rtc: { maxPeers: 1 } });
  const busyFirst = createClient('busy-1');
  const busySecond = createClient('busy-2');
  try {
    const firstAnswer = await postOffer(busyRelay, await makeOffer(busyFirst));
    assert.equal(firstAnswer.status, 200);
    const secondAnswer = await postOffer(busyRelay, await makeOffer(busySecond));
    assert.equal(secondAnswer.status, 503);
    assert.equal((await secondAnswer.json()).code, 'rtc_busy');
  } finally {
    closeClient(busyFirst);
    closeClient(busySecond);
    await busyRelay.close();
  }

  const limitsRelay = await startRelay({
    rtc: { maxOfferBytes: 2048, maxOffersPerIpPerMinute: 2, offerBurst: 1 },
  });
  const limitsClient = createClient('limits');
  try {
    const invalid = await fetch(`${relayHttp(limitsRelay)}/rtc/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'invalid_offer');

    const oversized = await fetch(`${relayHttp(limitsRelay)}/rtc/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp: 'v=0\r\n' + 'a=x'.repeat(2000) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, 'offer_too_large');

    const offer = await makeOffer(limitsClient);
    const first = await postOffer(limitsRelay, offer);
    assert.equal(first.status, 200);
    const second = await postOffer(limitsRelay, offer);
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, 'rtc_rate_limited');
  } finally {
    closeClient(limitsClient);
    await limitsRelay.close();
  }
});

test('RTC peers are closed after maxLifetimeMs', async () => {
  const relay = await startRelay({ rtc: { maxLifetimeMs: 300 } });
  const client = createClient('lifetime');
  try {
    const answer = await (await postOffer(relay, await makeOffer(client))).json();
    await applyAnswer(client, answer);
    await waitFor(() => relay.rtc.activePeers === 1, 1000, 'peer registered');
    const before = await fetch(`${relayHttp(relay)}/api/stats`).then((response) => response.json());
    assert.ok(before.rtc.activePeers >= 1);
    await wait(900);
    const after = await fetch(`${relayHttp(relay)}/api/stats`).then((response) => response.json());
    assert.equal(after.rtc.activePeers, 0);
    assert.equal(after.rtc.peersClosed >= 1, true);
  } finally {
    closeClient(client);
    await relay.close();
  }
});

test('16 concurrent WebRTC peers echo data without crashing', async () => {
  // 16 offers in parallel exceed the default per-IP burst of 10, so raise it
  // for this test only; real clients send at most a handful of offers.
  const relay = await startRelay({ rtc: { maxOffersPerIpPerMinute: 600, offerBurst: 60 } });
  const clients = [];
  try {
    for (let i = 0; i < 16; i += 1) clients.push(createClient('concurrent-' + i));
    const offers = await Promise.all(clients.map((client) => makeOffer(client)));
    const responses = await Promise.all(offers.map((offer) => postOffer(relay, offer)));
    responses.forEach((response, index) => {
      assert.equal(response.status, 200, `peer ${index} offer failed: ${response.status}`);
    });
    const answers = await Promise.all(responses.map((response) => response.json()));
    await Promise.all(clients.map((client, index) => applyAnswer(client, answers[index], 10000)));

    await Promise.all(clients.map(async (client, index) => {
      const payload = 'peer-' + index;
      client.dc.sendMessage(payload);
      assert.equal(await nextMessage(client.queue, 5000), payload);
    }));

    const stats = await fetch(`${relayHttp(relay)}/api/stats`).then((response) => response.json());
    assert.equal(stats.rtc.activePeers, 16);
    assert.equal(stats.rtc.answersCreated, 16);
    assert.ok(stats.rtc.messagesEchoed >= 16);
    const health = await fetch(`${relayHttp(relay)}/healthz`);
    assert.equal(health.status, 200);
    console.log('RTC concurrency: 16 peers, 16 data channels, 16 echoes OK');
  } finally {
    for (const client of clients) closeClient(client);
    await relay.close();
  }
});

test('RTC endpoint reports rtc_unavailable when the native module cannot load', async () => {
  const relay = await startRelay({}, {
    loadRtcModule: async () => {
      throw new Error('simulated missing native module');
    },
  });
  try {
    const info = await fetch(`${relayHttp(relay)}/api/info`).then((response) => response.json());
    assert.equal(info.rtc, false);
    const response = await fetch(`${relayHttp(relay)}/rtc/offer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'rtc_unavailable');
    // The UDP relay / other HTTP endpoints keep working.
    const health = await fetch(`${relayHttp(relay)}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await relay.close();
  }
});

// libdatachannel keeps native threads/handles alive; release them so the
// node:test process can exit on its own after the suite.
after(async () => {
  await wait(250);
  try {
    nodeDataChannel.cleanup();
  } catch {
    /* ignore */
  }
});
