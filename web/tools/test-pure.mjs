// 纯函数 / 启动契约单测（零依赖）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { formatAgo, formatBytes, formatRtt, formatSpeed, truncate } from '../src/format.js';
import { parseTarget } from '../src/targets.js';
import {
  MAX_CONNECT_URL_LENGTH,
  buildConnectArgs,
  buildShareQuery,
  buildUdpWsUrl,
  normalizeRelayBase,
  parseConnectUrl,
  parseShareParams,
  relayAddressLabel,
} from '../src/relayurl.js';
import {
  RelayStore,
  clearHiddenRelayUrls,
  defaultRelaySeeds,
  hideRelayUrl,
  defaultRelayMasterUrl,
  loadDiscovery,
  loadMasterRelays,
  normalizeMasterUrl,
  loadHiddenRelayUrls,
  loadLastRelayId,
  loadNickname,
  parseRelaysText,
  sanitizeRelay,
  saveLastRelayId,
  saveNickname,
  serializeRelays,
  unhideRelayUrl,
} from '../src/relays.js';
import { createMemoryStorage } from '../src/storage.js';
import { createTour, markTourDone, readTourDone, TOUR_STORAGE_KEY } from '../src/tour.js';
import {
  HUD_SHORTCUT_HINT,
  HUD_SHORTCUT_LABEL,
  isBackquoteKeyEvent,
  isHudToggleShortcut,
  shouldIgnoreHudShortcut,
  toggleHudVisibility,
} from '../src/shortcuts.js';
import {
  applyDeviceAttributes,
  detectDevice,
  detectDeviceFromWindow,
  requestImmersive,
  SMALL_SCREEN_MAX,
} from '../src/device.js';
import {
  applyTheme,
  loadTheme,
  nextTheme,
  normalizeTheme,
  saveTheme,
  themeToggleIcon,
  themeToggleLabel,
} from '../src/theme.js';
import { collectSelfChecks, summarizeChecks } from '../src/diagnostics.js';
import { utf8Chunks } from '../src/ime.js';
import {
  filterOptions,
  filterServers,
  fetchMasterServers,
  normalizeMasterServer,
  normalizeRelayServers,
  parseMasterAddress,
  parseMasterPayload,
} from '../src/master.js';
import { fetchServers, normalizeServerEntry } from '../src/probe.js';
import {
  TOUCH_BACK_BUTTON_ARG,
  TOUCH_BACK_BUTTON_OFF_ARG,
  TOUCH_CONTROLS_OFF_ARG,
  TOUCH_CONTROLS_ARG,
  applyDefaultRelay,
  buildConnectTarget,
  buildDefaultRelayCall,
  buildDefaultRelayQuery,
  buildDirectConnectTarget,
  buildLaunchArgs,
  readConnectToken,
  startClientSession,
} from '../src/connect.js';
import {
  HOME_PATH,
  buildModuleConfig,
  launchWithModule,
  parseAnsiColorRgb,
  stripAnsi,
} from '../src/launch.js';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.dirname(TOOLS_DIR);

let passed = 0;
let failed = 0;

async function test(name, fn, timeoutMs = 6000) {
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

function createFakeFS(events) {
  return {
    mkdirTree(target) {
      events.push('mkdir:' + target);
    },
    mount(type, options, mountpoint) {
      events.push('mount:' + mountpoint);
      assert.ok(type);
    },
    syncfs(populate, callback) {
      events.push('sync:' + String(populate));
      setTimeout(() => callback(null), 1);
    },
  };
}
const IDBFS = { database: 'fake-idbfs' };

// ---------------------------------------------------------------- format / targets

await test('format 工具', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(54150365), '51.6 MB');
  assert.equal(formatRtt(5.56), '5.6 ms');
  assert.equal(formatRtt(123.4), '123 ms');
  assert.equal(formatSpeed(2048), '2.0 KB/s');
  assert.equal(formatSpeed(0), '0 B/s');
  assert.equal(formatAgo(Date.now() - 1000), '刚刚');
  assert.equal(formatAgo(Date.now() - 90 * 1000), '2 分钟前');
  assert.equal(truncate('abcdef', 4), 'abc…');
});

await test('parseTarget 校验与归一化', () => {
  assert.equal(parseTarget('ddnet.example.org:8303').target, 'ddnet.example.org:8303');
  assert.equal(parseTarget('DDNet.Example.ORG:8303').target, 'ddnet.example.org:8303');
  assert.equal(parseTarget('[::1]:8303').target, '[::1]:8303');
  assert.equal(parseTarget('wss://relay.example.com/udp/host.example:8303?token=x').target, 'host.example:8303');
  assert.equal(parseTarget('host').ok, false);
  assert.equal(parseTarget('host:0').ok, false);
  assert.equal(parseTarget('host:65536').ok, false);
  assert.equal(parseTarget('a b:8303').ok, false);
});

// ---------------------------------------------------------------- relay URL

await test('normalizeRelayBase 与地址显示', () => {
  const wss = normalizeRelayBase('wss://relay.example.com');
  assert.equal(wss.base, 'wss://relay.example.com');
  assert.equal(wss.httpBase, 'https://relay.example.com');
  assert.equal(normalizeRelayBase('https://relay.example.com/').base, 'wss://relay.example.com');
  assert.equal(normalizeRelayBase('relay.example.com:8443').base, 'wss://relay.example.com:8443');
  const local = normalizeRelayBase('http://127.0.0.1:8390');
  assert.equal(local.base, 'ws://127.0.0.1:8390');
  assert.equal(local.httpBase, 'http://127.0.0.1:8390');
  assert.equal(normalizeRelayBase('ftp://x').ok, false);
  assert.equal(relayAddressLabel('ws://127.0.0.1:8390'), '127.0.0.1:8390');
});

await test('buildUdpWsUrl：protocol / token 查询参数', () => {
  const plain = buildUdpWsUrl({ relayBase: 'wss://relay.example.com', host: 'ddnet.example.org', port: 8303 });
  assert.equal(plain.url, 'wss://relay.example.com/udp/ddnet.example.org:8303');

  const token = buildUdpWsUrl({ relayBase: 'ws://127.0.0.1:8390', host: '127.0.0.1', port: 8313, token: 'a b' });
  assert.equal(token.url, 'ws://127.0.0.1:8390/udp/127.0.0.1:8313?token=a%20b');

  const sixup = buildUdpWsUrl({ relayBase: 'ws://127.0.0.1:8390', host: '127.0.0.1', port: 8313, protocol: 7 });
  assert.equal(sixup.url, 'ws://127.0.0.1:8390/udp/127.0.0.1:8313?protocol=7');

  const both = buildUdpWsUrl({ relayBase: 'ws://127.0.0.1:8390', host: '127.0.0.1', port: 8313, protocol: 7, token: 'tk' });
  assert.equal(both.url, 'ws://127.0.0.1:8390/udp/127.0.0.1:8313?protocol=7&token=tk');

  const legacy = buildUdpWsUrl({ relayBase: 'ws://127.0.0.1:8390', host: '127.0.0.1', port: 8313, protocol: 6, token: 'tk' });
  assert.equal(legacy.url, 'ws://127.0.0.1:8390/udp/127.0.0.1:8313?token=tk');
});

