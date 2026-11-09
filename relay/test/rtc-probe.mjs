#!/usr/bin/env node
/**
 * Standalone WebRTC latency probe for a running relay.
 *
 * Mimics the browser: POST /rtc/offer, establish the data channel, send pings
 * and print the measured RTTs. Also supports a concurrency smoke test.
 *
 * Usage:
 *   node test/rtc-probe.mjs [--relay http://127.0.0.1:8390] [--token T]
 *                           [--count 5] [--concurrency 1] [--timeout 5000]
 */
import process from 'node:process';
import crypto from 'node:crypto';
import nodeDataChannel from 'node-datachannel';

const HELP = `WebRTC relay probe

Options:
  --relay <url>        Relay base URL (default http://127.0.0.1:8390; ws:// accepted)
  --token <token>      Relay token (query parameter)
  --count <n>          Number of sequential RTT pings (default 5)
  --concurrency <n>    Also open n parallel peers/data channels (default 1)
  --timeout <ms>       Per-step timeout (default 5000)
  --help               Show this help
`;

function parseArgs(argv) {
  const options = {
    relay: process.env.RELAY_URL ?? 'http://127.0.0.1:8390',
    token: process.env.RELAY_TOKEN ?? '',
    count: 5,
    concurrency: 1,
    timeoutMs: 5000,
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
      case '--token': options.token = next(); break;
      case '--count': options.count = Number(next()); break;
      case '--concurrency': options.concurrency = Number(next()); break;
      case '--timeout': options.timeoutMs = Number(next()); break;
      case '-h':
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function httpBase(relay) {
  return relay.replace(/\/+$/, '').replace(/^ws/, 'http');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function createClient(label) {
  const pc = new nodeDataChannel.PeerConnection(
    'probe-' + label + '-' + crypto.randomUUID().slice(0, 8),
    { iceServers: [] },
  );
  const dc = pc.createDataChannel('latency');
  const queue = { messages: [], waiters: [] };
  dc.onMessage((message) => {
    const waiter = queue.waiters.shift();
    if (waiter) waiter(message);
    else queue.messages.push(message);
  });
  dc.onError((error) => {
    for (const waiter of queue.waiters.splice(0)) waiter.reject?.(String(error));
  });
  dc.onClosed(() => {
    for (const waiter of queue.waiters.splice(0)) waiter.reject?.('data channel closed');
  });
  return { pc, dc, queue };
}

function nextMessage(queue, timeoutMs) {
  if (queue.messages.length > 0) return Promise.resolve(queue.messages.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for echo')), timeoutMs);
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

async function makeOffer(client, timeoutMs) {
  client.pc.setLocalDescription('offer');
  await waitFor(() => {
    const description = client.pc.localDescription();
    return Boolean(description?.sdp && /a=candidate/.test(description.sdp) && client.pc.gatheringState() === 'complete');
  }, timeoutMs, 'client ICE gathering');
  return { type: 'offer', sdp: client.pc.localDescription().sdp };
}

async function offer(relay, token, client, timeoutMs) {
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const response = await fetch(`${relay}/rtc/offer${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await makeOffer(client, timeoutMs)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${body.error ?? 'offer rejected'}`);
    error.code = body.code;
    throw error;
  }
  client.pc.setRemoteDescription(body.sdp, 'answer');
  await waitFor(() => client.dc.isOpen(), timeoutMs, 'data channel open');
  return body;
}

function closeClient(client) {
  try { client.dc.close(); } catch {}
  try { client.pc.close(); } catch {}
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const relay = httpBase(options.relay);
  const info = await fetch(`${relay}/api/info`, { signal: AbortSignal.timeout(options.timeoutMs) }).then((response) => response.json());
  console.log(`relay : ${relay}`);
  console.log(`info  : name="${info.name}" region="${info.region}" protocol=${info.protocol} rtc=${info.rtc}`);
  if (!info.rtc) throw new Error('relay reports rtc=false');

  const rtts = [];
  for (let i = 0; i < options.count; i += 1) {
    const client = createClient('seq-' + i);
    try {
      await offer(relay, options.token, client, options.timeoutMs);
      const payload = `rtt:${i}:${Date.now()}`;
      const sentAt = performance.now();
      client.dc.sendMessage(payload);
      const echo = await nextMessage(client.queue, options.timeoutMs);
      if (echo !== payload) throw new Error('echo payload mismatch');
      rtts.push(performance.now() - sentAt);
    } finally {
      closeClient(client);
    }
  }
  console.log('RTT ms:', rtts.map((value) => value.toFixed(2)).join(', '));
  console.log('RTT avg:', (rtts.reduce((sum, value) => sum + value, 0) / rtts.length).toFixed(2), 'ms');

  // Give the relay a moment to reap the sequential peers before opening the
  // parallel batch; every peer counts against rtc.maxPeers until closed.
  await sleep(800);

  if (options.concurrency > 1) {
    const clients = [];
    try {
      for (let i = 0; i < options.concurrency; i += 1) clients.push(createClient('par-' + i));
      await Promise.all(clients.map((client) => offer(relay, options.token, client, options.timeoutMs)));
      await Promise.all(clients.map(async (client, index) => {
        const payload = `parallel-${index}`;
        client.dc.sendMessage(payload);
        if (await nextMessage(client.queue, options.timeoutMs) !== payload) throw new Error('echo mismatch');
      }));
      console.log(`concurrency: ${options.concurrency} peers + data channels echo OK`);
    } finally {
      for (const client of clients) closeClient(client);
    }
  }

  const health = await fetch(`${relay}/healthz`, { signal: AbortSignal.timeout(options.timeoutMs) }).then((response) => response.json());
  console.log(`health: status=${health.status} activeConnections=${health.activeConnections} rtc=${health.rtc}`);
  console.log('PASS');
  return 0;
}

try {
  const code = await main();
  await sleep(100);
  try { nodeDataChannel.cleanup(); } catch {}
  process.exit(code);
} catch (error) {
  console.error('FAIL:', error.message);
  try { nodeDataChannel.cleanup(); } catch {}
  process.exit(1);
}
