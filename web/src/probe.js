// 中继测活 / /api/servers 拉取（可注入 WebSocket、fetch 以方便 Node 测试）

import { normalizeRelayBase } from './relayurl.js';

function now() {
  if (globalThis.performance && typeof globalThis.performance.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

function describeFetchError(error) {
  if (!error) return '请求失败';
  const message = error.message || String(error);
  if (error.name === 'AbortError' || /abort/i.test(message)) return '请求超时';
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return '网络请求失败（可能是跨域限制 CORS、证书问题或中继不可达）';
  }
  return message;
}

// 测活第一步：WebSocket 握手 RTT（/healthz 或任意可升级路径）
export function wsProbe(url, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  return new Promise((resolve) => {
    if (typeof WebSocketImpl !== 'function') {
      resolve({ ok: false, error: '当前环境不支持 WebSocket', url });
      return;
    }
    const started = now();
    let settled = false;
    let socket = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (socket) socket.close();
      } catch (error) {
        // 忽略关闭异常
      }
      resolve(result);
    };

    timer = setTimeout(() => {
      finish({ ok: false, error: '握手超时（>' + timeoutMs + ' ms）', url });
    }, timeoutMs);

    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      finish({ ok: false, error: '无法建立连接：' + ((error && error.message) || error), url });
      return;
    }

    try {
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      // 忽略
    }
    socket.onopen = () => {
      finish({ ok: true, rttMs: Math.max(0, now() - started), url });
    };
    socket.onerror = (event) => {
      const detail = (event && (event.message || (event.error && event.error.message))) || 'WebSocket 握手失败（地址不可达或被拒绝）';
      finish({ ok: false, error: detail, url });
    };
    socket.onclose = (event) => {
      const code = event && Number.isFinite(event.code) ? event.code : 1006;
      finish({ ok: false, error: 'WebSocket 已关闭（code ' + code + '）', url });
    };
  });
}

// 测活第二步：HTTP /healthz（中继若拒绝 ws 升级路径，仍可用 HTTP 判定存活）
export async function httpProbe(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: '当前环境不支持 fetch', url };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (error) {
      // 忽略
    }
  }, timeoutMs);
  const started = now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json, text/plain, */*' },
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    return {
      ok: response.ok,
      status: response.status,
      rttMs: Math.max(0, now() - started),
      text: String(text).slice(0, 500),
      url,
    };
  } catch (error) {
    return { ok: false, error: describeFetchError(error), url, rttMs: Math.max(0, now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeRelay(relayOrBase, options = {}) {
  const base = typeof relayOrBase === 'string'
    ? relayOrBase
    : (relayOrBase && (relayOrBase.url || relayOrBase.base)) || '';
  const norm = normalizeRelayBase(base);
  if (!norm.ok) {
    return { ok: false, method: 'none', error: norm.error, checkedAt: Date.now() };
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;

  const wsUrl = norm.wsBase + '/healthz';
  const ws = await wsProbe(wsUrl, Object.assign({}, options, { timeoutMs }));
  if (ws.ok) {
    return {
      ok: true,
      method: 'ws',
      rttMs: ws.rttMs,
      checkedAt: Date.now(),
      detail: 'WebSocket 握手成功',
      wsUrl,
    };
  }

  const httpUrl = norm.httpBase + '/healthz';
  const http = await httpProbe(httpUrl, Object.assign({}, options, { timeoutMs }));
  if (http.ok) {
    return {
      ok: true,
      method: 'http',
      rttMs: http.rttMs,
      status: http.status,
      checkedAt: Date.now(),
      detail: 'HTTP /healthz 返回 ' + http.status,
      wsUrl,
      httpUrl,
    };
  }

  return {
    ok: false,
    method: 'none',
    checkedAt: Date.now(),
    error: [ws.error, http.error].filter(Boolean).join('；'),
    wsError: ws.error,
    httpError: http.error,
    wsUrl,
    httpUrl,
  };
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
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
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = null;
      }
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: 'HTTP ' + response.status, text: String(text).slice(0, 300) };
    }
    if (data === null) {
      return { ok: false, status: response.status, error: '响应不是合法 JSON', text: String(text).slice(0, 300) };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    return { ok: false, error: describeFetchError(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeServerEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const host = typeof item.host === 'string' ? item.host.trim() : '';
  const port = Number(item.port);
  if (!host || host.indexOf('/') >= 0 || /\s/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const name = typeof item.name === 'string' && item.name.trim()
    ? item.name.trim().slice(0, 80)
    : host + ':' + port;
  const region = typeof item.region === 'string' ? item.region.trim().slice(0, 40) : '';
  let players;
  if (typeof item.players === 'number' && Number.isFinite(item.players)) {
    players = item.players;
  } else if (item.players && typeof item.players === 'object') {
    const value = Number(item.players.online != null ? item.players.online : item.players.count);
    if (Number.isFinite(value)) players = value;
  }
  return { name, host, port, region, players, target: host + ':' + port };
}

export async function fetchServers(relayOrBase, options = {}) {
  const base = typeof relayOrBase === 'string'
    ? relayOrBase
    : (relayOrBase && (relayOrBase.url || relayOrBase.base)) || '';
  const norm = normalizeRelayBase(base);
  if (!norm.ok) return { ok: false, error: norm.error, servers: [] };
  const result = await fetchJson(norm.httpBase + '/api/servers', options);
  if (!result.ok) {
    return { ok: false, error: result.error, status: result.status, servers: [] };
  }
  const raw = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.data && result.data.servers)
      ? result.data.servers
      : null;
  if (!raw) {
    return { ok: false, error: '服务器列表格式无效（期望 {servers:[...]}）', servers: [] };
  }
  const servers = [];
  const warnings = [];
  raw.forEach((item, index) => {
    const normalized = normalizeServerEntry(item);
    if (normalized) servers.push(normalized);
    else warnings.push('第 ' + (index + 1) + ' 条服务器数据无效');
  });
  return { ok: true, servers, warnings, fetchedAt: Date.now(), url: norm.httpBase + '/api/servers' };
}

export async function fetchStats(relayOrBase, options = {}) {
  const base = typeof relayOrBase === 'string'
    ? relayOrBase
    : (relayOrBase && (relayOrBase.url || relayOrBase.base)) || '';
  const norm = normalizeRelayBase(base);
  if (!norm.ok) return { ok: false, error: norm.error };
  return fetchJson(norm.httpBase + '/api/stats', options);
}
