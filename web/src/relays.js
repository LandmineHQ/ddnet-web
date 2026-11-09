// 中继（后端）条目模型 + localStorage 持久化 + 可选的 relays.json 发现

import { normalizeRelayBase, relayAddressLabel } from './relayurl.js';

export const STORAGE_KEYS = {
  relays: 'ddweb.relays.v2',
  hidden: 'ddweb.hidden-relays.v1',
  lastRelay: 'ddweb.last-relay.v1',
  nickname: 'ddweb.nickname.v1',
  tour: 'ddweb.tour.v1',
};

export const RELAYS_VERSION = 2;

const MAX_NAME = 64;
const MAX_TOKEN = 256;
const MAX_RELAYS = 100;

let idCounter = 0;

export function createRelayId() {
  const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : '';
  if (uuid) return 'relay-' + uuid.replace(/-/g, '').slice(0, 12);
  idCounter += 1;
  return 'relay-' + Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 6);
}

export function sanitizeRelay(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '中继条目必须是对象' };
  }
  const norm = normalizeRelayBase(typeof raw.url === 'string' ? raw.url : '');
  if (!norm.ok) return { ok: false, error: '中继地址无效：' + norm.error };

  const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
  const name = (rawName || relayAddressLabel(norm.base)).slice(0, MAX_NAME);
  const token = typeof raw.token === 'string' ? raw.token.trim().slice(0, MAX_TOKEN) : '';
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : createRelayId();
  const addedAt = Number.isFinite(raw.addedAt) ? Number(raw.addedAt) : Date.now();
  const source = typeof raw.source === 'string' && raw.source ? raw.source.slice(0, 24) : 'custom';
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : '';

  return {
    ok: true,
    relay: { id, name, url: norm.base, token, note, source, addedAt, ...(options.keepTimestamps ? {} : {}) },
  };
}

export function serializeRelays(relays) {
  return JSON.stringify({
    version: RELAYS_VERSION,
    relays: (relays || []).map((relay) => ({
      id: relay.id,
      name: relay.name,
      url: relay.url,
      token: relay.token,
      note: relay.note,
      source: relay.source,
      addedAt: relay.addedAt,
    })),
  });
}

export function parseRelaysText(text) {
  let data;
  try {
    data = JSON.parse(String(text == null ? '' : text));
  } catch (error) {
    return { ok: false, error: 'JSON 解析失败：' + ((error && error.message) || '格式错误') };
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.relays) ? data.relays : null;
  if (!list) return { ok: false, error: 'JSON 中未找到 relays 数组' };
  const relays = [];
  const warnings = [];
  const seen = new Set();
  list.forEach((item, index) => {
    const result = sanitizeRelay(item);
    if (!result.ok) {
      warnings.push('第 ' + (index + 1) + ' 条被跳过：' + result.error);
      return;
    }
    if (seen.has(result.relay.url)) {
      warnings.push('重复的中继地址已跳过：' + result.relay.url);
      return;
    }
    seen.add(result.relay.url);
    relays.push(result.relay);
  });
  return { ok: true, relays, warnings };
}

export class RelayStore {
  constructor(options = {}) {
    this.storage = options.storage || null;
    this.key = options.key || STORAGE_KEYS.relays;
    this.now = options.now || (() => Date.now());
    this.relays = [];
    this.loaded = false;
    this.loadError = '';
  }

  load() {
    this.relays = [];
    this.loaded = true;
    this.loadError = '';
    if (!this.storage) return this;
    let text = null;
    try {
      text = this.storage.getItem(this.key);
    } catch (error) {
      this.loadError = (error && error.message) || '无法读取 localStorage';
      return this;
    }
    if (!text) return this;
    const parsed = parseRelaysText(text);
    if (!parsed.ok) {
      this.loadError = parsed.error;
      return this;
    }
    this.relays = parsed.relays;
    return this;
  }

