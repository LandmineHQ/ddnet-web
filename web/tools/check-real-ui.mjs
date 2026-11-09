// 真实后端 UI 检查：DOM 垫片 + 真实中继（不下载 62MB，仅验证列表/连接/服务器）
// 用法：node web/tools/check-real-ui.mjs [relayBase]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDomShim } from './dom-shim.mjs';
import { createMemoryStorage } from '../src/storage.js';
import { measureRelayLatency } from '../src/latency.js';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.dirname(TOOLS_DIR);
const relayBase = process.argv[2] || 'ws://127.0.0.1:8390';

const shim = createDomShim();
const storage = createMemoryStorage();
globalThis.document = shim.document;
globalThis.localStorage = storage;
globalThis.location = { search: '', hash: '', origin: 'http://127.0.0.1:8393', href: 'http://127.0.0.1:8393/', hostname: '127.0.0.1', pathname: '/', reload() {} };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true, writable: true });
const windowEvents = {};
globalThis.window = {
  document: shim.document,
  isSecureContext: true,
  crossOriginIsolated: true,
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener(type, handler) { (windowEvents[type] || (windowEvents[type] = [])).push(handler); },
  removeEventListener() {},
  dispatchEvent() { return true; },
  navigator: globalThis.navigator,
  location: globalThis.location,
  console, setTimeout, clearTimeout, setInterval, clearInterval,
};
globalThis.self = globalThis.window;

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, options = {}) => {
  const text = String(url);
  if (!/^https?:\/\//.test(text)) return new Response('relative asset skipped', { status: 404 });
  return realFetch(text, options);
};

const assets = {
  snapshot: () => ({ items: [], complete: true, totalBytes: 0, cacheAvailable: true, cacheName: 'real-ui', manifestWarning: '', lastError: '' }),
  init: async () => assets.snapshot(),
  isComplete: () => true,
  download: async () => ({ ok: true }),
  abort() {},
  objectUrl: async () => 'blob:x',
  assetUrls: async () => ({ 'DDNet.js': 'blob:js', 'DDNet.wasm': 'blob:wasm', 'DDNet.data': 'blob:data' }),
  clear: async () => assets.snapshot(),
  getItem: () => null,
  cacheAvailable: true,
  manifestWarning: '',
};

const app = await import('../app.js');
shim.loadIndexHtml(fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8'));
await app.bootstrap({
  assets,
  fetchImpl: globalThis.fetch,
  measureLatency: (relay, options) => measureRelayLatency(relay, Object.assign({ fetchImpl: globalThis.fetch, webrtc: false }, options || {})),
});

const debug = globalThis.__ddwebDebug;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const relay = debug.relayStore.list()[0];
console.log('后端卡片:', debug.entries().map((entry) => ({ name: entry.relay.name, url: entry.relay.url, status: entry.status })));
while (debug.state.measuring) await sleep(50);
await debug.measureAllLatency({ force: true });
while (debug.state.measuring) await sleep(50);
console.log('测速结果:', debug.entries().map((entry) => ({ name: entry.relay.name, latency: entry.latency, method: entry.method })));
await debug.selectRelay(relay);
await sleep(100);
console.log('视图:', debug.state.view, '服务器数量:', debug.state.servers.list.length);
console.log('服务器:', debug.state.servers.list.slice(0, 3).map((server) => server.target));
console.log('错误面板隐藏:', !!shim.document.getElementById('servers-error').hidden);
const ok = debug.state.view === 'servers' && debug.state.servers.list.some((server) => server.target === '127.0.0.1:8313');
console.log(ok ? 'RESULT OK' : 'RESULT FAIL');
process.exit(ok ? 0 : 1);
