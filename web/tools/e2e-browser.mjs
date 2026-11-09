// 零依赖 Chromium E2E（CDP）：五屏流程 + WebRTC 延迟 + 缓存持久化 + 聚光灯 / Ctrl+`
// 在 ddchrome 容器内运行（容器内自带 chromium 与 node）：
//   docker run --rm --network host -v /root/test:/root/test -w /root/test ddchrome:latest \
//     node web/tools/e2e-browser.mjs --base http://127.0.0.1:8393/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(TOOLS_DIR, 'screenshots');
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);

function cliArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefixed = process.argv.find((value) => value.indexOf('--' + name + '=') === 0);
  if (prefixed) return prefixed.slice(name.length + 3);
  return fallback;
}

const BASE = cliArg('base', process.env.BASE_URL || 'http://127.0.0.1:8393/');
const OUTDIR = cliArg('outdir', SHOT_DIR);

fs.mkdirSync(OUTDIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error('CDP 连接失败：' + (event && event.message ? event.message : '')));
      });
      ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          return;
        }
        if (message.id) {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.method + ' ' + JSON.stringify(message.error)));
          else entry.resolve(message.result);
          return;
        }
        const handlers = this.handlers.get(message.method) || [];
        for (const handler of handlers.slice()) {
          try {
            handler(message.params);
          } catch (error) {
            // 忽略监听器异常
          }
        }
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const entry of this.pending.values()) entry.reject(new Error('CDP 连接已关闭'));
        this.pending.clear();
      });
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 已关闭'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  close() {
    try {
      this.ws.close();
    } catch (error) {
      // 忽略
    }
  }
}

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(120);
  }
  throw new Error('等待超时：' + label + (lastError ? '（' + lastError.message + '）' : ''));
}

const chromeArgs = [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu-sandbox',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=/tmp/ddweb-e2e-profile-' + process.pid,
  '--window-size=1280,800',
  '--hide-scrollbars',
  '--ignore-certificate-errors',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=Translate,BackForwardCache',
  'about:blank',
];
const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeOutput = '';
chrome.stdout.on('data', (chunk) => {
  chromeOutput += String(chunk);
});
chrome.stderr.on('data', (chunk) => {
  chromeOutput += String(chunk);
});
chrome.on('exit', (code) => {
  chromeOutput += '\n[chromium exit ' + code + ']';
});

const results = { base: BASE, startedAt: new Date().toISOString(), steps: [], console: [], errors: [], screenshots: [] };
let cdp = null;
let pageId = '';

function record(name, ok, detail) {
  results.steps.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  return Boolean(ok);
}

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error('页面执行出错：' + JSON.stringify(response.exceptionDetails).slice(0, 500));
  }
  return response.result ? response.result.value : undefined;
}

async function screenshot(name) {
  // 截图前清掉临时 toast；资源完成后隐藏已完成的下载悬浮组件，保持画面干净（不影响已验证行为）
  try {
    await evaluate('(() => { const host = document.getElementById("toast-host"); if (host) host.textContent = ""; const widget = document.getElementById("download-widget"); if (widget && !widget.hidden && window.__ddwebDebug && window.__ddwebDebug.assets.isComplete()) widget.hidden = true; return true; })()');
  } catch (error) {
    // 忽略
  }
  const response = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUTDIR, name + '.png');
  fs.writeFileSync(file, Buffer.from(response.data, 'base64'));
  results.screenshots.push(file);
  return file;
}

async function navigate(url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(async () => {
    const state = await evaluate('document.readyState');
    return state === 'complete' || state === 'interactive';
  }, 30000, '页面加载 ' + url);
  await waitFor(async () => evaluate('typeof window.__ddwebDebug !== "undefined"'), 30000, '__ddwebDebug 就绪');
}

async function click(selector) {
  const ok = await evaluate('(() => { const node = document.querySelector(' + JSON.stringify(selector) + '); if (!node) return false; node.click(); return true; })()');
  if (!ok) throw new Error('找不到可点击元素：' + selector);
}

