// DDNet 官方 master 服务器列表：拉取、归一化、筛选、排序、选项生成。
// 接口：https://masterN.ddnet.org/ddnet/15/servers.json
// 响应带 access-control-allow-origin: *，浏览器可直接 fetch。
// 纯函数部分不依赖 DOM / 网络，方便 Node 单测。

export const MASTER_URLS = Object.freeze([
  'https://master1.ddnet.org/ddnet/15/servers.json',
  'https://master2.ddnet.org/ddnet/15/servers.json',
  'https://master3.ddnet.org/ddnet/15/servers.json',
  'https://master4.ddnet.org/ddnet/15/servers.json',
]);

export const DEFAULT_MASTER_FILTERS = Object.freeze({
  type: '',
  region: '',
  protocol: '',
  sort: 'players',
  hideFull: false,
  hideLocked: false,
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function collapseName(value) {
  return text(value).replace(/\s+/g, ' ').trim();
}

export function regionLabel(region) {
  const raw = text(region);
  if (!raw) return '';
  return raw.toUpperCase().replace(/:/g, '-');
}

export function parseMasterAddress(raw) {
  let value = text(raw);
  if (!value) return null;
  let protocol = 6;
  const match = value.match(/^tw-(0\.6|0\.7)\+udp:\/\/(.+)$/i);
  if (match) {
    protocol = match[1] === '0.7' ? 7 : 6;
    value = match[2];
  }
  value = value.split(/[/?#]/)[0];
  let host = '';
  let port = 0;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return null;
    host = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (!rest.startsWith(':')) return null;
    port = Number(rest.slice(1));
  } else {
    const colon = value.lastIndexOf(':');
    if (colon <= 0) return null;
    host = value.slice(0, colon);
    port = Number(value.slice(colon + 1));
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, protocol };
}

// DDNet master 每个服务器通常给多个地址（0.6/0.7），优先选 0.6，其次第一个可用地址。
export function chooseMasterAddress(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  const parsed = list.map(parseMasterAddress).filter(Boolean);
  return parsed.find((entry) => entry.protocol === 6) || parsed[0] || null;
}

export function normalizeMasterServer(entry, index = 0) {
  if (!entry || typeof entry !== 'object') return null;
  const address = chooseMasterAddress(entry.addresses);
  if (!address) return null;
  const info = entry.info && typeof entry.info === 'object' ? entry.info : {};
  const map = info.map && typeof info.map === 'object' ? info.map : {};
  const clients = Array.isArray(info.clients) ? info.clients : [];
  const flaggedPlayers = clients.filter((client) => client && client.is_player !== false).length;
  const players = Number.isFinite(Number(info.num_players))
    ? Number(info.num_players)
    : (clients.length ? (flaggedPlayers || clients.length) : 0);
  const maxPlayers = Number.isFinite(Number(info.max_players))
    ? Number(info.max_players)
    : Number.isFinite(Number(info.max_clients)) ? Number(info.max_clients) : null;
  const hostPort = address.host + ':' + address.port;
  return {
    id: 'master-' + address.protocol + '-' + hostPort + '-' + index,
    name: collapseName(info.name) || hostPort,
    host: address.host,
    port: address.port,
    address: hostPort,
    target: hostPort,
    protocol: address.protocol,
    region: text(entry.location),
    community: text(entry.community),
    map: collapseName(map.name),
    gameType: collapseName(info.game_type),
    version: text(info.version),
    players,
    maxPlayers,
    passworded: info.passworded === true,
    source: 'master',
  };
}

export function parseMasterPayload(payload) {
  const servers = payload && Array.isArray(payload.servers) ? payload.servers : [];
  const out = [];
  servers.forEach((entry, index) => {
    const normalized = normalizeMasterServer(entry, index);
    if (normalized) out.push(normalized);
  });
  return out;
}

export function normalizeRelayServers(list) {
  return (Array.isArray(list) ? list : []).map((entry, index) => {
    if (!entry || typeof entry !== 'object') return null;
    const address = entry.address || (entry.host && entry.port ? entry.host + ':' + entry.port : '');
    if (!address) return null;
    const protocol = Number(entry.protocol) === 7 ? 7 : Number(entry.protocol) === 6 ? 6 : null;
    return {
      id: 'relay-' + (protocol || 'auto') + '-' + address + '-' + index,
      name: entry.name || address,
      host: entry.host || address.split(':')[0],
      port: entry.port || Number(address.split(':').pop()) || 0,
      address,
      target: address,
      protocol,
      region: text(entry.region),
      community: '',
      map: text(entry.map),
      gameType: text(entry.gameType || entry.note),
      version: text(entry.version),
      players: Number.isFinite(Number(entry.players)) ? Number(entry.players) : null,
      maxPlayers: Number.isFinite(Number(entry.maxPlayers)) ? Number(entry.maxPlayers) : null,
      passworded: entry.passworded === true,
      source: 'relay',
    };
  }).filter(Boolean);
}

export function filterServers(list, filters = {}, query = '') {
  const options = { ...DEFAULT_MASTER_FILTERS, ...(filters || {}) };
  const needle = text(query).toLowerCase();
  const protocol = Number(options.protocol) === 7 ? 7 : Number(options.protocol) === 6 ? 6 : 0;
  const type = text(options.type).toLowerCase();
  const region = text(options.region).toLowerCase();
  const result = (Array.isArray(list) ? list : []).filter((server) => {
    if (!server) return false;
    if (protocol && server.protocol !== protocol) return false;
    if (type && text(server.gameType).toLowerCase() !== type) return false;
    if (region && text(server.region).toLowerCase() !== region) return false;
    if (options.hideFull && Number.isFinite(server.players) && Number.isFinite(server.maxPlayers) && server.maxPlayers > 0 && server.players >= server.maxPlayers) return false;
    if (options.hideLocked && server.passworded) return false;
    if (!needle) return true;
    const haystack = [server.name, server.address, server.map, server.gameType, server.region, server.version, server.community]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.indexOf(needle) >= 0;
  });
  const sort = options.sort || 'players';
  if (sort === 'none') return result;
  result.sort((left, right) => {
    if (sort === 'name') return String(left.name).localeCompare(String(right.name), 'zh-Hans-CN');
    if (sort === 'region') {
      const byRegion = String(left.region).localeCompare(String(right.region));
      return byRegion !== 0 ? byRegion : String(left.name).localeCompare(String(right.name), 'zh-Hans-CN');
    }
    const leftPlayers = Number.isFinite(left.players) ? left.players : -1;
    const rightPlayers = Number.isFinite(right.players) ? right.players : -1;
    if (rightPlayers !== leftPlayers) return rightPlayers - leftPlayers;
    return String(left.name).localeCompare(String(right.name), 'zh-Hans-CN');
  });
  return result;
}

export function filterOptions(list) {
  const types = new Map();
  const regions = new Map();
  for (const server of Array.isArray(list) ? list : []) {
    if (!server) continue;
    const type = text(server.gameType);
    if (type) types.set(type, (types.get(type) || 0) + 1);
    const region = text(server.region);
    if (region) regions.set(region, (regions.get(region) || 0) + 1);
  }
  const toSorted = (map) => [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => ({ value, count, label: value }));
  return {
    types: toSorted(types),
    regions: toSorted(regions).map((entry) => ({ ...entry, label: regionLabel(entry.value) })),
  };
}

async function fetchJsonWithTimeout(url, fetchImpl, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
    if (!response || !response.ok) {
      return { ok: false, error: 'HTTP ' + (response ? response.status : '无响应') };
    }
    const data = await response.json();
    return { ok: true, data };
  } catch (error) {
    const message = (error && error.message) || String(error);
    return { ok: false, error: /abort/i.test(message) ? '请求超时' : message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 依次尝试 master1..4；返回扁平化后的所有服务器。
export async function fetchMasterServers(options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof fetchImpl !== 'function') {
    return { ok: false, servers: [], error: '当前环境不支持 fetch', tried: [] };
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const urls = Array.isArray(options.urls) && options.urls.length ? options.urls : MASTER_URLS;
  const tried = [];
  for (const url of urls) {
    const result = await fetchJsonWithTimeout(url, fetchImpl, timeoutMs);
    tried.push({ url, ok: result.ok, error: result.error || '' });
    if (!result.ok) continue;
    const servers = parseMasterPayload(result.data);
    if (servers.length === 0) continue;
    return { ok: true, servers, url, tried, count: servers.length };
  }
  return {
    ok: false,
    servers: [],
    error: tried.length ? '所有官方 master 均不可用：' + tried.map((entry) => entry.url.replace(/^https:\/\//, '') + ' ' + entry.error).join('；') : '没有可用的 master 地址',
    tried,
  };
}