await test('启动契约：Module.arguments = [\'connect <url>\']', () => {
  const url = 'wss://relay.example.com/udp/ddnet.example.org:8303';
  assert.deepEqual(buildConnectArgs(url), ['connect ' + url]);
  assert.equal(buildConnectArgs(url).length, 1);
  assert.equal(buildConnectArgs(url)[0].indexOf('connect '), 0);
});

await test('分享 / 直连参数解析', () => {
  const parsed = parseShareParams('?relay=relay-1&target=ddnet.example.org%3A8303');
  assert.equal(parsed.relayParam, 'relay-1');
  assert.equal(parsed.target, 'ddnet.example.org:8303');
  assert.equal(parsed.autostart, false);

  const connect = parseShareParams('?connect=' + encodeURIComponent('ws://127.0.0.1:8390/udp/127.0.0.1:8313') + '&autostart=1');
  assert.equal(connect.connectUrl, 'ws://127.0.0.1:8390/udp/127.0.0.1:8313');
  assert.equal(connect.autostart, true);
  assert.equal(connect.target, '', 'connect 不应被当成 target');

  assert.equal(buildShareQuery({ relayId: 'r1', target: 'host:8303' }), '?relay=r1&target=host%3A8303');
  assert.equal(buildShareQuery({ relayUrl: 'wss://relay.example.com', target: 'host:8303' }), '?relayUrl=wss%3A%2F%2Frelay.example.com&target=host%3A8303');
  assert.equal(buildShareQuery({ connectUrl: 'ws://x/udp/a:1', autostart: true }), '?connect=ws%3A%2F%2Fx%2Fudp%2Fa%3A1&autostart=1');
});

await test('parseConnectUrl 原样保留直连地址', () => {
  const info = parseConnectUrl('ws://127.0.0.1:8390/udp/127.0.0.1:8313');
  assert.equal(info.ok, true);
  assert.equal(info.url, 'ws://127.0.0.1:8390/udp/127.0.0.1:8313');
  assert.equal(info.target, '127.0.0.1:8313');
  assert.equal(info.relayBase, 'ws://127.0.0.1:8390');
  assert.equal(info.httpBase, 'http://127.0.0.1:8390');
  assert.equal(parseConnectUrl('http://x/udp/a:1').ok, false);
  assert.equal(parseConnectUrl('').ok, false);
});

// ---------------------------------------------------------------- 中继存储

await test('sanitizeRelay / 序列化', () => {
  const result = sanitizeRelay({ url: 'relay.example.com', token: ' t ', name: '  名称  ' });
  assert.equal(result.ok, true);
  assert.equal(result.relay.url, 'wss://relay.example.com');
  assert.equal(result.relay.name, '名称');
  assert.equal(result.relay.token, 't');
  assert.match(result.relay.id, /^relay-/);
  assert.equal(sanitizeRelay({ url: 'bad url' }).ok, false);

  const text = serializeRelays([result.relay]);
  const parsed = parseRelaysText(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.relays.length, 1);
  assert.equal(parsed.relays[0].url, 'wss://relay.example.com');
});

await test('RelayStore 增删改查与持久化', () => {
  const storage = createMemoryStorage();
  const store = new RelayStore({ storage, now: () => 1000 }).load();
  const a = store.add({ name: 'A', url: 'wss://a.example.com' });
  const b = store.add({ name: 'B', url: 'ws://127.0.0.1:8390' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(store.add({ url: 'wss://a.example.com' }).ok, false);
  assert.equal(store.update(a.relay.id, { name: 'A2', token: 'tk' }).ok, true);
  assert.equal(store.get(a.relay.id).name, 'A2');
  assert.equal(store.update(a.relay.id, { url: 'ws://127.0.0.1:8390' }).ok, false);
  assert.equal(store.remove(b.relay.id).ok, true);
  assert.equal(store.count(), 1);

  const reloaded = new RelayStore({ storage }).load();
  assert.equal(reloaded.count(), 1);
  assert.equal(reloaded.list()[0].token, 'tk');

  saveNickname(storage, '玩家');
  assert.equal(loadNickname(storage), '玩家');
  saveLastRelayId(storage, a.relay.id);
  assert.equal(loadLastRelayId(storage), a.relay.id);
});

await test('内置后端隐藏列表：隐藏 / 取消隐藏 / 清空', () => {
  const storage = createMemoryStorage();
  assert.deepEqual(loadHiddenRelayUrls(storage), []);
  let list = hideRelayUrl(storage, 'ws://127.0.0.1:8390');
  assert.deepEqual(list, ['ws://127.0.0.1:8390']);
  list = hideRelayUrl(storage, 'http://127.0.0.1:8390/');
  assert.deepEqual(list, ['ws://127.0.0.1:8390'], '规范化后应去重');
  list = hideRelayUrl(storage, 'bad url');
  assert.deepEqual(list, ['ws://127.0.0.1:8390'], '非法地址忽略');
  list = unhideRelayUrl(storage, 'ws://127.0.0.1:8390');
  assert.deepEqual(list, []);
  hideRelayUrl(storage, 'ws://a.example.com');
  hideRelayUrl(storage, 'wss://b.example.com');
  assert.deepEqual(clearHiddenRelayUrls(storage), []);
  assert.deepEqual(loadHiddenRelayUrls(storage), []);
});

await test('默认本地中继种子与 relays.json 发现', async () => {
  const seeds = defaultRelaySeeds({ location: { hostname: '127.0.0.1' } });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].url, 'ws://127.0.0.1:8390');
  assert.deepEqual(defaultRelaySeeds({ location: { hostname: 'example.com' } }), []);

  const fetchImpl = async (url) => {
    assert.equal(url, 'relays.json');
    return new Response(JSON.stringify({ relays: [{ name: '推荐', url: 'wss://rec.example.com' }, { url: 'bad url' }] }), { status: 200 });
  };
  const discovery = await loadDiscovery(fetchImpl);
  assert.equal(discovery.ok, true);
  assert.equal(discovery.relays.length, 1);
  assert.equal(discovery.relays[0].source, 'discovered');

  const missing = await loadDiscovery(async () => new Response('', { status: 404 }));
  assert.equal(missing.ok, false);
});

// ---------------------------------------------------------------- 引导 / 快捷键 / 自检

await test('聚光灯引导状态机', () => {
  const tour = createTour([{ id: 'a' }, { id: 'b' }]);
  assert.equal(tour.start(), true);
  assert.equal(tour.current().id, 'a');
  assert.equal(tour.next(), true);
  assert.equal(tour.current().id, 'b');
  assert.equal(tour.isLast(), true);
  assert.equal(tour.next(), false);
  assert.equal(tour.finished, true);
  assert.equal(tour.active, false);

  const skipped = createTour([{ id: 'x' }]);
  skipped.start();
  skipped.skip();
  assert.equal(skipped.finished, true);

  const empty = createTour([]);
  assert.equal(empty.start(), false);
  assert.equal(empty.current(), null);

  const storage = createMemoryStorage();
  assert.equal(readTourDone(storage), false);
  markTourDone(storage);
  assert.equal(readTourDone(storage), true);
  assert.equal(storage.getItem(TOUR_STORAGE_KEY), 'done');
});

