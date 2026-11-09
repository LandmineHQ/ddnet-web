// 后端延迟测量：优先 WebRTC 数据通道往返，失败自动回退 ws 握手 / HTTP TTFB。
// RTCPeerConnection / fetch / clock 均可注入，便于 Node 单测。

import { probeRelay } from './probe.js';
import { buildInfoHttpUrl, buildRtcOfferHttpUrl, normalizeRelayBase } from './relayurl.js';

export const LATENCY_METHOD_LABEL = {
  webrtc: 'WebRTC',
  ws: 'WS 握手',
  http: 'HTTP',
  none: '未知',
};

export function median(values) {
  const list = (values || []).filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

export function minValue(values) {
  const list = (values || []).filter((value) => Number.isFinite(value));
  if (!list.length) return null;
  return Math.min.apply(null, list);
}

export function rankRelayEntries(entries) {
  const weight = { measuring: 0, idle: 1, fail: 2 };
  return (entries || []).slice().sort((a, b) => {
    const aLatency = Number.isFinite(a.latency) ? a.latency : null;
    const bLatency = Number.isFinite(b.latency) ? b.latency : null;
    if (aLatency != null && bLatency != null) {
      if (aLatency !== bLatency) return aLatency - bLatency;
      return String(a.relay && a.relay.name || '').localeCompare(String(b.relay && b.relay.name || ''));
    }
    if (aLatency != null) return -1;
    if (bLatency != null) return 1;
    const aWeight = weight[a.status] != null ? weight[a.status] : 3;
    const bWeight = weight[b.status] != null ? weight[b.status] : 3;
    if (aWeight !== bWeight) return aWeight - bWeight;
    return String(a.relay && a.relay.name || '').localeCompare(String(b.relay && b.relay.name || ''));
  });
}

export function parseRtcAnswer(data) {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const candidate = value.answer && typeof value.answer === 'object' ? value.answer : value;
  const sdp = typeof candidate.sdp === 'string' && candidate.sdp
    ? candidate.sdp
    : typeof value.sdp === 'string' ? value.sdp : '';
  if (!sdp) return null;
  return { type: 'answer', sdp };
}

export function normalizePlayers(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const online = Number(value.online != null ? value.online : value.current != null ? value.current : value.count);
    if (Number.isFinite(online)) return online;
  }
  return null;
}

export function normalizeRelayInfo(raw, relay) {
  const fallbackName = (relay && relay.name) || '';
  const base = {
    name: fallbackName,
    region: '',
    recommended: false,
    players: null,
    note: '',
    version: '',
    rtc: null,
    iceServers: [],
  };
  if (!raw || typeof raw !== 'object') return base;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 64) : base.name;
  const region = typeof raw.region === 'string' ? raw.region.trim().slice(0, 32) : '';
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 160) : '';
  const version = typeof raw.version === 'string' ? raw.version.slice(0, 32) : '';
  const recommended = raw.recommended === true || raw.default === true || raw.featured === true;
  const players = normalizePlayers(raw.players != null ? raw.players : raw.online);
  const rtc = raw.rtc === false ? null : raw.rtc != null ? raw.rtc : null;
  const iceServers = Array.isArray(raw.iceServers)
    ? raw.iceServers.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 8).map((entry) => entry.trim().slice(0, 256))
    : [];
  return { name, region, recommended, players, note, version, rtc, iceServers };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5000) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前环境不支持 fetch' };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (error) {
      // 忽略
    }
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = null;
    }
    if (!response.ok) return { ok: false, error: 'HTTP ' + response.status, status: response.status };
    if (!data) return { ok: false, error: '响应不是合法 JSON', status: response.status };
    return { ok: true, data, status: response.status };
  } catch (error) {
    const message = (error && error.message) || String(error);
    if (/abort/i.test(message)) return { ok: false, error: '请求超时' };
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRelayInfo(relay, options = {}) {
  const norm = normalizeRelayBase(relay && relay.url);
  if (!norm.ok) return { ok: false, error: norm.error, info: normalizeRelayInfo(null, relay) };
  const result = await fetchJsonWithTimeout(buildInfoHttpUrl(norm.base), options, options.timeoutMs || 4000);
  if (!result.ok) {
    return { ok: false, error: result.error, info: normalizeRelayInfo(null, relay) };
  }
  return { ok: true, info: normalizeRelayInfo(result.data, relay), raw: result.data };
}

function waitForIceGathering(pc, timeoutMs) {
  if (!pc || pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof pc.removeEventListener === 'function') {
        pc.removeEventListener('icegatheringstatechange', onChange);
      } else {
        pc.onicegatheringstatechange = null;
      }
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof pc.addEventListener === 'function') pc.addEventListener('icegatheringstatechange', onChange);
    else pc.onicegatheringstatechange = onChange;
  });
}

