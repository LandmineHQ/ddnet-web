// DOM 冒烟测试：五屏流程（下载缓存 → 后端排序 → 载入 → 服务器 → 游戏/HUD/聚光灯）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDomShim } from './dom-shim.mjs';
import { createMemoryStorage } from '../src/storage.js';
import { sha256Hex } from '../src/assets.js';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.dirname(TOOLS_DIR);
const FILES = ['DDNet.js', 'DDNet.wasm', 'DDNet.data'];

const shim = createDomShim();
const storage = createMemoryStorage();
globalThis.document = shim.document;
globalThis.localStorage = storage;
globalThis.location = {
  search: '',
  hash: '',
  origin: 'http://example.test',
  href: 'http://example.test/',
  hostname: '127.0.0.1',
  pathname: '/',
  reload() {},
};
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true, writable: true });
const windowEvents = {};
globalThis.window = {
  document: shim.document,
  isSecureContext: true,
  crossOriginIsolated: true,
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener(type, handler) {
    if (!windowEvents[type]) windowEvents[type] = [];
    windowEvents[type].push(handler);
  },
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
  navigator: globalThis.navigator,
  location: globalThis.location,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.self = globalThis.window;

// ---------------------------------------------------------------- 假资源 / 假后端

const contents = {};
const hashes = {};
for (const name of FILES) {
  const bytes = new TextEncoder().encode('payload-' + name);
  contents[name] = bytes;
  hashes[name] = await sha256Hex(bytes, globalThis.crypto);
}
const manifest = {
  version: 'dom-test',
  files: Object.fromEntries(FILES.map((name) => [name, { sha256: hashes[name], size: contents[name].byteLength }])),
};
const SERVERS = Array.from({ length: 10 }, (_, index) => ({
  name: '服务器 ' + (index + 1),
  host: '10.0.0.' + (index + 1),
  port: 8303,
  region: index % 2 === 0 ? 'CN' : 'EU',
  players: index,
}));
const fetchLog = [];
globalThis.fetch = async (url, options = {}) => {
  const text = String(url);
  const pathname = new URL(text, 'http://example.test/').pathname;
  fetchLog.push({ url: text, pathname, method: options.method || 'GET' });
  if (pathname === '/manifest.json') {
    return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (pathname === '/relays.json') {
    return new Response(JSON.stringify({ relays: [{ name: '远端推荐', url: 'wss://discovered.example.com' }] }), { status: 200 });
  }
  const bare = pathname.replace(/^\//, '');
  if (contents[bare]) {
    const bytes = contents[bare];
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }), { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }
  if (pathname.endsWith('/api/info')) {
    const host = new URL(text).hostname;
    return new Response(JSON.stringify({ name: '后端 ' + host, region: 'TEST', players: 2 }), { status: 200 });
  }
  if (pathname.endsWith('/api/servers')) {
    if (text.indexOf('fail.example.com') >= 0) {
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    }
    return new Response(JSON.stringify({ servers: SERVERS }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

function createMemoryCaches() {
  const caches = new Map();
  function makeCache() {
    const store = new Map();
    return {
      async match(url) {
        return store.get(String(url)) || null;
      },
      async put(url, response) {
        store.set(String(url), response);
      },
      async delete(url) {
        return store.delete(String(url));
      },
      _store: store,
    };
  }
  return {
    async open(name) {
      if (!caches.has(name)) caches.set(name, makeCache(name));
      return caches.get(name);
    },
    async keys() {
      return Array.from(caches.keys());
    },
    async delete(name) {
      return caches.delete(name);
    },
    _caches: caches,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (id) => shim.document.getElementById(id);
const click = (node) => node.listeners.click[0]({ type: 'click', target: node, preventDefault() {}, stopPropagation() {} });
const input = (node, value) => {
  node.value = value;
  node.listeners.input[0]({ type: 'input', target: node });
};
const submit = (node) => node.dispatchEvent({ type: 'submit' });

const { createAssetManager } = await import('../src/assets.js');
const app = await import('../app.js');
shim.loadIndexHtml(fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8'));

const latencyByHost = {
  'relay-fast.example.com': 12,
  'relay-mid.example.com': 55,
  'relay-slow.example.com': 130,
};
const latencyCalls = [];
async function measureLatency(relay) {
  latencyCalls.push(relay.url);
  for (const host of Object.keys(latencyByHost)) {
    if (relay.url.indexOf(host) >= 0) {
      return { ok: true, method: 'webrtc', latencyMs: latencyByHost[host], detail: '模拟 WebRTC' };
    }
  }
  if (relay.url.indexOf('fail.example.com') >= 0) {
    return { ok: false, method: 'none', error: '连接失败' };
  }
  return { ok: true, method: 'http', latencyMs: 40, detail: '模拟 HTTP' };
}

const launchCalls = [];
const launchSession = async (options) => {
  launchCalls.push({
    relayUrl: options.relay && options.relay.url,
    target: options.target && options.target.target,
    connectUrl: options.connectUrl,
    protocol: options.protocol,
    touchControls: options.touchControls,
    backButton: options.backButton,
    assetKeys: Object.keys(options.assetUrls || {}).sort(),
  });
  options.onEvent({ type: 'call-main', payload: { url: options.connectUrl || '' } });
  return { url: options.connectUrl || '' };
};

const assets = createAssetManager({
  baseUrl: 'http://example.test/',
  fetchImpl: globalThis.fetch,
  cacheStorage: createMemoryCaches(),
  cryptoImpl: globalThis.crypto,
  createObjectURL: (blob) => 'blob:mock-' + blob.type,
  progressIntervalMs: 0,
});

await app.bootstrap({
  assets,
  fetchImpl: globalThis.fetch,
  measureLatency,
  launchSession,
});
const debug = globalThis.__ddwebDebug;

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
    const detail = String((error && error.stack) || error).split('\n').slice(0, 10).join('\n');
    console.log('     ' + detail.split('\n').join('\n     '));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function addRelay(url, name) {
  const result = debug.relayStore.add({ url, name });
  assert.equal(result.ok, true, JSON.stringify(result));
  await debug.measureAllLatency({ force: true });
  while (debug.state.measuring) await sleep(20);
  return result.relay;
}

function relayCards() {
  return get('relay-grid').childNodes.filter((node) => node.className && node.className.indexOf('relay-card') >= 0 && node.className.indexOf('is-custom') < 0);
}

// ---------------------------------------------------------------- 场景

await test('首次打开：显示下载提示（两个大文件 + 体积）', () => {
  assert.equal(get('download-modal').hidden, false);
  assert.equal(get('railroad') === null, true);
  assert.equal(get('download-files').childNodes.length, 2);
  const text = get('download-files').textContent;
  assert.match(text, /DDNet\.wasm/);
  assert.match(text, /DDNet\.data/);
  assert.match(text, /B$/);
  assert.equal(debug.state.view, 'relays');
  assert.equal(get('view-relays').hidden, false);
  assert.equal(debug.assets.isComplete(), false);
});

await test('主题：默认亮色、切换深色并持久化', () => {
  const root = shim.documentElement;
  assert.equal(root.getAttribute('data-theme'), 'light', '首次访问默认亮色');
  assert.equal(storage.getItem('ddweb.theme.v1'), null);
  click(get('btn-theme'));
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(storage.getItem('ddweb.theme.v1'), 'dark');
  assert.equal(get('theme-label').textContent, '亮色');
  assert.equal(get('btn-theme').getAttribute('aria-pressed'), 'true');
  assert.equal(debug.state.theme, 'dark');
  click(get('btn-theme'));
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(storage.getItem('ddweb.theme.v1'), 'light');
  assert.equal(get('theme-label').textContent, '深色');
  assert.equal(debug.state.theme, 'light');
});

await test('延迟测速：按升序排列、徽章配色', async () => {
  await addRelay('wss://relay-slow.example.com', '慢');
  await addRelay('wss://relay-fast.example.com', '快');
  await addRelay('wss://relay-mid.example.com', '中');
  const entries = debug.entries().filter((entry) => entry.status === 'ok');
  const sorted = debug.ranking(entries);
  assert.equal(sorted[0].relay.name, '快');
  const latencies = sorted.map((entry) => entry.latency);
  assert.deepEqual(latencies, latencies.slice().sort((a, b) => a - b), '延迟必须升序');
  assert.ok(sorted.findIndex((entry) => entry.relay.name === '慢') > sorted.findIndex((entry) => entry.relay.name === '中'));
  const cards = relayCards();
  assert.ok(cards.length >= 4);
  const firstCard = cards[0];
  assert.match(firstCard.textContent, /快/);
  assert.match(firstCard.textContent, /12 ms/);
  const badge = firstCard.querySelector('.latency-badge');
  assert.ok(badge && badge.className.indexOf('is-fast') >= 0, badge && badge.className);
  const summary = get('relay-summary').textContent;
  assert.match(summary, /最快/);
  assert.match(summary, /WebRTC/);
});

await test('自定义后端卡片：对话框新增并持久化', async () => {
  const cards = get('relay-grid').childNodes;
  const custom = cards[cards.length - 1];
  assert.ok(custom.className.indexOf('is-custom') >= 0);
  click(custom);
  assert.equal(get('relay-dialog').open, true);
  get('relay-url').value = 'wss://custom.example.com';
  get('relay-name').value = '我的后端';
  get('relay-token').value = 'secret';
  submit(get('relay-form'));
  const saved = debug.relayStore.findByUrl('wss://custom.example.com');
  assert.ok(saved);
  assert.equal(saved.name, '我的后端');
  assert.equal(saved.token, 'secret');
  assert.equal(get('relay-dialog').open, false);
  assert.ok(relayCards().some((card) => card.textContent.indexOf('我的后端') >= 0));
  const persisted = JSON.parse(storage.getItem('ddweb.relays.v2'));
  assert.ok(persisted.relays.some((relay) => relay.url === 'wss://custom.example.com'));
});

await test('自定义后端：编辑预填、保存重测速、删除二次确认、内置可删、远端只读', async () => {
  const custom = debug.relayStore.findByUrl('wss://custom.example.com');
  assert.ok(custom);
  const card = get('relay-grid').querySelector('[data-relay-id="' + custom.id + '"]');
  assert.ok(card, '应能按 data-relay-id 找到卡片');
  assert.equal(card.querySelectorAll('.relay-action').length, 2, '自定义后端有编辑与删除');

  click(card.querySelector('.relay-action[data-action="edit"]'));
  assert.equal(get('relay-dialog').open, true);
  assert.equal(get('relay-url').value, 'wss://custom.example.com');
  assert.equal(get('relay-name').value, '我的后端');
  assert.equal(get('relay-token').value, 'secret');
  const beforeMeasure = latencyCalls.length;
  get('relay-name').value = '改名后端';
  submit(get('relay-form'));
  const updated = debug.relayStore.get(custom.id);
  assert.equal(updated.name, '改名后端');
  assert.ok(latencyCalls.length > beforeMeasure, '编辑保存后应重新测速');
  assert.ok(get('relay-grid').textContent.indexOf('改名后端') >= 0);

  const afterEdit = get('relay-grid').querySelector('[data-relay-id="' + custom.id + '"]');
  click(afterEdit.querySelector('.relay-action[data-action="delete"]'));
  assert.equal(get('confirm-dialog').open, true);
  assert.match(get('confirm-text').textContent, /改名后端/);
  click(get('btn-confirm-cancel'));
  assert.ok(debug.relayStore.get(custom.id), '取消删除后仍存在');

  const again = get('relay-grid').querySelector('[data-relay-id="' + custom.id + '"]');
  click(again.querySelector('.relay-action[data-action="delete"]'));
  click(get('btn-confirm-ok'));
  await sleep(10);
  assert.equal(debug.relayStore.get(custom.id), null);
  assert.equal(get('relay-grid').querySelector('[data-relay-id="' + custom.id + '"]'), null);
  const persisted = JSON.parse(storage.getItem('ddweb.relays.v2'));
  assert.ok(!persisted.relays.some((relay) => relay.url === 'wss://custom.example.com'));

  const seed = debug.relayStore.list().find((relay) => relay.source === 'seed');
  const seedCard = get('relay-grid').querySelector('[data-relay-id="' + seed.id + '"]');
  assert.ok(seedCard, '应存在内置后端卡片');
  assert.ok(seedCard.querySelector('.relay-action[data-action="edit"]'), '本地内置后端可编辑');
  assert.ok(seedCard.querySelector('.relay-action[data-action="delete"]'), '本地内置后端允许删除');

  const discovered = debug.relayStore.list().find((relay) => relay.source === 'discovered');
  assert.ok(discovered, 'relays.json 的推荐后端应被加入');
  const discoveredCard = get('relay-grid').querySelector('[data-relay-id="' + discovered.id + '"]');
  assert.ok(discoveredCard.querySelector('.relay-action[data-action="edit"]'), '远端推荐后端可编辑');
  assert.equal(discoveredCard.querySelector('.relay-action[data-action="delete"]'), null, '远端推荐后端只读');
});

await test('删除本地内置后端：隐藏列表防止重新加回，恢复默认可找回', async () => {
  const seed = debug.relayStore.list().find((relay) => relay.source === 'seed');
  const seedUrl = seed.url;
  const seedCard = get('relay-grid').querySelector('[data-relay-id="' + seed.id + '"]');
  click(seedCard.querySelector('.relay-action[data-action="delete"]'));
  click(get('btn-confirm-ok'));
  await sleep(10);
  assert.equal(debug.relayStore.findByUrl(seedUrl), null, '删除后应从列表移除');
  assert.ok(debug.hiddenRelays().indexOf(seedUrl) >= 0, '删除内置后端应写入隐藏列表');
  assert.ok(JSON.parse(storage.getItem('ddweb.hidden-relays.v1')).urls.indexOf(seedUrl) >= 0, '隐藏列表应持久化');

  await debug.ensureRelays();
  debug.renderAll();
  assert.equal(debug.relayStore.findByUrl(seedUrl), null, '重新执行种子逻辑不应加回已删除的内置后端');
  assert.equal(get('btn-restore-relays').hidden, false, '存在隐藏后端时显示恢复默认按钮');

  click(get('btn-restore-relays'));
  await sleep(10);
  assert.ok(debug.relayStore.findByUrl(seedUrl), '恢复默认应把内置后端加回');
  assert.deepEqual(debug.hiddenRelays(), []);
  assert.equal(get('btn-restore-relays').hidden, true);
  assert.ok(get('relay-grid').querySelector('[data-relay-id="' + debug.relayStore.findByUrl(seedUrl).id + '"]'));
});

await test('确认下载：悬浮组件显示两个进度条，完成后缓存', async () => {
  click(get('btn-download-start'));
  assert.equal(get('download-modal').hidden, true);
  assert.equal(get('download-widget').hidden, false);
  assert.equal(get('widget-progress').childNodes.length, 2);
  const result = await debug.state.download.promise;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(debug.assets.isComplete(), true);
  assert.equal(get('widget-overall').textContent, '100%');
  assert.match(get('cache-badge').textContent, /已缓存/);
  assert.match(get('status-pills').textContent, /资源缓存/);
});

await test('选择后端 → 服务器列表（分页 / 搜索 / 协议切换）', async () => {
  const relay = debug.relayStore.findByUrl('wss://relay-fast.example.com');
  await debug.selectRelay(relay);
  assert.equal(debug.state.view, 'servers');
  assert.equal(get('view-servers').hidden, false);
  assert.equal(get('servers-title').textContent, '快', '自定义名称优先于 /api/info');
  assert.match(get('servers-subtitle').textContent, /协议 0\.6/);
  assert.equal(get('servers-error').hidden, true);
  assert.equal(get('server-list').childNodes.length, 10);
  assert.equal(get('server-pager').hidden, true);

  input(get('server-search'), '服务器 1');
  assert.equal(get('server-list').childNodes.length, 2);
  input(get('server-search'), '');
  assert.equal(get('server-list').childNodes.length, 10);
  assert.match(get('servers-count').textContent, /筛选后 10 \/ 10 台/);

  click(get('btn-protocol-7'));
  assert.equal(debug.state.protocol, 7);
  assert.equal(storage.getItem('ddweb.protocol.v1'), '7');
  assert.match(get('servers-subtitle').textContent, /协议 0\.7/);
  assert.equal(get('btn-protocol-7').getAttribute('aria-pressed'), 'true');
  click(get('btn-protocol-6'));
  assert.equal(debug.state.protocol, 6);
});

await test('后端连接失败：错误面板可复制 / 重试', async () => {
  const relay = await addRelay('wss://fail.example.com', '坏后端');
  const before = fetchLog.filter((entry) => entry.pathname.endsWith('/api/servers')).length;
  await debug.selectRelay(relay);
  assert.equal(debug.state.view, 'servers');
  assert.equal(get('servers-error').hidden, false);
  assert.equal(get('servers-content').hidden, true);
  const text = get('servers-error-text').textContent;
  assert.match(text, /fail\.example\.com/);
  assert.match(text, /HTTP 状态：500/);
  assert.match(text, /可能原因/);
  click(get('btn-error-copy'));
  await sleep(10);
  assert.match(get('toast-host').textContent, /已复制/);
  const afterFirst = fetchLog.filter((entry) => entry.pathname.endsWith('/api/servers')).length;
  assert.ok(afterFirst > before);
  click(get('btn-error-retry'));
  await sleep(120);
  assert.ok(fetchLog.filter((entry) => entry.pathname.endsWith('/api/servers')).length > afterFirst);
});

await test('进入游戏：启动参数、HUD、聚光灯、Ctrl+`', async () => {
  const relay = debug.relayStore.findByUrl('wss://relay-fast.example.com');
  await debug.selectRelay(relay);
  assert.equal(debug.state.view, 'servers');
  click(get('btn-protocol-7'));
  assert.match(get('servers-subtitle').textContent, /协议 0\.7/);
  const card = get('server-list').childNodes[0];
  click(card);
  await sleep(750);
  const call = launchCalls[launchCalls.length - 1];
  assert.ok(call);
  assert.equal(call.relayUrl, 'wss://relay-fast.example.com');
  assert.equal(call.target, '10.0.0.1:8303');
  assert.deepEqual(call.assetKeys, ['DDNet.data', 'DDNet.js', 'DDNet.wasm']);
  assert.equal(debug.state.view, 'game');
  assert.equal(get('canvas').style.display, 'block');
  assert.equal(get('hud-panel').hidden, false);
  assert.equal(get('spotlight').hidden, false);
  assert.match(get('spotlight-title').textContent, /后端连接信息/);
  assert.equal(get('hud-target').textContent.indexOf('10.0.0.1:8303') >= 0, true);
  assert.equal(get('hud-protocol').textContent, '0.7');
  assert.match(debug.state.lastConnectUrl, /\?protocol=7$/, '选择 0.7 后连接 URL 必须带 protocol=7');
  assert.equal(debug.state.lastConnectProtocol, 7);
  assert.equal(call.protocol, 7, '启动会话必须收到 protocol=7');
  assert.ok(debug.state.lastConnectUrl.indexOf('wss://relay-fast.example.com/udp/10.0.0.1:8303') === 0, '列表点击必须组装成当前中继的 /udp/ URL');
  assert.deepEqual(debug.state.lastLaunchArgs, ['cl_touch_controls 0', 'cl_back_button 0', 'connect ' + debug.state.lastConnectUrl], '桌面端显式关闭触屏控件，connect 仍是最后一条');
  assert.notEqual(call.touchControls, true, '桌面端不注入触屏命令');
  assert.notEqual(call.backButton, true);

  click(get('btn-spotlight-next'));
  assert.equal(get('spotlight').hidden, true);
  assert.equal(storage.getItem('ddweb.tour.v1'), 'done');

  shim.document.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'Backquote', key: '`', preventDefault() {}, stopPropagation() {} });
  assert.equal(get('hud-panel').hidden, true);
  shim.document.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'Backquote', key: '`', preventDefault() {}, stopPropagation() {} });
  assert.equal(get('hud-panel').hidden, false);
  // 旧的 Esc 组合不再触发 HUD
  shim.document.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'Escape', key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(get('hud-panel').hidden, false, '旧的 Esc 组合不应再切换 HUD');

  // 全局快捷键：输入框内也生效；只在匹配时 preventDefault
  let prevented = 0;
  shim.document.dispatchEvent({
    type: 'keydown',
    target: get('server-search'),
    ctrlKey: true,
    code: 'Backquote',
    key: '`',
    preventDefault() { prevented += 1; },
    stopPropagation() {},
  });
  assert.equal(prevented, 1, '匹配 Ctrl+` 时必须 preventDefault（输入框内同样生效）');
  let unmatchedPrevented = 0;
  shim.document.dispatchEvent({
    type: 'keydown',
    ctrlKey: false,
    code: 'Backquote',
    key: '`',
    preventDefault() { unmatchedPrevented += 1; },
    stopPropagation() {},
  });
  assert.equal(unmatchedPrevented, 0, '未匹配的按键不应 preventDefault');
});

await test('直连地址：?connect 原样传给客户端', async () => {
  const directUrl = 'ws://127.0.0.1:8390/udp/127.0.0.1:8313?protocol=7';
  await debug.startDirectSession(directUrl);
  const call = launchCalls[launchCalls.length - 1];
  assert.equal(call.connectUrl, directUrl);
  assert.equal(call.assetKeys.length, 3);
  assert.equal(debug.state.view, 'game');
  assert.equal(get('hud-protocol').textContent, '直连');
});

await test('载入页在资源未缓存时出现且可关闭', async () => {
  debug.state.download.promise = null;
  debug.state.download.started = false;
  debug.state.download.hideScheduled = false;
  await debug.assets.clear();
  debug.state.view = 'servers';
  const relay = debug.relayStore.findByUrl('wss://relay-fast.example.com');
  const pending = debug.selectRelay(relay);
  assert.equal(get('loading-view').hidden, false);
  assert.equal(get('loading-progress').childNodes.length, 2);
  assert.match(get('loading-title').textContent, /准备客户端资源/);
  click(get('btn-loading-close'));
  assert.equal(get('loading-view').hidden, true);
  assert.equal(debug.state.view, 'relays');
  await debug.state.download.promise;
  await pending;
  assert.equal(debug.state.view, 'relays', '关闭载入页后不应自动进入服务器列表');
  assert.equal(debug.assets.isComplete(), true);
});

await test('advanced 设置：昵称持久化 + 缓存信息', async () => {
  click(get('btn-advanced'));
  assert.equal(get('advanced-dialog').open, true);
  input(get('nickname-input'), '测试玩家');
  assert.equal(storage.getItem('ddweb.nickname.v1'), '测试玩家');
  assert.match(get('cache-info').textContent, /DDNet\.wasm/);
  assert.match(get('cache-info').textContent, /Cache Storage/);
  click(get('btn-advanced-close'));
  assert.equal(get('advanced-dialog').open, false);
});

await test('空状态：0 个后端时给出提示、添加入口与恢复默认', async () => {
  const debug = globalThis.__ddwebDebug;
  for (const relay of debug.relayStore.list()) debug.relayStore.remove(relay.id);
  debug.renderAll();
  const empty = get('relay-grid').querySelector('#relay-empty');
  assert.ok(empty, '应显示空状态卡片');
  assert.match(empty.textContent, /还没有可用的后端/);
  const addButton = empty.querySelector('#btn-empty-add');
  assert.ok(addButton, '空状态应提供添加自定义后端入口');
  click(addButton);
  assert.equal(get('relay-dialog').open, true);
  click(get('btn-relay-cancel'));
  assert.equal(get('relay-dialog').open, false);

  const restoreButton = empty.querySelector('#btn-empty-restore');
  assert.ok(restoreButton, '有隐藏记录时空状态应提供恢复默认');
  click(restoreButton);
  await sleep(10);
  assert.ok(debug.relayStore.list().length > 0, '恢复默认后应至少有一个后端');
  assert.equal(get('relay-grid').querySelector('#relay-empty'), null);
  assert.equal(get('btn-restore-relays').hidden, true);
});

await test('回归：服务器列表点击始终组装当前中继的 /udp/ URL', async () => {
  const debug = globalThis.__ddwebDebug;
  const relay = debug.relayStore.list()[0];
  assert.ok(relay, '需要至少一个后端');
  debug.setProtocol(6);
  await debug.selectRelay(relay);
  assert.equal(debug.state.view, 'servers');

  // 1) 普通 server-card（host:port）
  click(get('server-list').childNodes[0]);
  await sleep(60);
  const fromCard = debug.state.lastConnectUrl;
  assert.ok(fromCard.indexOf(relay.url + '/udp/') === 0, '必须使用当前中继：' + fromCard);
  assert.match(fromCard, /\/udp\/10\.0\.0\.1:8303/);
  assert.ok(fromCard.indexOf('10.0.0.1:8303') >= 0);

  // 2) /api/servers 的 target 是完整 ws URL 时，仍改写为当前中继（不直连别的地址）
  debug.state.servers.list = [{
    name: '外链服务器',
    host: '10.0.0.9',
    port: 8303,
    target: 'wss://other-relay.example.com/udp/10.0.0.9:8303',
  }];
  debug.setView('servers');
  debug.renderAll();
  click(get('server-list').childNodes[0]);
  await sleep(60);
  assert.equal(debug.state.lastConnectUrl, relay.url + '/udp/10.0.0.9:8303');

  // 3) 手动输入 host:port 同样走中继
  await debug.enterGame(relay, '10.0.0.7:8303', { name: '手动' });
  await sleep(60);
  assert.equal(debug.state.lastConnectUrl, relay.url + '/udp/10.0.0.7:8303');
  assert.ok(debug.state.lastConnectUrl.indexOf('/udp/') > 0);
  assert.ok(debug.state.lastConnectUrl.indexOf('wss://other-relay.example.com') < 0);
});

await test('移动端：设备标记、触屏引导、全屏按钮与 cl_touch_controls 参数', async () => {
  const debug = globalThis.__ddwebDebug;
  const relay = debug.relayStore.list()[0];
  debug.setDevice({ kind: 'mobile', touch: true, touchMode: true });
  assert.equal(shim.documentElement.dataset.device, 'mobile');
  assert.equal(shim.body.classList.contains('is-mobile'), true);
  assert.equal(shim.body.classList.contains('has-touch'), true);
  assert.equal(debug.isTouchMode(), true);

  await debug.selectRelay(relay);
  assert.equal(debug.state.view, 'servers');
  assert.equal(get('touch-guide').hidden, false, '移动端服务器列表页应显示触屏说明');
  const guide = get('touch-guide-list').textContent;
  assert.match(guide, /触屏/);
  assert.match(guide, /cl_touch_controls 1/);
  assert.match(guide, /横屏/);
  assert.match(guide, /摇杆/);
  assert.match(guide, /跳跃/);
  assert.match(guide, /返回/);
  assert.equal(get('touch-guide-list').childNodes.length, 7);
  assert.ok(get('btn-touch-fullscreen'), '全屏按钮应存在');

  click(get('btn-touch-fullscreen'));
  assert.equal(debug.state.immersive.fullscreen, true, '点全屏按钮应调用 requestFullscreen');

  click(get('btn-touch-guide-close'));
  assert.equal(get('touch-guide').hidden, true, '关闭后触屏说明应立即隐藏');
  assert.equal(storage.getItem('ddweb.touch-guide-dismissed.v1'), '1', '关闭状态应持久化');
  debug.setDevice('mobile');
  assert.equal(get('touch-guide').hidden, true, '重新渲染/切换设备后仍保持关闭');

  click(get('server-list').childNodes[0]);
  await sleep(80);
  const call = launchCalls[launchCalls.length - 1];
  assert.equal(call.touchControls, true, '移动端启动会话应开启触屏控制');
  assert.equal(call.backButton, true, '移动端启动会话应开启虚拟返回按钮');
  assert.deepEqual(debug.state.lastLaunchArgs.slice(0, 2), ['cl_touch_controls 1', 'cl_back_button 1']);
  assert.match(debug.state.lastLaunchArgs[2], /^connect /, 'connect 必须排在最后');
  assert.equal(debug.state.view, 'game');
  assert.equal(get('touch-hint').hidden, false, '游戏内应显示触屏提示条');
  assert.equal(debug.state.immersive.fullscreen, true, '进入游戏时应请求全屏');
  click(get('btn-touch-hint-close'));
  assert.equal(get('touch-hint').hidden, true);
  assert.equal(storage.getItem('ddweb.touch-hint-dismissed.v1'), '1', '游戏内提示关闭状态应持久化');

  debug.setDevice('desktop');
  assert.equal(shim.documentElement.dataset.device, 'desktop');
  assert.equal(shim.body.classList.contains('is-desktop'), true);
  assert.equal(debug.isTouchMode(), false);
  assert.equal(get('touch-hint').hidden, true, '桌面端隐藏触屏 UI');
});

console.log('');
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : ''));
process.exit(failed ? 1 : 0);