await test('主题工具：默认亮色 / 切换 / 持久化', () => {
  assert.equal(normalizeTheme(undefined), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('LIGHT'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(themeToggleLabel('light'), '深色');
  assert.equal(themeToggleLabel('dark'), '亮色');
  assert.equal(themeToggleIcon('light'), '☾');
  assert.equal(themeToggleIcon('dark'), '☀');
  const storage = createMemoryStorage();
  assert.equal(loadTheme(storage), 'light');
  saveTheme(storage, 'dark');
  assert.equal(loadTheme(storage), 'dark');
  assert.equal(storage.getItem('ddweb.theme.v1'), 'dark');
  const element = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  assert.equal(applyTheme(element, 'dark'), 'dark');
  assert.equal(element.attrs['data-theme'], 'dark');
  assert.equal(applyTheme(element, 'bogus'), 'light');
  assert.equal(element.attrs['data-theme'], 'light');
});

await test('Ctrl+` 快捷键判定（Backquote，替代被 Windows 保留的 Esc 组合键）', () => {
  assert.equal(isHudToggleShortcut({ ctrlKey: true, code: 'Backquote', key: '`' }), true);
  assert.equal(isHudToggleShortcut({ ctrlKey: true, code: 'Backquote', key: '~' }), true, 'Ctrl+Shift+` 也生效');
  assert.equal(isHudToggleShortcut({ ctrlKey: true, key: '`' }), true, '只有 key 时回退匹配');
  assert.equal(isHudToggleShortcut({ ctrlKey: true, key: '~' }), true);
  assert.equal(isHudToggleShortcut({ ctrlKey: true, keyCode: 192 }), true, '旧浏览器 keyCode 回退');
  assert.equal(isHudToggleShortcut({ ctrlKey: false, code: 'Backquote', key: '`' }), false);
  assert.equal(isHudToggleShortcut({ ctrlKey: true, code: 'Escape', key: 'Escape' }), false, '旧的 Esc 组合键不再触发');
  assert.equal(isHudToggleShortcut({ ctrlKey: true, code: 'KeyQ', key: 'q' }), false);
  assert.equal(isHudToggleShortcut({}), false);
  assert.equal(isHudToggleShortcut(null), false);
  assert.equal(isBackquoteKeyEvent({ code: 'Backquote' }), true);
  assert.equal(isBackquoteKeyEvent({ key: '~' }), true);
  assert.equal(isBackquoteKeyEvent({ key: 'a' }), false);
  assert.equal(shouldIgnoreHudShortcut({ ctrlKey: true, code: 'Backquote' }), false, '全局快捷键：输入框内也要生效');
  assert.equal(HUD_SHORTCUT_LABEL, 'Ctrl+`');
  assert.match(HUD_SHORTCUT_HINT, /Ctrl\+`/);
  assert.match(HUD_SHORTCUT_HINT, /~ 键/);
  assert.equal(toggleHudVisibility(false), true);
  assert.equal(toggleHudVisibility(true), false);
});

await test('设备检测：mobile / tablet / desktop', async () => {
  const iphone = detectDevice({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    media: { coarse: true, fine: false },
    screen: { width: 390, height: 844 },
  });
  assert.equal(iphone.kind, 'mobile');
  assert.equal(iphone.touch, true);
  assert.equal(iphone.touchMode, true);
  assert.equal(iphone.reason, 'ua-mobile');

  const androidPhone = detectDevice({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    maxTouchPoints: 5,
    media: { coarse: true },
    screen: { width: 412, height: 915 },
  });
  assert.equal(androidPhone.kind, 'mobile');

  const androidSmallNoUa = detectDevice({ maxTouchPoints: 5, media: { coarse: true }, screen: { width: 360, height: 800 } });
  assert.equal(androidSmallNoUa.kind, 'mobile');
  assert.equal(androidSmallNoUa.reason, 'small-screen-touch');

  const ipad = detectDevice({
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    media: { coarse: true },
    screen: { width: 1024, height: 1366 },
  });
  assert.equal(ipad.kind, 'tablet');

  const ipadDesktopUa = detectDevice({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    media: { coarse: true },
    screen: { width: 1024, height: 1366 },
  });
  assert.equal(ipadDesktopUa.kind, 'tablet', 'iPadOS 桌面 UA + 大屏多点触控应识别为平板');

  const touchLaptop = detectDevice({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    maxTouchPoints: 10,
    media: { coarse: false, fine: true },
    screen: { width: 1920, height: 1080 },
  });
  assert.equal(touchLaptop.kind, 'desktop', '触屏笔记本（fine 指针）应保持桌面模式，不显示触控控件');
  assert.equal(touchLaptop.touch, true);
  assert.equal(touchLaptop.touchMode, false);
  assert.equal(touchLaptop.reason, 'touch-fine-desktop');

  const touchMonitor = detectDevice({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    maxTouchPoints: 10,
    media: { coarse: true, fine: false },
    screen: { width: 1920, height: 1080 },
  });
  assert.equal(touchMonitor.kind, 'desktop', 'Windows 触屏/触控显示器按桌面处理，不显示触控面板');
  assert.equal(touchMonitor.touch, true);
  assert.equal(touchMonitor.touchMode, false);
  assert.equal(touchMonitor.reason, 'desktop-os-large-screen');

  const smallWindowsTablet = detectDevice({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    maxTouchPoints: 10,
    media: { coarse: true },
    screen: { width: 800, height: 600 },
  });
  assert.equal(smallWindowsTablet.kind, 'mobile', '小屏 Windows 触屏设备仍按触屏处理');

  const desktop = detectDevice({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    maxTouchPoints: 0,
    media: { coarse: false, fine: true },
    screen: { width: 1920, height: 1080 },
  });
  assert.equal(desktop.kind, 'desktop');
  assert.equal(desktop.touch, false);
  assert.equal(desktop.touchMode, false);

  assert.equal(detectDevice({}).kind, 'desktop', '空环境（jsdom 等）应降级为桌面');
  assert.equal(SMALL_SCREEN_MAX, 700);

  const uaCh = detectDevice({
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    uaMobile: true,
    maxTouchPoints: 5,
    media: { coarse: true },
    screen: { width: 360, height: 800 },
  });
  assert.equal(uaCh.kind, 'mobile', 'UA-CH mobile 也是手机信号');

  const bare = detectDevice({ maxTouchPoints: 2, screen: { width: 1280, height: 800 } });
  assert.equal(bare.kind, 'tablet', '无 matchMedia 时按触摸点 + 大屏判断');

  assert.equal(detectDeviceFromWindow({ navigator: {}, matchMedia: undefined }).kind, 'desktop');
  const fakeWin = {
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      maxTouchPoints: 5,
      userAgentData: { mobile: true },
    },
    innerWidth: 412,
    innerHeight: 915,
    screen: { width: 412, height: 915 },
    matchMedia: (query) => ({ matches: query.indexOf('coarse') >= 0 }),
  };
  assert.equal(detectDeviceFromWindow(fakeWin).kind, 'mobile');

  const classList = {
    set: new Set(),
    add(name) { this.set.add(name); },
    remove(name) { this.set.delete(name); },
    contains(name) { return this.set.has(name); },
  };
  const doc = {
    documentElement: {
      dataset: {},
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
    },
    body: { classList },
  };
  applyDeviceAttributes(doc, iphone);
  assert.equal(doc.documentElement.dataset.device, 'mobile');
  assert.equal(doc.documentElement.attrs['data-device'], 'mobile');
  assert.equal(classList.contains('is-mobile'), true);
  assert.equal(classList.contains('has-touch'), true);
  applyDeviceAttributes(doc, desktop);
  assert.equal(doc.documentElement.dataset.device, 'desktop');
  assert.equal(classList.contains('is-mobile'), false);
  assert.equal(classList.contains('is-desktop'), true);
  assert.equal(classList.contains('has-touch'), false);

  const immersiveCalls = [];
  const immersive = requestImmersive(
    { screen: { orientation: { lock(value) { immersiveCalls.push('lock:' + value); return Promise.resolve(); } } } },
    {
      fullscreenElement: null,
      documentElement: { requestFullscreen(options) { immersiveCalls.push('fs:' + options.navigationUI); return Promise.resolve(); } },
    }
  );
  assert.equal(immersive.fullscreen, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(immersive.orientation, true);
  assert.deepEqual(immersiveCalls, ['fs:hide', 'lock:landscape']);
  const degraded = requestImmersive({}, {});
  assert.equal(degraded.fullscreen, false);
  assert.equal(degraded.orientation, false);
});

await test('collectSelfChecks / summarizeChecks', () => {
  const checks = collectSelfChecks({
    isSecureContext: false,
    crossOriginIsolated: false,
    hasSharedArrayBuffer: false,
    webgl2: false,
    storageOk: false,
    storageReason: '隐私模式',
  });
  assert.equal(checks.length, 5);
  assert.equal(summarizeChecks(checks).blocking, true);
  assert.match(checks.find((check) => check.id === 'cross-origin-isolated').detail, /Cross-Origin-Opener-Policy/);
  const ok = collectSelfChecks({ isSecureContext: true, crossOriginIsolated: true, hasSharedArrayBuffer: true, webgl2: true, storageOk: true });
  assert.equal(summarizeChecks(ok).blocking, false);
});

// ---------------------------------------------------------------- 服务器列表

await test('normalizeServerEntry / fetchServers', async () => {
  assert.deepEqual(normalizeServerEntry({ name: 'A', host: 'h', port: 8303, region: 'EU' }), {
    name: 'A', host: 'h', port: 8303, region: 'EU', players: undefined, target: 'h:8303',
  });
  assert.equal(normalizeServerEntry({ host: 'h', port: 'x' }), null);

  const fetchImpl = async (url) => {
    assert.equal(url, 'http://relay.test:8390/api/servers');
    return new Response(JSON.stringify({ servers: [{ name: 'A', host: '127.0.0.1', port: 8313 }, { host: 'x', port: 9000, players: { online: 4 } }] }), { status: 200 });
  };
  const result = await fetchServers({ url: 'ws://relay.test:8390' }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.servers.length, 2);
  assert.equal(result.servers[1].players, 4);

  const bad = await fetchServers({ url: 'ws://relay.test:8390' }, { fetchImpl: async () => new Response('oops', { status: 500 }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /500/);
});

// ---------------------------------------------------------------- 启动契约 / 会话

await test('buildConnectTarget 组装 0.6/0.7 连接地址', () => {
  const relay = { url: 'ws://127.0.0.1:8390', token: 'tk' };
  const target = { host: '127.0.0.1', port: 8313 };
  const six = buildConnectTarget(relay, target);
  assert.equal(six.ok, true);
  assert.deepEqual(six.args, ['connect ws://127.0.0.1:8390/udp/127.0.0.1:8313?token=tk']);
  const seven = buildConnectTarget(relay, target, { protocol: 7 });
  assert.equal(seven.url, 'ws://127.0.0.1:8390/udp/127.0.0.1:8313?protocol=7&token=tk');
  assert.equal(buildConnectTarget(null, target).ok, false);
  const long = buildConnectTarget({ url: 'ws://127.0.0.1:8390', token: 'x'.repeat(MAX_CONNECT_URL_LENGTH) }, target);
  assert.equal(long.ok, false);
  assert.match(long.error, /过长/);

  const direct = buildDirectConnectTarget('ws://127.0.0.1:8390/udp/127.0.0.1:8313');
  assert.equal(direct.ok, true);
  assert.deepEqual(direct.args, ['connect ws://127.0.0.1:8390/udp/127.0.0.1:8313']);
  assert.equal(buildDirectConnectTarget('http://x/udp/a:1').ok, false);
});

await test('buildDefaultRelayCall：游戏内服务器浏览器改走中继', () => {
  const call = buildDefaultRelayCall({ relayBase: 'wss://relay.example.com/', token: 'a b' });
  assert.equal(call.ok, true);
  assert.equal(call.relayBase, 'wss://relay.example.com', '去掉结尾斜杠');
  assert.equal(call.query, 'token=a%20b');
  assert.deepEqual(call.args, ['wss://relay.example.com', 'token=a%20b']);

  const fromRelay = buildDefaultRelayCall({ relay: { url: 'wss://r.example.com/relay', token: 'tk' } });
  assert.equal(fromRelay.relayBase, 'wss://r.example.com/relay');
  assert.equal(fromRelay.query, 'token=tk');

  const pathAndSlash = buildDefaultRelayCall({ relayBase: 'wss://relay.example.com:8443/prefix/', token: 'a b' });
  assert.equal(pathAndSlash.relayBase, 'wss://relay.example.com:8443/prefix', '保留路径并去掉结尾斜杠');
  assert.equal(pathAndSlash.query, 'token=a%20b');
  const directPath = buildDefaultRelayCall({ connectUrl: 'wss://host:8443/prefix/udp/game.example:8303?token=a%20b&protocol=7' });
  assert.equal(directPath.relayBase, 'wss://host:8443/prefix');
  assert.equal(directPath.query, 'token=a%20b');

  const noToken = buildDefaultRelayCall({ relay: { url: 'wss://r.example.com', token: '' } });
  assert.equal(noToken.ok, true);
  assert.equal(noToken.query, '');

  assert.equal(buildDefaultRelayCall({ relay: { url: 'http://127.0.0.1:8390' } }).relayBase, 'ws://127.0.0.1:8390');

  const direct = buildDefaultRelayCall({ connectUrl: 'ws://127.0.0.1:8390/udp/host.example:8303?token=xyz&protocol=7' });
  assert.equal(direct.relayBase, 'ws://127.0.0.1:8390');
  assert.equal(direct.token, 'xyz');
  assert.equal(direct.query, 'token=xyz');

  const directNoToken = buildDefaultRelayCall({ connectUrl: 'ws://127.0.0.1:8390/udp/host.example:8303' });
  assert.equal(directNoToken.query, '');

  const mixed = buildDefaultRelayCall({ relayBase: 'wss://r.example.com', connectUrl: 'ws://x/udp/a:1?token=fromUrl' });
  assert.equal(mixed.token, 'fromUrl', '显式 relayBase + connectUrl 时仍读取 URL 里的 token');
  assert.equal(mixed.query, 'token=fromUrl');

  assert.equal(buildDefaultRelayCall({ relayBase: 'ftp://x' }).ok, false);
  assert.equal(buildDefaultRelayCall({}).ok, false);
  assert.equal(buildDefaultRelayQuery({ token: '' }), '');
  assert.equal(buildDefaultRelayQuery({ token: 'tk' }), 'token=tk');
  assert.equal(readConnectToken('ws://x/udp/a:1?token=t%20k'), 't k');
  assert.equal(readConnectToken('not a url'), '');

  const calls = [];
  const fakeModule = {
    ccall(name, ret, types, args) {
      calls.push({ name, ret, types, args });
      return 0;
    },
  };
  const applied = applyDefaultRelay(fakeModule, call);
  assert.equal(applied.ok, true);
  assert.equal(applied.called, true);
  assert.deepEqual(calls[0], {
    name: 'DDWeb_SetDefaultRelay',
    ret: null,
    types: ['string', 'string'],
    args: ['wss://relay.example.com', 'token=a%20b'],
  });

  const guarded = applyDefaultRelay({}, call);
  assert.equal(guarded.ok, false);
  assert.match(guarded.error, /ccall/);
  const invalid = applyDefaultRelay(fakeModule, { ok: false, error: '没有中继' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /没有中继/);
  const thrown = applyDefaultRelay({ ccall() { throw new Error('boom'); } }, call);
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /boom/);
});

await test('移动端启动参数：cl_touch_controls 1 在 connect 之前', () => {
  const connect = ['connect ws://relay.test/udp/host:8303?protocol=7'];
  assert.deepEqual(buildLaunchArgs(connect, {}), [TOUCH_CONTROLS_OFF_ARG, TOUCH_BACK_BUTTON_OFF_ARG, connect[0]], '桌面端必须显式关闭触屏控件');
  assert.deepEqual(buildLaunchArgs(connect, { touchControls: true }), [TOUCH_CONTROLS_ARG, TOUCH_BACK_BUTTON_OFF_ARG, connect[0]]);
  assert.equal(buildLaunchArgs(connect, { touchControls: true })[0], 'cl_touch_controls 1');
  assert.deepEqual(buildLaunchArgs(connect, { touchControls: true, backButton: true }), [
    TOUCH_CONTROLS_ARG,
    TOUCH_BACK_BUTTON_ARG,
    connect[0],
  ]);
  assert.deepEqual(buildLaunchArgs(connect, { backButton: true }), [TOUCH_CONTROLS_OFF_ARG, TOUCH_BACK_BUTTON_ARG, connect[0]]);
  assert.deepEqual(buildLaunchArgs(null, { touchControls: true }), [TOUCH_CONTROLS_ARG, TOUCH_BACK_BUTTON_OFF_ARG]);
  assert.equal(buildLaunchArgs(connect, { touchControls: true }).slice(-1)[0].indexOf('connect '), 0, 'connect 永远是最后一条命令');
  const original = connect.slice();
  buildLaunchArgs(connect, { touchControls: true, backButton: true });
  assert.deepEqual(connect, original, '不应修改入参数组');
});

await test('launchWithModule 顺序与 callMain 契约', async () => {
  const events = [];
  const FS = createFakeFS(events);
  const expectedArgs = ['connect wss://relay.example.com/udp/host:8303'];
  const Module = {
    arguments: [],
    callMain(args) {
      assert.equal(this, Module);
      assert.deepEqual(args, expectedArgs);
      assert.deepEqual(this.arguments, expectedArgs);
      events.push('callMain');
      return 7;
    },
  };
  const result = await launchWithModule({
    Module,
    FS,
    IDBFS,
    args: expectedArgs,
    onStep: (step) => events.push('step:' + step),
  });
  assert.equal(result, 7);
  assert.deepEqual(events, [
    'step:mkdir', 'mkdir:' + HOME_PATH,
    'step:mount', 'mount:' + HOME_PATH,
    'step:sync', 'sync:true',
    'step:callMain', 'callMain',
  ]);
  await assert.rejects(() => launchWithModule({ Module: {}, FS, IDBFS }), /callMain/);
});

await test('buildModuleConfig 注入 locateFile / mainScriptUrlOrBlob', () => {
  const calls = [];
  const Module = buildModuleConfig({
    canvas: { id: 'canvas' },
    locateFile: (path) => 'blob:' + path,
    mainScriptUrlOrBlob: 'blob:DDNet.js',
    hooks: {
      onPrint: (text) => calls.push('print:' + text),
      onDependencies: (left) => calls.push('deps:' + left),
    },
  });
  assert.equal(Module.noInitialRun, true);
  assert.deepEqual(Module.arguments, []);
  assert.equal(Module.canvas.id, 'canvas');
  assert.equal(Module.locateFile('DDNet.wasm'), 'blob:DDNet.wasm');
  assert.equal(Module.mainScriptUrlOrBlob, 'blob:DDNet.js');
  Module.print('hello');
  Module.monitorRunDependencies(2);
  assert.deepEqual(calls, ['print:hello', 'deps:2']);
});

await test('startClientSession：注入 assetUrls、loadScript、callMain', async () => {
  const events = [];
  const moduleOptions = {};
  const order = [];
  let relayCallArgs = null;
  let scriptSrc = '';
  let callArgs = null;
  let launchArgs = null;
  const session = await startClientSession({
    relay: { url: 'ws://127.0.0.1:8390', token: 'tk' },
    target: { host: '127.0.0.1', port: 8313 },
    assetUrls: { 'DDNet.js': 'blob:js', 'DDNet.wasm': 'blob:wasm', 'DDNet.data': 'blob:data' },
    createModule: (options) => {
      Object.assign(moduleOptions, options);
      return buildModuleConfig({
        hooks: options.hooks,
        locateFile: options.locateFile,
        mainScriptUrlOrBlob: options.mainScriptUrlOrBlob,
      });
    },
    assignModule: (Module) => {
      globalThis.Module = Module;
    },
    loadScript: async (src) => {
      scriptSrc = src;
      const Module = globalThis.Module;
      Module.ccall = (name, ret, types, args) => {
        order.push('ccall:' + name);
        relayCallArgs = { name, ret, types, args };
      };
      Module.callMain = (args) => {
        order.push('callMain');
        callArgs = args.slice();
      };
      setTimeout(() => Module.onRuntimeInitialized(), 2);
    },
    resolveRuntime: () => ({ FS: createFakeFS([]), IDBFS }),
    launch: async (options) => {
      launchArgs = options.args;
      options.Module.callMain(options.Module.arguments);
    },
    onEvent: (event) => events.push(event.type),
    readyTimeoutMs: 2000,
  });
  assert.equal(scriptSrc, 'blob:js');
  assert.equal(moduleOptions.locateFile('DDNet.wasm'), 'blob:wasm');
  assert.equal(moduleOptions.mainScriptUrlOrBlob, 'blob:js');
  assert.deepEqual(launchArgs, ['cl_touch_controls 0', 'cl_back_button 0', 'connect ws://127.0.0.1:8390/udp/127.0.0.1:8313?token=tk']);
  assert.deepEqual(callArgs, launchArgs);
  assert.deepEqual(session.args, ['cl_touch_controls 0', 'cl_back_button 0', 'connect ws://127.0.0.1:8390/udp/127.0.0.1:8313?token=tk'], '桌面端必须显式关闭触屏控件，connect 仍是最后一条');
  assert.equal(session.args.length, 3);
  assert.equal(session.phase, 'running');
  assert.deepEqual(events, ['prepare', 'module-created', 'script-loading', 'runtime-initializing', 'runtime-ready', 'default-relay', 'call-main', 'running']);
  // 运行时 ready 后、callMain 前把中继地址交给 C++（游戏内服务器浏览器改走中继）
  assert.ok(relayCallArgs, '应调用 Module.ccall');
  assert.equal(relayCallArgs.name, 'DDWeb_SetDefaultRelay');
  assert.equal(relayCallArgs.ret, null);
  assert.deepEqual(relayCallArgs.types, ['string', 'string']);
  assert.deepEqual(relayCallArgs.args, ['ws://127.0.0.1:8390', 'token=tk']);
  assert.deepEqual(order, ['ccall:DDWeb_SetDefaultRelay', 'callMain'], 'DDWeb_SetDefaultRelay 必须在 callMain 之前');
  assert.equal(session.defaultRelayApplied.ok, true);
  assert.equal(session.defaultRelayApplied.called, true);
});

await test('startClientSession：0.7 协议写入启动 URL', async () => {
  let launchedArgs = null;
  await startClientSession({
    relay: { url: 'ws://127.0.0.1:8390', token: 'tk' },
    target: { host: '127.0.0.1', port: 8313 },
    protocol: 7,
    assetUrls: { 'DDNet.js': 'blob:js', 'DDNet.wasm': 'blob:wasm', 'DDNet.data': 'blob:data' },
    createModule: (options) => buildModuleConfig({ hooks: options.hooks }),
    assignModule: (Module) => {
      globalThis.Module = Module;
    },
    loadScript: async () => {
      const Module = globalThis.Module;
      Module.callMain = () => {};
      setTimeout(() => Module.onRuntimeInitialized(), 2);
    },
    resolveRuntime: () => ({ FS: createFakeFS([]), IDBFS }),
    launch: async (options) => {
      launchedArgs = options.args;
      options.Module.callMain(options.Module.arguments);
    },
    readyTimeoutMs: 2000,
  });
  assert.deepEqual(launchedArgs, ['cl_touch_controls 0', 'cl_back_button 0', 'connect ws://127.0.0.1:8390/udp/127.0.0.1:8313?protocol=7&token=tk']);
});

await test('startClientSession：直连 URL 原样透传', async () => {
  const directUrl = 'ws://127.0.0.1:8390/udp/127.0.0.1:8313?protocol=7';
  let launchArgs = null;
  await startClientSession({
    connectUrl: directUrl,
    assetUrls: { 'DDNet.js': 'blob:js', 'DDNet.wasm': 'blob:wasm', 'DDNet.data': 'blob:data' },
    createModule: (options) => buildModuleConfig({ hooks: options.hooks }),
    assignModule: (Module) => {
      globalThis.Module = Module;
    },
    loadScript: async () => {
      const Module = globalThis.Module;
      Module.callMain = () => {};
      setTimeout(() => Module.onRuntimeInitialized(), 2);
    },
    resolveRuntime: () => ({ FS: createFakeFS([]), IDBFS }),
    launch: async (options) => {
      launchArgs = options.args;
      options.Module.callMain(options.Module.arguments);
    },
    readyTimeoutMs: 2000,
  });
  assert.deepEqual(launchArgs, ['cl_touch_controls 0', 'cl_back_button 0', 'connect ' + directUrl]);
});

await test('startClientSession：移动端触屏命令 + 直连 token 传给默认中继', async () => {
  const events = [];
  const order = [];
  let launchArgs = null;
  let relayCallArgs = null;
  const directUrl = 'ws://127.0.0.1:8390/udp/127.0.0.1:8313?token=abc&protocol=7';
  await startClientSession({
    connectUrl: directUrl,
    touchControls: true,
    backButton: true,
    assetUrls: { 'DDNet.js': 'blob:js', 'DDNet.wasm': 'blob:wasm', 'DDNet.data': 'blob:data' },
    createModule: (options) => buildModuleConfig({ hooks: options.hooks }),
    assignModule: (Module) => {
      globalThis.Module = Module;
    },
    loadScript: async () => {
      const Module = globalThis.Module;
      Module.ccall = (name, ret, types, args) => {
        order.push('ccall');
        relayCallArgs = { name, types, args };
      };
      Module.callMain = () => order.push('callMain');
      setTimeout(() => Module.onRuntimeInitialized(), 2);
    },
    resolveRuntime: () => ({ FS: createFakeFS([]), IDBFS }),
    launch: async (options) => {
      launchArgs = options.args;
      options.Module.callMain(options.Module.arguments);
    },
    onEvent: (event) => events.push(event),
    readyTimeoutMs: 2000,
  });
  assert.deepEqual(launchArgs, [
    'cl_touch_controls 1',
    'cl_back_button 1',
    'connect ' + directUrl,
  ]);
  assert.equal(launchArgs[launchArgs.length - 1].indexOf('connect '), 0);
  assert.deepEqual(relayCallArgs.types, ['string', 'string']);
  assert.deepEqual(relayCallArgs.args, ['ws://127.0.0.1:8390', 'token=abc'], '直连 URL 的 relayBase/token 必须交给 DDWeb_SetDefaultRelay');
  assert.deepEqual(order, ['ccall', 'callMain']);
  const relayEvent = events.find((event) => event.type === 'default-relay');
  assert.ok(relayEvent);
  assert.equal(relayEvent.payload.ok, true);
});

await test('startClientSession：无 ccall 时安全跳过 DDWeb_SetDefaultRelay', async () => {
  const events = [];
  let launchArgs = null;
  await startClientSession({
    relay: { url: 'ws://127.0.0.1:8390', token: '' },
    target: { host: '127.0.0.1', port: 8313 },
    assetUrls: { 'DDNet.js': 'blob:js', 'DDNet.wasm': 'blob:wasm', 'DDNet.data': 'blob:data' },
    createModule: (options) => buildModuleConfig({ hooks: options.hooks }),
    assignModule: (Module) => {
      globalThis.Module = Module;
    },
    loadScript: async () => {
      const Module = globalThis.Module;
      Module.callMain = () => {};
      setTimeout(() => Module.onRuntimeInitialized(), 2);
    },
    resolveRuntime: () => ({ FS: createFakeFS([]), IDBFS }),
    launch: async (options) => {
      launchArgs = options.args;
      options.Module.callMain(options.Module.arguments);
    },
    onEvent: (event) => events.push(event),
    readyTimeoutMs: 2000,
  });
  assert.deepEqual(launchArgs, ['cl_touch_controls 0', 'cl_back_button 0', 'connect ws://127.0.0.1:8390/udp/127.0.0.1:8313']);
  const relayEvent = events.find((event) => event.type === 'default-relay');
  assert.ok(relayEvent, '应发出 default-relay 事件');
  assert.equal(relayEvent.payload.ok, false);
  assert.match(relayEvent.payload.error, /ccall/);
  assert.ok(events.some((event) => event.type === 'call-main'), '即使没有 ccall 也必须继续启动');
});

await test('parseAnsiColorRgb / stripAnsi', () => {
  const colored = parseAnsiColorRgb('\u001b[38;2;255;165;0mhello\u001b[0m');
  assert.equal(colored.color, 'rgb(255, 165, 0)');
  assert.equal(colored.message, 'hello');
  assert.equal(parseAnsiColorRgb('plain').message, 'plain');
  assert.equal(stripAnsi('a\u001b[1mb\u001b[0m'), 'ab');
});

// ---------------------------------------------------------------- 假构建产物（vm）

await test('假 DDNet.js 与宿主流程对接（单参数 connect）', async () => {
  const source = fs.readFileSync(path.join(TOOLS_DIR, 'fake-build', 'DDNet.js'), 'utf8');
  const sandbox = { console, setTimeout, clearTimeout, Date, JSON, Math };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);

  const events = [];
  let readyResolve = null;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  const Module = buildModuleConfig({
    hooks: {
      onPrint: (text) => events.push('print:' + text),
      onRuntimeInitialized: () => {
        events.push('ready');
        readyResolve();
      },
      onExit: (status) => events.push('exit:' + status),
    },
  });
  context.Module = Module;
  vm.runInContext(source, context, { filename: 'fake-DDNet.js', timeout: 5000 });
  await ready;

  const stats = context.__ddwebFakeBuildStats;
  assert.ok(stats);
  const args = ['connect ws://127.0.0.1:8390/udp/127.0.0.1:8313'];
  const fsEvents = [];
  const result = await launchWithModule({
    Module,
    FS: context.FS,
    IDBFS: context.IDBFS,
    args,
    onStep: (step) => fsEvents.push(step),
  });
  assert.equal(result, 0);
  assert.deepEqual(stats.callMain[0], args);
  assert.deepEqual(fsEvents, ['mkdir', 'mount', 'sync', 'callMain']);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stats.exits.length, 1);
  assert.ok(events.some((item) => item === 'exit:0'));
});

// ---------------------------------------------------------------- 静态一致性

await test('app.js 引用的 DOM id 均存在于 index.html', () => {
  const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  const ids = new Set();
  const idRe = /id="([^"]+)"/g;
  let match;
  while ((match = idRe.exec(html))) ids.add(match[1]);

  const appSource = fs.readFileSync(path.join(WEB_DIR, 'app.js'), 'utf8');
  const used = new Set();
  const refBlockMatch = appSource.match(/const REF_IDS = \{([\s\S]*?)\};/);
  assert.ok(refBlockMatch, 'app.js 应包含 REF_IDS');
  const pairRe = /^\s{2}(\w+): '([^']+)',$/gm;
  let pair;
  while ((pair = pairRe.exec(refBlockMatch[1]))) used.add(pair[2]);
  for (const usedId of used) {
    assert.ok(ids.has(usedId), 'index.html 缺少 id="' + usedId + '"');
  }
  for (const id of ['relay-grid', 'download-modal', 'loading-view', 'download-widget', 'hud-panel', 'spotlight', 'btn-protocol-7', 'server-list', 'touch-guide', 'touch-hint', 'btn-touch-fullscreen', 'btn-touch-hint-fullscreen']) {
    assert.ok(ids.has(id), '缺少关键 UI 节点 #' + id);
  }
  assert.ok(html.indexOf('lang="zh-CN"') >= 0);
  assert.ok(html.indexOf('data-device') >= 0, 'html 应带 data-device 属性');
  assert.ok(html.indexOf('keyboard-only') >= 0, '键盘提示应标记 keyboard-only（移动端隐藏）');
});

await test('文案：旧的 Esc 快捷键已全部替换为 Ctrl+`', () => {
  const legacyShortcut = 'Ctrl+' + 'Esc';
  const files = [
    'app.js', 'index.html', 'style.css', 'README.md',
    'src/shortcuts.js', 'src/device.js', 'src/connect.js',
    'tools/test-pure.mjs', 'tools/test-dom.mjs', 'tools/e2e-browser.mjs',
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(WEB_DIR, relative), 'utf8');
    assert.equal(source.indexOf(legacyShortcut), -1, relative + ' 仍包含旧的 Esc 快捷键文案');
  }
  const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  assert.ok(html.indexOf('Ctrl+`') >= 0, 'HUD 提示应写 Ctrl+`');
});

await test('DDNet master：地址解析与 0.6/0.7 协议', () => {
  assert.deepEqual(parseMasterAddress('tw-0.6+udp://5.9.82.75:8303'), { host: '5.9.82.75', port: 8303, protocol: 6 });
  assert.deepEqual(parseMasterAddress('tw-0.7+udp://example.org:8300'), { host: 'example.org', port: 8300, protocol: 7 });
  assert.deepEqual(parseMasterAddress('tw-0.6+udp://[::1]:8303'), { host: '[::1]', port: 8303, protocol: 6 });
  assert.equal(parseMasterAddress(''), null);
  assert.equal(parseMasterAddress('tw-0.6+udp://nohost'), null);
});

await test('DDNet master：服务器归一化（玩家/地图/密码/地区）', () => {
  const entry = {
    addresses: ['tw-0.7+udp://1.2.3.4:8303', 'tw-0.6+udp://1.2.3.4:8303'],
    location: 'eu:de',
    community: 'DDNet',
    info: {
      name: '  Example   Server ',
      game_type: 'DDraceNetwork',
      map: { name: 'Tutorial' },
      max_players: 64,
      passworded: true,
      version: '0.6.4',
      clients: [{ is_player: true }, { is_player: true }, { is_player: false }],
    },
  };
  const server = normalizeMasterServer(entry, 7);
  assert.equal(server.protocol, 6, '同时有 0.6/0.7 时优先 0.6');
  assert.equal(server.address, '1.2.3.4:8303');
  assert.equal(server.name, 'Example Server');
  assert.equal(server.map, 'Tutorial');
  assert.equal(server.gameType, 'DDraceNetwork');
  assert.equal(server.region, 'eu:de');
  assert.equal(server.players, 2);
  assert.equal(server.maxPlayers, 64);
  assert.equal(server.passworded, true);
  assert.equal(server.source, 'master');
  const parsed = parseMasterPayload({ servers: [entry, { addresses: [] }] });
  assert.equal(parsed.length, 1);
  const relay = normalizeRelayServers([{ name: '本地', host: '127.0.0.1', port: 8313 }]);
  assert.equal(relay[0].protocol, null, '后端推荐条目未声明协议时由默认协议决定');
});

await test('DDNet master：筛选、排序、选项', () => {
  const list = [
    { name: 'A', address: '1:1', protocol: 6, gameType: 'DDraceNetwork', region: 'eu:de', map: 'M1', players: 10, maxPlayers: 64, passworded: false },
    { name: 'B', address: '2:2', protocol: 7, gameType: 'Block', region: 'na:us', map: 'M2', players: 64, maxPlayers: 64, passworded: true },
    { name: 'C', address: '3:3', protocol: 6, gameType: 'DDraceNetwork', region: 'eu:de', map: 'Tutorial', players: 3, maxPlayers: 64, passworded: false },
  ];
  assert.deepEqual(filterServers(list, {}, 'tutorial').map((server) => server.name), ['C']);
  assert.deepEqual(filterServers(list, { type: 'ddracenetwork' }).map((server) => server.name), ['A', 'C']);
  assert.deepEqual(filterServers(list, { region: 'na:us' }).map((server) => server.name), ['B']);
  assert.deepEqual(filterServers(list, { protocol: '7' }).map((server) => server.name), ['B']);
  assert.deepEqual(filterServers(list, { hideFull: true }).map((server) => server.name), ['A', 'C']);
  assert.deepEqual(filterServers(list, { hideLocked: true }).map((server) => server.name), ['A', 'C']);
  assert.deepEqual(filterServers(list, { sort: 'name' }).map((server) => server.name), ['A', 'B', 'C']);
  assert.deepEqual(filterServers(list, { sort: 'none' }).map((server) => server.name), ['A', 'B', 'C']);
  const options = filterOptions(list);
  assert.deepEqual(options.types.map((option) => option.value), ['DDraceNetwork', 'Block']);
  assert.deepEqual(options.regions.map((option) => option.label), ['EU-DE', 'NA-US']);
});

await test('DDNet master：master1 失败时回退 master2', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ servers: [{ addresses: ['tw-0.6+udp://1.2.3.4:8303'], location: 'eu:de', info: { name: 'X', game_type: 'DDraceNetwork', map: { name: 'T' }, max_players: 8, clients: [] } }] }) };
  };
  const result = await fetchMasterServers({ fetchImpl, timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.servers.length, 1);
  assert.equal(calls.length, 2);
  const failed = await fetchMasterServers({ fetchImpl: async () => ({ ok: false, status: 503 }), timeoutMs: 10, urls: ['https://a.example/x', 'https://b.example/x'] });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /a\.example/);
});

