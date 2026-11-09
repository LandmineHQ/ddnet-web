// 中继 URL 规范化、连接 URL 组装、分享/直连参数解析（纯函数）

const WS_SCHEMES = new Set(['ws:', 'wss:']);

// 整条 connect 命令需要作为单个命令行参数传递
export const MAX_CONNECT_URL_LENGTH = 400;

export function normalizeRelayBase(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, error: '地址不能为空' };
  if (/\s/.test(raw)) return { ok: false, error: '地址不能包含空格' };

  let withScheme = raw;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(withScheme)) {
    withScheme = 'wss://' + withScheme.replace(/^\/+/, '');
  }

  let url;
  try {
    url = new URL(withScheme);
  } catch (error) {
    return { ok: false, error: '不是有效的 URL' };
  }

  let scheme = url.protocol.toLowerCase();
  if (scheme === 'https:') scheme = 'wss:';
  else if (scheme === 'http:') scheme = 'ws:';
  if (!WS_SCHEMES.has(scheme)) {
    return { ok: false, error: '仅支持 ws:// 或 wss:// 中继地址（也可以填 https:// 自动转换）' };
  }
  if (!url.hostname) return { ok: false, error: '地址缺少主机名' };

  const port = url.port ? Number(url.port) : scheme === 'wss:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '端口号无效' };
  }

  const path = url.pathname.replace(/\/+$/, '');
  const authority = url.host;
  const base = scheme + '//' + authority + path;
  const httpScheme = scheme === 'wss:' ? 'https:' : 'http:';

  return {
    ok: true,
    url: base,
    base,
    wsBase: base,
    httpBase: httpScheme + '//' + authority + path,
    scheme,
    host: url.hostname,
    authority,
    path,
    port,
    explicitPort: Boolean(url.port),
  };
}

export function relayAddressLabel(relayUrl) {
  const norm = normalizeRelayBase(relayUrl);
  if (!norm.ok) return String(relayUrl == null ? '' : relayUrl);
  return norm.authority + norm.path;
}

export function buildRelayEndpoint(relayBase, path) {
  const norm = normalizeRelayBase(relayBase);
  if (!norm.ok) return { ok: false, error: norm.error };
  const suffix = String(path || '').startsWith('/') ? String(path) : '/' + String(path || '');
  return {
    ok: true,
    wsUrl: norm.wsBase + suffix,
    httpUrl: norm.httpBase + suffix,
    normalized: norm,
  };
}

export function buildHealthHttpUrl(relayBase) {
  return buildRelayEndpoint(relayBase, '/healthz').httpUrl || '';
}

export function buildServersHttpUrl(relayBase) {
  return buildRelayEndpoint(relayBase, '/api/servers').httpUrl || '';
}

export function buildStatsHttpUrl(relayBase) {
  return buildRelayEndpoint(relayBase, '/api/stats').httpUrl || '';
}

export function buildInfoHttpUrl(relayBase) {
  return buildRelayEndpoint(relayBase, '/api/info').httpUrl || '';
}

export function buildRtcOfferHttpUrl(relayBase) {
  return buildRelayEndpoint(relayBase, '/rtc/offer').httpUrl || '';
}

// <relayBase>/udp/<host>:<port>[?token=...]
export function buildUdpWsUrl(options = {}) {
  const norm = normalizeRelayBase(options.relayBase);
  if (!norm.ok) return { ok: false, error: norm.error };

  const host = typeof options.host === 'string' ? options.host.trim() : '';
  const port = Number(options.port);
  if (!host) return { ok: false, error: '缺少目标主机' };
  if (host.indexOf('/') >= 0 || host.indexOf('?') >= 0 || host.indexOf('#') >= 0 || /\s/.test(host)) {
    return { ok: false, error: '目标主机名包含非法字符' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '目标端口无效' };
  }

  const hostPort = host + ':' + port;
  let url = norm.wsBase + '/udp/' + hostPort;
  const query = [];
  const protocol = Number(options.protocol);
  if (protocol === 7) query.push('protocol=7');
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  if (token) query.push('token=' + encodeURIComponent(token));
  if (options.transport === 'webrtc') query.push('transport=webrtc');
  if (query.length) url += '?' + query.join('&');
  return { ok: true, url, hostPort, relay: norm };
}

// 启动契约：Module.arguments = ['connect <wsUrl>']（单个字符串）
export function buildConnectArgs(url) {
  return ['connect ' + String(url)];
}

export function buildConnectCommand(url) {
  return 'connect ' + String(url);
}

// 兼容 /?relay=<id|url>&target=<host:port>、/?relayUrl=<url>、/?connect=<wsUrl>、/?autostart=1
export function parseShareParams(input) {
  let params;
  if (input instanceof URLSearchParams) {
    params = input;
  } else if (typeof input === 'string') {
    const text = input.trim();
    if (!text) params = new URLSearchParams();
    else if (text.indexOf('?') >= 0) params = new URLSearchParams(text.slice(text.indexOf('?') + 1));
    else params = new URLSearchParams(text);
  } else {
    params = new URLSearchParams();
  }

  const relayParam = (params.get('relay') || '').trim();
  const relayUrl = (params.get('relayUrl') || params.get('relay-url') || '').trim();
  const target = (params.get('target') || '').trim();
  const connectUrl = (params.get('connect') || '').trim();
  const autostartRaw = (params.get('autostart') || '').trim().toLowerCase();
  const autostart = autostartRaw === '1' || autostartRaw === 'true' || autostartRaw === 'yes';
  return { relayParam, relayId: relayParam, relayUrl, target, connectUrl, autostart };
}

// 描述一条完整 ws(s)://<relay>/udp/<host>:<port> 连接地址（原样保留，不改写）
export function parseConnectUrl(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { ok: false, error: '连接地址为空' };
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    return { ok: false, error: '不是有效的 URL' };
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'ws:' && scheme !== 'wss:') {
    return { ok: false, error: '直连地址必须是 ws:// 或 wss://' };
  }
  const match = url.pathname.match(/\/udp\/([^/?#]+)/i);
  const target = match ? decodeURIComponent(match[1]) : '';
  const relayPath = match ? url.pathname.slice(0, match.index) : url.pathname.replace(/\/+$/, '');
  const authority = url.host;
  const relayBase = scheme + '//' + authority + relayPath;
  const httpScheme = scheme === 'wss:' ? 'https:' : 'http:';
  return {
    ok: true,
    url: text,
    scheme,
    host: url.hostname,
    port: url.port ? Number(url.port) : scheme === 'wss:' ? 443 : 80,
    target,
    relayBase,
    httpBase: httpScheme + '//' + authority + relayPath,
  };
}

export function buildShareQuery(options = {}) {
  const params = new URLSearchParams();
  const relayId = typeof options.relayId === 'string' ? options.relayId.trim() : '';
  const relayUrl = typeof options.relayUrl === 'string' ? options.relayUrl.trim() : '';
  const target = typeof options.target === 'string' ? options.target.trim() : '';
  const connectUrl = typeof options.connectUrl === 'string' ? options.connectUrl.trim() : '';
  if (connectUrl) params.set('connect', connectUrl);
  else if (relayId) params.set('relay', relayId);
  else if (relayUrl) params.set('relayUrl', relayUrl);
  if (target) params.set('target', target);
  if (options.autostart) params.set('autostart', '1');
  const query = params.toString();
  return query ? '?' + query : '';
}