  save() {
    if (!this.storage) return { ok: false, error: '存储不可用' };
    try {
      this.storage.setItem(this.key, serializeRelays(this.relays));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error && error.message) || '写入失败' };
    }
  }

  list() {
    return this.relays.slice();
  }

  count() {
    return this.relays.length;
  }

  get(id) {
    return this.relays.find((relay) => relay.id === id) || null;
  }

  findByUrl(url) {
    const norm = normalizeRelayBase(url);
    if (!norm.ok) return null;
    return this.relays.find((relay) => relay.url === norm.base) || null;
  }

  add(input) {
    if (this.relays.length >= MAX_RELAYS) {
      return { ok: false, error: '最多保存 ' + MAX_RELAYS + ' 个后端' };
    }
    const result = sanitizeRelay(input);
    if (!result.ok) return result;
    if (this.findByUrl(result.relay.url)) {
      return { ok: false, error: '该后端地址已存在：' + result.relay.url };
    }
    const relay = Object.assign({}, result.relay, { addedAt: this.now() });
    this.relays.push(relay);
    this.save();
    return { ok: true, relay };
  }

  update(id, patch) {
    const index = this.relays.findIndex((relay) => relay.id === id);
    if (index < 0) return { ok: false, error: '后端不存在' };
    const current = this.relays[index];
    const result = sanitizeRelay(Object.assign({}, current, patch || {}, { id: current.id, addedAt: current.addedAt }));
    if (!result.ok) return result;
    const duplicate = this.relays.find((relay, i) => i !== index && relay.url === result.relay.url);
    if (duplicate) return { ok: false, error: '该后端地址已存在：' + result.relay.url };
    this.relays[index] = Object.assign({}, result.relay, { id: current.id, addedAt: current.addedAt });
    this.save();
    return { ok: true, relay: this.relays[index] };
  }

  remove(id) {
    const index = this.relays.findIndex((relay) => relay.id === id);
    if (index < 0) return { ok: false, error: '后端不存在' };
    const removed = this.relays.splice(index, 1)[0];
    this.save();
    return { ok: true, relay: removed };
  }

  clear() {
    this.relays = [];
    this.save();
  }
}

export function saveLastRelayId(storage, id, key = STORAGE_KEYS.lastRelay) {
  if (!storage) return;
  try {
    if (id) storage.setItem(key, id);
    else storage.removeItem(key);
  } catch (error) {
    // 忽略
  }
}

export function loadLastRelayId(storage, key = STORAGE_KEYS.lastRelay) {
  if (!storage) return '';
  try {
    return storage.getItem(key) || '';
  } catch (error) {
    return '';
  }
}

export function saveNickname(storage, nickname, key = STORAGE_KEYS.nickname) {
  if (!storage) return;
  try {
    storage.setItem(key, String(nickname || '').slice(0, 32));
  } catch (error) {
    // 忽略
  }
}

export function loadNickname(storage, key = STORAGE_KEYS.nickname) {
  if (!storage) return '';
  try {
    return storage.getItem(key) || '';
  } catch (error) {
    return '';
  }
}

// 被用户删除的内置/默认后端地址：下次启动时不再自动加回
export function loadHiddenRelayUrls(storage, key = STORAGE_KEYS.hidden) {
  if (!storage) return [];
  try {
    const text = storage.getItem(key);
    if (!text) return [];
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data && Array.isArray(data.urls) ? data.urls : [];
    const seen = new Set();
    const urls = [];
    for (const value of list) {
      const norm = normalizeRelayBase(typeof value === 'string' ? value : '');
      if (!norm.ok || seen.has(norm.base)) continue;
      seen.add(norm.base);
      urls.push(norm.base);
    }
    return urls;
  } catch (error) {
    return [];
  }
}

export function saveHiddenRelayUrls(storage, urls, key = STORAGE_KEYS.hidden) {
  const seen = new Set();
  const normalized = [];
  for (const value of urls || []) {
    const norm = normalizeRelayBase(typeof value === 'string' ? value : '');
    if (!norm.ok || seen.has(norm.base)) continue;
    seen.add(norm.base);
    normalized.push(norm.base);
  }
  try {
    if (storage) storage.setItem(key, JSON.stringify({ version: 1, urls: normalized }));
  } catch (error) {
    // 忽略写入失败
  }
  return normalized;
}

export function hideRelayUrl(storage, url, key = STORAGE_KEYS.hidden) {
  const list = loadHiddenRelayUrls(storage, key);
  const norm = normalizeRelayBase(url);
  if (norm.ok && list.indexOf(norm.base) < 0) list.push(norm.base);
  return saveHiddenRelayUrls(storage, list, key);
}

export function unhideRelayUrl(storage, url, key = STORAGE_KEYS.hidden) {
  const norm = normalizeRelayBase(url);
  const list = loadHiddenRelayUrls(storage, key).filter((item) => !norm.ok || item !== norm.base);
  return saveHiddenRelayUrls(storage, list, key);
}

export function clearHiddenRelayUrls(storage, key = STORAGE_KEYS.hidden) {
  return saveHiddenRelayUrls(storage, [], key);
}

// 本地开发环境默认提供一个可用的中继，方便首次打开就能体验
export function defaultRelaySeeds(win = globalThis) {
  const location = win && win.location;
  const hostname = location && location.hostname ? location.hostname : '';
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return [{ name: '本地中继', url: 'ws://127.0.0.1:8390', source: 'seed' }];
  }
  return [];
}