await test('IME 文本按 UTF-8 安全分块（SDL_TEXTINPUT 32 字节上限）', () => {
  const input = '中文abc😀'.repeat(12);
  const chunks = utf8Chunks(input, 30);
  const encoder = new TextEncoder();
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), input);
  for (const chunk of chunks) assert.ok(encoder.encode(chunk).length <= 30, '块超过 30 字节：' + chunk);
});

await test('relay master：相对 base 与 URL 规范化', () => {
  assert.equal(defaultRelayMasterUrl({ location: { hostname: 'localhost', search: '' } }), '/relay-master/v1/serverlist');
  assert.equal(defaultRelayMasterUrl({ location: { hostname: 'play.example.com', search: '' } }), '/relay-master/v1/serverlist');
  assert.equal(defaultRelayMasterUrl({ location: { hostname: 'localhost', search: '?master=master.example.com' } }), 'https://master.example.com/v1/serverlist');
  assert.equal(defaultRelayMasterUrl({ location: { hostname: 'localhost', search: '?masterBase=https://master.example.com' } }), 'https://master.example.com/v1/serverlist');
  assert.equal(defaultRelayMasterUrl({ location: { hostname: 'localhost', search: '' }, DDWEB_MASTER_BASE: '/api/relay-master' }), '/api/relay-master/v1/serverlist');
  assert.equal(normalizeMasterUrl('/custom-master'), '/custom-master/v1/serverlist');
  assert.equal(normalizeMasterUrl('http://127.0.0.1:8391'), 'http://127.0.0.1:8391/v1/serverlist');
  assert.equal(normalizeMasterUrl('https://master.example.com/v1/serverlist'), 'https://master.example.com/v1/serverlist');
});