function waitForChannelOpen(channel, timeoutMs) {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof channel.removeEventListener === 'function') {
        channel.removeEventListener('open', onOpen);
        channel.removeEventListener('close', onClose);
      }
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish(null);
    const onClose = () => finish(new Error('WebRTC 数据通道被关闭'));
    const timer = setTimeout(() => finish(new Error('WebRTC 数据通道连接超时')), timeoutMs);
    if (typeof channel.addEventListener === 'function') {
      channel.addEventListener('open', onOpen);
      channel.addEventListener('close', onClose);
    } else {
      channel.onopen = onOpen;
      channel.onclose = onClose;
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 通过中继的 /rtc/offer 交换 SDP，并在 datachannel 上做 5 次 ping 取 RTT
export async function measureWebRtcRtt(relay, options = {}) {
  const RTCPeerConnectionImpl = options.RTCPeerConnectionImpl || globalThis.RTCPeerConnection;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => (globalThis.performance && globalThis.performance.now ? globalThis.performance.now() : Date.now()));
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const pingCount = Number.isFinite(options.pingCount) ? options.pingCount : 5;

  if (typeof RTCPeerConnectionImpl !== 'function') {
    return { ok: false, error: '当前环境不支持 WebRTC', method: 'webrtc' };
  }
  const norm = normalizeRelayBase(relay && relay.url);
  if (!norm.ok) return { ok: false, error: norm.error, method: 'webrtc' };

  let pc = null;
  let channel = null;
  try {
    const iceServers = Array.isArray(options.iceServers)
      ? options.iceServers.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 8)
      : [];
    pc = new RTCPeerConnectionImpl({ iceServers });
    channel = pc.createDataChannel('lat', { ordered: true });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, options.iceTimeoutMs || 1500);
    const local = pc.localDescription || offer;
    if (!local || !local.sdp) throw new Error('无法生成 WebRTC offer');

    const controller = new AbortController();
    const fetchTimer = setTimeout(() => {
      try {
        controller.abort();
      } catch (error) {
        // 忽略
      }
    }, timeoutMs);
    let response;
    try {
      const rtcUrl = new URL(buildRtcOfferHttpUrl(norm.base));
      const token = typeof relay.token === 'string' ? relay.token.trim() : '';
      if (token) rtcUrl.searchParams.set('token', token);
      response = await fetchImpl(rtcUrl.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ type: 'offer', sdp: local.sdp }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(fetchTimer);
    }
    if (!response || !response.ok) {
      throw new Error('中继 /rtc/offer 返回 HTTP ' + (response ? response.status : '无响应'));
    }
    const answerText = typeof response.text === 'function' ? await response.text() : '';
    const answer = parseRtcAnswer(answerText);
    if (!answer) throw new Error('中继返回的 WebRTC answer 无效');
    await pc.setRemoteDescription(answer);
    await waitForChannelOpen(channel, timeoutMs);

    const samples = [];
    for (let seq = 0; seq < pingCount; seq += 1) {
      const startedAt = now();
      const payload = JSON.stringify({ type: 'ping', t: startedAt, seq });
      const rtt = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error('ping 超时')), timeoutMs);
        function finish(error, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (typeof channel.removeEventListener === 'function') channel.removeEventListener('message', onMessage);
          else channel.onmessage = null;
          if (error) reject(error);
          else resolve(value);
        }
        function onMessage(event) {
          try {
            const data = JSON.parse(String(event.data));
            if (data && data.seq === seq && Number.isFinite(Number(data.t))) {
              finish(null, now() - Number(data.t));
            }
          } catch (error) {
            // 忽略非 JSON 回显
          }
        }
        if (typeof channel.addEventListener === 'function') channel.addEventListener('message', onMessage);
        else channel.onmessage = onMessage;
        try {
          channel.send(payload);
        } catch (error) {
          finish(error);
        }
      });
      samples.push(rtt);
      await sleep(options.pingIntervalMs || 60);
    }

    const values = samples.filter((value) => Number.isFinite(value));
    if (!values.length) throw new Error('未收到 WebRTC ping 回显');
    return {
      ok: true,
      method: 'webrtc',
      samples: values,
      min: minValue(values),
      median: median(values),
      latencyMs: median(values),
      detail: 'WebRTC 数据通道',
    };
  } catch (error) {
    return { ok: false, method: 'webrtc', error: (error && error.message) || String(error) };
  } finally {
    try {
      if (channel && typeof channel.close === 'function') channel.close();
    } catch (error) {
      // 忽略
    }
    try {
      if (pc && typeof pc.close === 'function') pc.close();
    } catch (error) {
      // 忽略
    }
  }
}

export async function measureRelayLatency(relay, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  let webrtcError = '';
  if (options.webrtc !== false && options.prefer !== 'fallback') {
    const webrtc = await measureWebRtcRtt(relay, Object.assign({}, options, { timeoutMs }));
    if (webrtc.ok) {
      return {
        ok: true,
        method: 'webrtc',
        latencyMs: webrtc.latencyMs,
        min: webrtc.min,
        median: webrtc.median,
        samples: webrtc.samples,
        detail: 'WebRTC 数据通道',
      };
    }
    webrtcError = webrtc.error || 'WebRTC 不可用';
    // 不在这里提前返回：没有显式 fallback 时也继续走下面的 probeRelay
    //（WebSocket 握手 / HTTP /healthz）。Go 中继没有 WebRTC 栈，这是常态路径。
  }

  const fallback = typeof options.fallback === 'function'
    ? await options.fallback(relay, options)
    : await probeRelay(relay, { timeoutMs });
  if (fallback && fallback.ok) {
    const method = fallback.method === 'ws' ? 'ws' : 'http';
    return {
      ok: true,
      method,
      latencyMs: Number.isFinite(fallback.rttMs) ? fallback.rttMs : fallback.latencyMs,
      detail: method === 'ws' ? 'WebSocket 握手' : 'HTTP /healthz',
      webrtcError,
      fallbackFrom: webrtcError,
    };
  }
  return {
    ok: false,
    method: 'none',
    error: (fallback && fallback.error) || webrtcError || '无法测量延迟',
    webrtcError,
  };
}
