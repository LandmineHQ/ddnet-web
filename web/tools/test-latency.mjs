// 延迟测量单测：WebRTC 数据通道、回退、排序、/api/info
import assert from 'node:assert/strict';
import {
  fetchRelayInfo,
  measureRelayLatency,
  measureWebRtcRtt,
  median,
  minValue,
  normalizeRelayInfo,
  parseRtcAnswer,
  rankRelayEntries,
} from '../src/latency.js';

let passed = 0;
let failed = 0;

async function test(name, fn, timeoutMs = 8000) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('测试超时：' + name)), timeoutMs);
      }),
    ]);
    passed += 1;
    console.log('ok   ' + name);
  } catch (error) {
    failed += 1;
    console.log('FAIL ' + name);
    const detail = String((error && error.stack) || error).split('\n').slice(0, 8).join('\n');
    console.log('     ' + detail.split('\n').join('\n     '));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class FakeDataChannel {
  constructor(options = {}) {
    this.readyState = 'open';
    this.listeners = {};
    this.echo = options.echo !== false;
  }
  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners[type] || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  emit(type, event) {
    for (const handler of (this.listeners[type] || []).slice()) handler(event);
  }
  send(payload) {
    if (!this.echo) return;
    setTimeout(() => this.emit('message', { data: payload }), 1);
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  constructor(options = {}) {
    this.options = options;
    this.iceGatheringState = 'complete';
    this.localDescription = null;
    this.channel = options.channel || new FakeDataChannel({ echo: true });
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 fake offer' };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.channel.readyState = 'open';
    this.channel.emit('open', {});
  }
  close() {
    this.closed = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

function jsonFetch(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

await test('median / minValue', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(minValue([5, 2, 9]), 2);
  assert.equal(minValue([]), null);
});

await test('rankRelayEntries 按延迟升序，失败排后', () => {
  const entries = [
    { relay: { name: 'B' }, status: 'ok', latency: 80 },
    { relay: { name: 'A' }, status: 'ok', latency: 20 },
    { relay: { name: 'F' }, status: 'fail', latency: null },
    { relay: { name: 'M' }, status: 'measuring', latency: null },
    { relay: { name: 'C' }, status: 'ok', latency: 40 },
    { relay: { name: 'I' }, status: 'idle', latency: null },
  ];
  const sorted = rankRelayEntries(entries).map((entry) => entry.relay.name);
  assert.deepEqual(sorted, ['A', 'C', 'B', 'M', 'I', 'F']);
  const stable = rankRelayEntries([
    { relay: { name: 'Z' }, status: 'ok', latency: 20 },
    { relay: { name: 'Y' }, status: 'ok', latency: 20 },
  ]).map((entry) => entry.relay.name);
  assert.deepEqual(stable, ['Y', 'Z']);
});

await test('parseRtcAnswer 多种返回格式', () => {
  assert.deepEqual(parseRtcAnswer({ type: 'answer', sdp: 'v=0 a' }), { type: 'answer', sdp: 'v=0 a' });
  assert.deepEqual(parseRtcAnswer({ sdp: 'v=0 b' }), { type: 'answer', sdp: 'v=0 b' });
  assert.deepEqual(parseRtcAnswer({ answer: { type: 'answer', sdp: 'v=0 c' } }), { type: 'answer', sdp: 'v=0 c' });
  assert.deepEqual(parseRtcAnswer(JSON.stringify({ sdp: 'v=0 d' })), { type: 'answer', sdp: 'v=0 d' });
  assert.equal(parseRtcAnswer(null), null);
  assert.equal(parseRtcAnswer({}), null);
  assert.equal(parseRtcAnswer('not json'), null);
});

await test('normalizeRelayInfo 容错字段', () => {
  const info = normalizeRelayInfo({
    name: '  欧洲一号  ',
    region: 'EU',
    players: { online: 12, max: 32 },
    recommended: true,
    version: '1.2.3',
    rtc: { enabled: true },
  }, { name: 'fallback', url: 'wss://relay.test' });
  assert.equal(info.name, '欧洲一号');
  assert.equal(info.region, 'EU');
  assert.equal(info.players, 12);
  assert.equal(info.recommended, true);
  assert.equal(info.version, '1.2.3');
  assert.ok(info.rtc);

  const empty = normalizeRelayInfo(null, { name: 'fallback', url: 'wss://relay.test' });
  assert.equal(empty.name, 'fallback');
  assert.equal(empty.players, null);
  assert.equal(empty.recommended, false);

  assert.equal(normalizePlayersCheck({ online: 7 }), 7);
});

function normalizePlayersCheck(value) {
  return normalizeRelayInfo({ players: value }).players;
}

await test('measureWebRtcRtt：datachannel ping/pong', async () => {
  const fetchImpl = jsonFetch({ type: 'answer', sdp: 'v=0 answer' });
  const result = await measureWebRtcRtt(
    { url: 'ws://relay.test:8390', token: 'secret token' },
    {
      RTCPeerConnectionImpl: FakePeerConnection,
      fetchImpl,
      timeoutMs: 500,
      pingCount: 5,
      pingIntervalMs: 1,
    }
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.method, 'webrtc');
  assert.equal(result.samples.length, 5);
  assert.ok(result.latencyMs >= 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://relay.test:8390/rtc/offer?token=secret+token');
  assert.equal(fetchImpl.calls[0].method, 'POST');
  const payload = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(payload.type, 'offer');
  assert.ok(payload.sdp);
});

await test('measureWebRtcRtt：ping 无回显时失败', async () => {
  const channel = new FakeDataChannel({ echo: false });
  const fetchImpl = jsonFetch({ type: 'answer', sdp: 'v=0 answer' });
  const result = await measureWebRtcRtt(
    { url: 'ws://relay.test:8390' },
    {
      RTCPeerConnectionImpl: class extends FakePeerConnection {
        constructor(options = {}) {
          super(Object.assign({}, options, { channel }));
        }
      },
      fetchImpl,
      timeoutMs: 80,
      pingCount: 1,
      pingIntervalMs: 1,
    }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /ping 超时|未收到/);
});

await test('measureWebRtcRtt：/rtc/offer 返回 404', async () => {
  const fetchImpl = jsonFetch({ error: 'not found' }, 404);
  const result = await measureWebRtcRtt(
    { url: 'ws://relay.test:8390' },
    { RTCPeerConnectionImpl: FakePeerConnection, fetchImpl, timeoutMs: 300, pingCount: 1, pingIntervalMs: 1 }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 404/);
});

await test('measureRelayLatency：WebRTC 成功优先', async () => {
  const fetchImpl = jsonFetch({ type: 'answer', sdp: 'v=0 answer' });
  const result = await measureRelayLatency(
    { url: 'ws://relay.test:8390' },
    { RTCPeerConnectionImpl: FakePeerConnection, fetchImpl, timeoutMs: 500, pingCount: 3, pingIntervalMs: 1 }
  );
  assert.equal(result.ok, true);
  assert.equal(result.method, 'webrtc');
});

await test('measureRelayLatency：WebRTC 不可用时回退', async () => {
  const calls = [];
  const fallback = async (relay) => {
    calls.push(relay.url);
    return { ok: true, method: 'http', rttMs: 17, detail: 'HTTP /healthz 返回 200' };
  };
  const result = await measureRelayLatency(
    { url: 'ws://relay.test:8390' },
    {
      RTCPeerConnectionImpl: class BrokenPeerConnection {
        constructor() {
          throw new Error('WebRTC 被禁用');
        }
      },
      fallback,
      timeoutMs: 300,
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.method, 'http');
  assert.equal(result.latencyMs, 17);
  assert.match(result.webrtcError, /WebRTC 被禁用/);
  assert.deepEqual(calls, ['ws://relay.test:8390']);
});

await test('measureRelayLatency：全部失败返回错误', async () => {
  const result = await measureRelayLatency(
    { url: 'ws://relay.test:8390' },
    {
      RTCPeerConnectionImpl: class BrokenPeerConnection {
        constructor() {
          throw new Error('no rtc');
        }
      },
      fallback: async () => ({ ok: false, error: '网络不可达', method: 'none' }),
      timeoutMs: 300,
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.method, 'none');
  assert.match(result.error, /网络不可达/);
});

await test('fetchRelayInfo：读取 /api/info 并归一化', async () => {
  const fetchImpl = jsonFetch({ name: '测试中继', region: 'CN', players: 3, recommended: true });
  const result = await fetchRelayInfo({ url: 'ws://relay.test:8390', name: '本地' }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.info.name, '测试中继');
  assert.equal(result.info.region, 'CN');
  assert.equal(result.info.players, 3);
  assert.equal(fetchImpl.calls[0].url, 'http://relay.test:8390/api/info');

  const missing = await fetchRelayInfo({ url: 'ws://relay.test:8390', name: '本地' }, { fetchImpl: jsonFetch({}, 404) });
  assert.equal(missing.ok, false);
  assert.equal(missing.info.name, '本地');
});

console.log('');
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : ''));
process.exit(failed ? 1 : 0);