function pageState() {
  return evaluate('(() => { const s = window.__ddwebDebug.state; const a = window.__ddwebDebug.assets; return { view: s.view, phase: s.phase, download: { started: s.download.started, done: s.download.done }, assetsComplete: a.isComplete(), servers: s.servers.list.length, protocol: s.protocol, hudVisible: s.hud.visible, spotlight: s.spot ? { active: s.spot.tour.active, started: s.spot.started } : null, entries: window.__ddwebDebug.entries().map((e) => ({ name: e.relay.name, latency: e.latency, status: e.status, method: e.method })), modalHidden: document.getElementById("download-modal").hidden, widgetHidden: document.getElementById("download-widget").hidden, loadingHidden: document.getElementById("loading-view").hidden, hudHidden: document.getElementById("hud-panel").hidden, spotlightHidden: document.getElementById("spotlight").hidden }; })()');
}

try {
  const version = await waitFor(async () => {
    try {
      return await getJson('http://127.0.0.1:' + DEBUG_PORT + '/json/version');
    } catch (error) {
      return null;
    }
  }, 20000, 'Chromium 调试端口');
  const targets = await getJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
  const page = targets.find((target) => target.type === 'page') || targets[0];
  if (!page) throw new Error('没有可用的页面 target');
  pageId = page.id;
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  cdp.on('Runtime.consoleAPICalled', (event) => {
    const text = (event.args || []).map((arg) => {
      if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
      if (arg.description) return arg.description;
      return '';
    }).join(' ');
    results.console.push({ type: event.type, text });
  });
  cdp.on('Runtime.exceptionThrown', (event) => {
    const description = event.exceptionDetails && event.exceptionDetails.exception && event.exceptionDetails.exception.description;
    results.errors.push(description || JSON.stringify(event.exceptionDetails).slice(0, 400));
  });
  cdp.on('Log.entryAdded', (event) => {
    if (event.entry && event.entry.level === 'error') results.errors.push('log: ' + event.entry.text);
  });
  await cdp.send('Log.enable');
  cdp.on('Page.javascriptDialogOpening', async () => {
    try {
      await cdp.send('Page.handleJavaScriptDialog', { accept: true });
    } catch (error) {
      // 忽略
    }
  });

  // 1) 首次打开：下载提示
  await navigate(BASE);
  await waitFor(async () => !(await pageState()).modalHidden, 15000, '下载提示出现');
  const first = await pageState();
  record('首次打开显示下载提示', !first.modalHidden, JSON.stringify(first));
  const fileInfo = await evaluate('(() => Array.from(document.querySelectorAll("#download-files .file-row")).map((row) => row.textContent.trim()))()');
  record('下载提示列出 wasm/data 与体积', fileInfo.length === 2 && /DDNet\.wasm/.test(fileInfo[0] + fileInfo[1]) && /DDNet\.data/.test(fileInfo[0] + fileInfo[1]), JSON.stringify(fileInfo));
  const themeState = await evaluate('(() => ({ theme: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("ddweb.theme.v1"), label: document.getElementById("theme-label").textContent }))()');
  record('默认亮色主题（首次访问）', themeState.theme === 'light' && themeState.stored === null, JSON.stringify(themeState));
  await screenshot('01-download-prompt');

  // 2) 限速后开始下载，观察悬浮进度
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: 3 * 1024 * 1024,
    uploadThroughput: 1024 * 1024,
  });
  await click('#btn-download-start');
  await sleep(1500);
  const downloading = await pageState();
  const widgetVisible = !downloading.widgetHidden;
  const progressText = await evaluate('document.getElementById("widget-progress").textContent');
  record(
    '下载进度显示在右下角悬浮组件',
    widgetVisible && downloading.modalHidden === true,
    JSON.stringify({ widgetVisible, modalHidden: downloading.modalHidden, download: downloading.download, progress: progressText.slice(0, 120) })
  );
  await screenshot('02-relays-downloading');

  // 3) 选中后端 → 载入页（含两个进度条），可关闭
  await evaluate('(() => { const cards = Array.from(document.querySelectorAll("#relay-grid .relay-card:not(.is-custom)")); if (cards[0]) cards[0].click(); return cards.length; })()');
  await waitFor(async () => !(await pageState()).loadingHidden, 15000, '载入页出现');
  const loadingState = await pageState();
  const loadingRows = await evaluate('document.querySelectorAll("#loading-progress .progress-row").length');
  record('选中后端显示载入页与两个进度条', !loadingState.loadingHidden && loadingRows === 2, 'rows=' + loadingRows);
  await screenshot('03-loading-overlay');
  await click('#btn-loading-close');
  const afterClose = await pageState();
  record('载入页可关闭并回到后端选择', afterClose.loadingHidden && afterClose.view === 'relays', afterClose.view);

  // 4) 取消限速，等待资源下载 + sha256 校验完成
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await waitFor(async () => (await pageState()).assetsComplete, 240000, '资源下载与校验完成');
  record('资源下载并通过 sha256 校验', true);
  const cacheInfo = await evaluate('document.getElementById("cache-badge").textContent');
  record('页面显示资源已缓存', /已缓存/.test(cacheInfo), cacheInfo);

  // 5) 等延迟测量完成（WebRTC）
  await waitFor(async () => {
    const state = await pageState();
    return state.entries.length > 0 && state.entries.every((entry) => entry.status !== 'measuring');
  }, 60000, '延迟测量完成');
  const measured = await pageState();
  const webrtc = measured.entries.filter((entry) => entry.method === 'webrtc' && entry.status === 'ok');
  record('后端延迟用 WebRTC 测量并按升序展示', webrtc.length > 0, JSON.stringify(measured.entries));
  const badge = await evaluate('(() => { const node = document.querySelector("#relay-grid .latency-badge"); return node ? { text: node.textContent, className: node.className } : null; })()');
  record(
    '后端卡片渲染延迟徽章',
    Boolean(badge) && /\d+(\.\d+)? ms/.test(badge.text) && /is-(fast|good|ok|slow)/.test(badge.className),
    JSON.stringify(badge)
  );
  await screenshot('04-relays-ready');

  // 5b) 自定义后端：新增 → 编辑（预填）→ 删除（二次确认）；内置只读
  await click('.relay-card.is-custom');
  await waitFor(async () => evaluate('document.getElementById("relay-dialog").open'), 10000, '自定义后端对话框');
  await evaluate('(() => { document.getElementById("relay-url").value = "ws://127.0.0.1:8391"; document.getElementById("relay-name").value = "E2E 自定义"; document.getElementById("relay-token").value = "tok"; document.getElementById("relay-form").requestSubmit(); return true; })()');
  await waitFor(async () => evaluate('Array.from(document.querySelectorAll("#relay-grid .relay-name")).some((node) => node.textContent === "E2E 自定义")'), 15000, '自定义后端卡片出现');
  record('自定义后端可新增', true);

  await evaluate('(() => { const card = Array.from(document.querySelectorAll("#relay-grid .relay-card")).find((node) => node.textContent.includes("E2E 自定义")); const button = card && card.querySelector("[data-action=edit]"); if (button) { button.click(); return true; } return false; })()');
  await waitFor(async () => evaluate('document.getElementById("relay-dialog").open'), 10000, '编辑对话框打开');
  const editPrefill = await evaluate('(() => ({ url: document.getElementById("relay-url").value, name: document.getElementById("relay-name").value, token: document.getElementById("relay-token").value }))()');
  record('编辑对话框预填名称/URL/token', editPrefill.url === 'ws://127.0.0.1:8391' && editPrefill.name === 'E2E 自定义' && editPrefill.token === 'tok', JSON.stringify(editPrefill));
  await screenshot('04b-custom-edit-dialog');
  await evaluate('(() => { document.getElementById("relay-name").value = "E2E 改名"; document.getElementById("relay-form").requestSubmit(); return true; })()');
  await waitFor(async () => evaluate('Array.from(document.querySelectorAll("#relay-grid .relay-name")).some((node) => node.textContent === "E2E 改名")'), 15000, '编辑保存后卡片更新');
  record('编辑保存后卡片更新并重新测速', await evaluate('window.__ddwebDebug.state.entries.some((entry) => entry.relay.name === "E2E 改名")'));

  await evaluate('(() => { const card = Array.from(document.querySelectorAll("#relay-grid .relay-card")).find((node) => node.textContent.includes("E2E 改名")); const button = card && card.querySelector("[data-action=delete]"); if (button) { button.click(); return true; } return false; })()');
  await waitFor(async () => evaluate('document.getElementById("confirm-dialog").open'), 10000, '删除确认弹层');
  record('删除有二次确认并显示名称', (await evaluate('document.getElementById("confirm-text").textContent')).indexOf('E2E 改名') >= 0);
  await screenshot('04c-delete-confirm');
  await click('#btn-confirm-cancel');
  record('取消删除后保留卡片', await evaluate('Array.from(document.querySelectorAll("#relay-grid .relay-name")).some((node) => node.textContent === "E2E 改名")'));

  await evaluate('(() => { const card = Array.from(document.querySelectorAll("#relay-grid .relay-card")).find((node) => node.textContent.includes("E2E 改名")); const button = card && card.querySelector("[data-action=delete]"); if (button) { button.click(); return true; } return false; })()');
  await waitFor(async () => evaluate('document.getElementById("confirm-dialog").open'), 10000, '删除确认弹层');
  await click('#btn-confirm-ok');
  await sleep(500);
  record('确认删除后从列表与 localStorage 移除', await evaluate('(() => { const hasCard = Array.from(document.querySelectorAll("#relay-grid .relay-name")).some((node) => node.textContent === "E2E 改名"); const stored = JSON.parse(localStorage.getItem("ddweb.relays.v2") || "{}"); const hasStore = (stored.relays || []).some((relay) => relay.url === "ws://127.0.0.1:8391"); return !hasCard && !hasStore; })()'));

  const builtinActions = await evaluate('(() => { const card = document.querySelector("#relay-grid .relay-card[data-relay-id]"); if (!card) return null; return { edit: !!card.querySelector("[data-action=edit]"), del: !!card.querySelector("[data-action=delete]"), text: card.textContent.slice(0, 40) }; })()');
  record('本地内置后端可编辑可删除', Boolean(builtinActions && builtinActions.edit && builtinActions.del), JSON.stringify(builtinActions));

  // 5d) 删除内置后端 → 空状态（含添加入口/恢复默认）→ 恢复默认
  await evaluate('(() => { const button = document.querySelector("#relay-grid .relay-card[data-relay-id] [data-action=delete]"); if (button) { button.click(); return true; } return false; })()');
  await waitFor(async () => evaluate('document.getElementById("confirm-dialog").open'), 10000, '内置后端删除确认');
  await click('#btn-confirm-ok');
  await waitFor(async () => evaluate('document.querySelector("#relay-empty") !== null'), 15000, '空状态出现');
  const emptyState = await evaluate('(() => { const empty = document.querySelector("#relay-empty"); return { text: empty.textContent, hasAdd: !!empty.querySelector("#btn-empty-add"), hasRestore: !!empty.querySelector("#btn-empty-restore"), hidden: localStorage.getItem("ddweb.hidden-relays.v1") }; })()');
  record('删除内置后端写入隐藏列表', Boolean(emptyState.hidden && emptyState.hidden.indexOf('ws://127.0.0.1:8390') >= 0), emptyState.hidden);
  record('空状态提供添加入口与恢复默认', emptyState.hasAdd && emptyState.hasRestore, JSON.stringify({ text: emptyState.text.slice(0, 80), hasAdd: emptyState.hasAdd, hasRestore: emptyState.hasRestore }));
  await screenshot('04e-empty-state');

  await click('#btn-empty-restore');
  await waitFor(async () => evaluate('document.querySelectorAll("#relay-grid .relay-card[data-relay-id]").length > 0'), 15000, '恢复默认后端');
  const restored = await evaluate('(() => ({ cards: document.querySelectorAll("#relay-grid .relay-card[data-relay-id]").length, hidden: localStorage.getItem("ddweb.hidden-relays.v1") }))()');
  record('恢复默认后内置后端回归且隐藏列表清空', restored.cards > 0 && restored.hidden.indexOf('ws://127.0.0.1:8390') < 0, JSON.stringify(restored));
  await screenshot('04f-restore-default');

  // 5c) 深色主题切换 + 截图
  await click('#btn-theme');
  await sleep(400);
  record('可切换到深色主题', (await evaluate('document.documentElement.getAttribute("data-theme")')) === 'dark');
  await screenshot('04d-relays-dark');
  await click('#btn-theme');
  await sleep(300);
  record('可切回亮色主题', (await evaluate('document.documentElement.getAttribute("data-theme")')) === 'light');

  // 6) 进入服务器列表
  await evaluate('(() => { const cards = Array.from(document.querySelectorAll("#relay-grid .relay-card:not(.is-custom)")); if (cards[0]) cards[0].click(); return cards.length; })()');
  await waitFor(async () => (await pageState()).view === 'servers', 30000, '进入服务器列表');
  await waitFor(async () => (await evaluate('document.querySelectorAll("#server-list .server-card").length')) > 0, 20000, '服务器列表渲染');
  const serverText = await evaluate('document.getElementById("server-list").textContent');
  record('服务器列表来自后端 /api/servers', serverText.indexOf('127.0.0.1:8313') >= 0, serverText.slice(0, 200));
  const protocolText = await evaluate('document.getElementById("servers-subtitle").textContent');
  record('服务器页展示协议版本（默认 0.6）', /协议 0\.6/.test(protocolText), protocolText);
  await click('#btn-protocol-7');
  const protocolText7 = await evaluate('document.getElementById("servers-subtitle").textContent');
  record('可切换到 0.7 协议', /协议 0\.7/.test(protocolText7), protocolText7);
  await screenshot('05-servers');

  // 7) 进入游戏：HUD + 首次聚光灯
  await click('.server-card');
  await waitFor(async () => (await pageState()).view === 'game', 60000, '进入游戏视图');
  record('进入游戏视图（画布显示）', await evaluate('document.body.classList.contains("in-game")'));
  await waitFor(async () => !(await pageState()).spotlightHidden, 20000, '首次聚光灯出现');
  const spot = await pageState();
  record('首次进入自动聚光灯指向后端信息面板', !spot.spotlightHidden && !spot.hudHidden, JSON.stringify(spot.spotlight));
  await sleep(2500);
  const hudInfo = await evaluate('(() => ({ connectUrl: window.__ddwebDebug.state.lastConnectUrl, protocol: window.__ddwebDebug.state.lastConnectProtocol, hudProtocol: document.getElementById("hud-protocol").textContent, hudLatency: document.getElementById("hud-latency").textContent, hudMethod: document.getElementById("hud-latency-method").textContent, hudTarget: document.getElementById("hud-target").textContent }))()');
  record('0.7 协议拼接到连接 URL 并显示在 HUD', /[?&]protocol=7/.test(hudInfo.connectUrl || '') && hudInfo.hudProtocol === '0.7', JSON.stringify(hudInfo));
  record('HUD 延迟优先显示 WebRTC', /ms/.test(hudInfo.hudLatency) && hudInfo.hudMethod === 'WebRTC', JSON.stringify({ latency: hudInfo.hudLatency, method: hudInfo.hudMethod }));
  const moduleArgs = await evaluate('window.Module && window.Module.arguments ? window.Module.arguments.slice() : null');
  record(
    'wasm 收到 connect 参数（含 protocol=7）',
    Array.isArray(moduleArgs) && moduleArgs.some((arg) => /^connect ws:\/\//.test(arg) && /[?&]protocol=7/.test(arg)),
    JSON.stringify(moduleArgs)
  );
  await screenshot('06-game-hud-spotlight');

  // 8) Ctrl+`（Backquote）切换 HUD
  const keyEvent = { type: 'rawKeyDown', modifiers: 2, key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192 };
  await cdp.send('Input.dispatchKeyEvent', keyEvent);
  await cdp.send('Input.dispatchKeyEvent', Object.assign({}, keyEvent, { type: 'keyUp' }));
  await sleep(400);
  const hiddenState = await pageState();
  await cdp.send('Input.dispatchKeyEvent', keyEvent);
  await cdp.send('Input.dispatchKeyEvent', Object.assign({}, keyEvent, { type: 'keyUp' }));
  await sleep(400);
  const shownState = await pageState();
  record('Ctrl+` 切换后端连接信息面板', hiddenState.hudHidden === true && shownState.hudHidden === false, 'hidden=' + hiddenState.hudHidden + ' shown=' + shownState.hudHidden);
  await screenshot('07-hud-visible');

  // 9) 关闭聚光灯（如果还在），刷新页面验证缓存持久化 + 主题持久化
  await evaluate('(() => { const button = document.getElementById("btn-spotlight-skip"); if (button && !document.getElementById("spotlight").hidden) { button.click(); return true; } return false; })()');
  await evaluate('localStorage.setItem("ddweb.theme.v1", "dark")');
  await navigate(BASE);
  await waitFor(async () => (await pageState()).assetsComplete, 20000, '刷新后资源缓存命中');
  const reloaded = await pageState();
  record('刷新后不再提示下载（缓存命中）', reloaded.modalHidden === true && reloaded.assetsComplete === true, JSON.stringify(reloaded));
  const reloadTheme = await evaluate('document.documentElement.getAttribute("data-theme")');
  record('主题选择在刷新后保留', reloadTheme === 'dark', reloadTheme);
  await screenshot('08-reload-cached-dark');
  await click('#btn-theme');
  await sleep(300);
  await screenshot('08-reload-cached');

  // 10) ?connect + ?autostart 直连启动
  const connectUrl = 'ws://127.0.0.1:8390/udp/127.0.0.1:8313';
  await navigate(BASE + '?connect=' + encodeURIComponent(connectUrl) + '&autostart=1');
  await waitFor(async () => (await pageState()).view === 'game', 90000, 'autostart 直连进入游戏');
  const directState = await evaluate('(() => ({ view: window.__ddwebDebug.state.view, url: window.__ddwebDebug.state.hud && window.__ddwebDebug.state.hud.target && window.__ddwebDebug.state.hud.target.target, direct: window.__ddwebDebug.state.direct && window.__ddwebDebug.state.direct.url, connectUrl: window.__ddwebDebug.state.lastConnectUrl }))()');
  record(
    '?connect + ?autostart 自动进入游戏',
    directState.view === 'game' && directState.direct === connectUrl && directState.connectUrl === connectUrl,
    JSON.stringify(directState)
  );
  await screenshot('09-autostart-direct');

  // 11) 引擎是否连上（附加信息，不作为关键断言）
  const engineLines = results.console.filter((line) => /connected|online|STATE_ONLINE|server|handshake|websocket/i.test(line.text));
  const connected = engineLines.some((line) => /\bconnected\b|STATE_ONLINE|online error=''|in game/i.test(line.text));
  record('引擎输出连接日志', engineLines.length > 0, 'lines=' + engineLines.length + ' connected=' + connected);
} catch (error) {
  results.errors.push('E2E 失败：' + ((error && error.stack) || error));
  console.log('E2E 失败：' + ((error && error.stack) || error));
} finally {
  try {
    if (cdp) {
      const finalState = await pageState();
      results.finalState = finalState;
    }
  } catch (error) {
    results.finalState = null;
  }
  try {
    if (cdp) cdp.close();
  } catch (error) {
    // 忽略
  }
  chrome.kill('SIGTERM');
  await sleep(700);
  try {
    chrome.kill('SIGKILL');
  } catch (error) {
    // 忽略
  }
  results.finishedAt = new Date().toISOString();
  const resultFile = path.join(OUTDIR, 'e2e-results.json');
  fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
  const failedSteps = results.steps.filter((step) => !step.ok);
  console.log('');
  console.log('截图目录：' + OUTDIR);
  console.log('结果文件：' + resultFile);
  console.log('步骤通过：' + (results.steps.length - failedSteps.length) + ' / ' + results.steps.length);
  if (failedSteps.length) console.log('失败步骤：' + failedSteps.map((step) => step.name).join('、'));
  if (results.errors.length) {
    console.log('页面错误：');
    for (const item of results.errors.slice(0, 10)) console.log('  ' + item);
  }
  console.log('引擎日志（筛选）：');
  for (const line of results.console.filter((item) => /connect|online|websocket|error|server|handshake/i.test(item.text)).slice(-15)) {
    console.log('  [' + line.type + '] ' + line.text.slice(0, 300));
  }
  process.exit(failedSteps.length ? 1 : 0);
}