await test('relay master：解析节点列表并过滤非法条目', async () => {
  const result = await loadMasterRelays(async () => new Response(JSON.stringify({
    servers: [
      { name: 'Relay A', url: 'wss://a.example.com', region: 'EU', version: '1.0.0' },
      { name: 'Relay A duplicate', url: 'wss://a.example.com' },
      { name: 'Bad', url: '' },
    ],
  }), { status: 200 }), 'https://master.example.com/v1/serverlist');
  assert.equal(result.ok, true);
  assert.equal(result.relays.length, 1);
  assert.equal(result.relays[0].url, 'wss://a.example.com');
  assert.equal(result.relays[0].source, 'master');
  assert.match(result.relays[0].note, /EU/);
});

await test('聚光灯性能回归：不用整屏 box-shadow，画布隐藏浏览器光标', () => {
  const css = fs.readFileSync(path.join(WEB_DIR, 'style.css'), 'utf8');
  assert.ok(css.includes('.spotlight-shade'), '应使用四块遮罩');
  assert.ok(!/box-shadow:\s*0 0 0 9999px/.test(css), '不应再用 9999px box-shadow 覆盖 WebGL 画布');
  assert.match(css, /#canvas[\s\S]{0,400}cursor:\s*none/, '画布上应隐藏浏览器光标，由 DDNet 绘制游戏内光标');
  const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  assert.equal((html.match(/class="spotlight-shade"/g) || []).length, 4, '聚光灯应有 4 块遮罩');
});

await test('所有相对 import 目标存在', () => {
  const files = ['app.js'];
  for (const name of fs.readdirSync(path.join(WEB_DIR, 'src'))) {
    if (name.endsWith('.js')) files.push(path.join('src', name));
  }
  for (const relative of files) {
    const file = path.join(WEB_DIR, relative);
    const source = fs.readFileSync(file, 'utf8');
    const importRe = /from\s+'(\.{1,2}\/[^']+)'/g;
    let match;
    while ((match = importRe.exec(source))) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      assert.ok(fs.existsSync(resolved), relative + ' 引用了不存在的模块 ' + match[1]);
    }
  }
});

await test('交付文件齐全', () => {
  for (const relative of [
    'index.html', 'style.css', 'app.js', 'serve.mjs', 'README.md',
    'src/assets.js', 'src/latency.js', 'src/tour.js', 'src/shortcuts.js', 'src/device.js', 'src/connect.js', 'src/master.js',
    'tools/dom-shim.mjs', 'tools/fake-relay.mjs', 'tools/test-assets.mjs', 'tools/test-latency.mjs',
  ]) {
    assert.ok(fs.existsSync(path.join(WEB_DIR, relative)), '缺少 ' + relative);
  }
});

console.log('');
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : ''));
process.exit(failed ? 1 : 0);