// 可选：站点根目录的 relays.json 用于下发推荐后端列表
export async function loadDiscovery(fetchImpl, url = 'relays.json') {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, relays: [], error: 'fetch 不可用' };
  }
  try {
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response.ok) {
      return { ok: false, relays: [], error: 'HTTP ' + response.status };
    }
    const data = await response.json();
    const list = Array.isArray(data) ? data : data && Array.isArray(data.relays) ? data.relays : [];
    const relays = [];
    const seen = new Set();
    for (const item of list) {
      const result = sanitizeRelay(Object.assign({ source: 'discovered' }, item));
      if (!result.ok || seen.has(result.relay.url)) continue;
      seen.add(result.relay.url);
      relays.push(result.relay);
    }
    return { ok: true, relays, error: '' };
  } catch (error) {
    return { ok: false, relays: [], error: (error && error.message) || '读取失败' };
  }
}

// ---------------------------------------------------------------- relay master

// Master node list endpoint. Production defaults to the public master domain.
// Local development uses the local master; LAN HTTPS dev uses the same-origin
// proxy. All defaults can be overridden at runtime via
// <meta name="relay-master-base">, window.DDWEB_MASTER_BASE, ?masterBase=<base>
// or ?master=<full endpoint>.
export function defaultRelayMasterUrl(win = globalThis) {
  const location = (win && win.location) || {};
  let params = null;
  try {
    params = new URLSearchParams(location.search || '');
  } catch (error) {
    params = null;
  }
  const override = params ? params.get('master') : '';
  if (override) return normalizeMasterUrl(override);
  const baseOverride = params ? params.get('masterBase') : '';
  if (baseOverride) return joinMasterBase(baseOverride);
  let configured = '';
  try {
    configured = win && win.DDWEB_MASTER_BASE ? String(win.DDWEB_MASTER_BASE) : '';
  } catch (error) {
    configured = '';
  }
  if (!configured && win && win.document && typeof win.document.querySelector === 'function') {
    const meta = win.document.querySelector('meta[name="relay-master-base"]');
    if (meta && meta.content) configured = meta.content;
  }
  if (configured) return joinMasterBase(configured);
  return joinMasterBase(defaultMasterBase(location));
}

function defaultMasterBase(location) {
  const hostname = location && location.hostname ? location.hostname : '';
  const port = location && location.port ? String(location.port) : '';
  // dev-https / LAN HTTPS: same-origin nginx proxy.
  if (port === '8443') return '/relay-master';
  // local HTTP dev: local relay master container.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return 'http://127.0.0.1:8391';
  }
  // production / GitHub Pages / custom domains.
  return 'https://master.landmine.top';
}

function joinMasterBase(base) {
  let value = String(base == null ? '' : base).trim();
  if (!value) value = 'https://master.landmine.top';
  if (/\/v1\/serverlist\/?$/.test(value)) return value.replace(/\/$/, '');
  return value.replace(/\/+$/, '') + '/v1/serverlist';
}

export function normalizeMasterUrl(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value) return '/relay-master/v1/serverlist';
  if (/^(\.{0,2}\/|\/)/.test(value)) return joinMasterBase(value);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'https://' + value;
  const parsed = new URL(value);
  let path = parsed.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/v1/serverlist')) path += '/v1/serverlist';
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

// Fetch the active relay nodes from the master. The master only lists relays
// that have passed its WebSocket verification and 15-minute liveness checks.
export async function loadMasterRelays(fetchImpl, url = defaultRelayMasterUrl()) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, relays: [], error: 'fetch 不可用', url };
  }
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? { signal: AbortSignal.timeout(4000) }
        : {}),
    });
    if (!response.ok) {
      return { ok: false, relays: [], error: 'HTTP ' + response.status, url };
    }
    const data = await response.json();
    const list = Array.isArray(data) ? data : data && Array.isArray(data.servers) ? data.servers : [];
    const relays = [];
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const noteParts = ['Master 注册节点'];
      if (item.region) noteParts.push(item.region);
      if (item.version) noteParts.push('v' + item.version);
      const result = sanitizeRelay({
        source: 'master',
        name: item.name,
        url: item.url,
        note: noteParts.join(' · '),
      });
      if (!result.ok || seen.has(result.relay.url)) continue;
      seen.add(result.relay.url);
      relays.push(result.relay);
    }
    return { ok: true, relays, error: '', url, count: relays.length };
  } catch (error) {
    return { ok: false, relays: [], error: (error && error.message) || '读取失败', url };
  }
}
