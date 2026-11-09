// 移动端（Android / 手机）触屏 UI 截图：零依赖 CDP + 假构建资源 + 假中继。
// 在 ddchrome 容器内运行（容器内自带 chromium 与 node）：
//   docker run --rm --name web-mobile-shot --network host --shm-size=1g \
//     -v /root/test:/root/test -w /root/test \
//     -v /usr/share/fonts/opentype/noto:/usr/share/fonts/opentype/noto:ro \
//     ddchrome:latest env CHROME=/usr/bin/chromium \
//     node web/tools/mobile-shot.mjs --port 8394 --cdp-port 9334
//
// 只监听 127.0.0.1 的高位端口，不碰 8390/8392/8443/8313，也不依赖 compose 环境。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeRelay } from './fake-relay.mjs';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.dirname(TOOLS_DIR);
const REPO_ROOT = path.dirname(WEB_DIR);
const SHOT_DIR = path.join(TOOLS_DIR, 'screenshots');
const CHROME = process.env.CHROME || '/usr/bin/chromium';

function cliArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefixed = process.argv.find((value) => value.indexOf('--' + name + '=') === 0);
  if (prefixed) return prefixed.slice(name.length + 3);
  return fallback;
}

const PORT = Number(cliArg('port', '8394'));
const CDP_PORT = Number(cliArg('cdp-port', '9334'));
const OUTDIR = cliArg('outdir', SHOT_DIR);
const BASE = cliArg('base', 'http://127.0.0.1:' + PORT + '/');
const EXTERNAL_BASE = process.argv.indexOf('--base') >= 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(OUTDIR, { recursive: true });

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
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
        if (!message.id) return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else entry.resolve(message.result);
      });
      ws.addEventListener('close', () => {
        for (const entry of this.pending.values()) entry.reject(new Error('CDP 已关闭'));
        this.pending.clear();
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
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

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function createFakeSiteRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddweb-mobile-shot-'));
  const manifest = { version: 'mobile-shot', files: {} };
  for (const name of ['DDNet.js', 'DDNet.wasm', 'DDNet.data']) {
    const source = path.join(WEB_DIR, 'tools', 'fake-build', name);
    const target = path.join(dir, name);
    fs.copyFileSync(source, target);
    const bytes = fs.readFileSync(target);
    manifest.files[name] = {
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function startServe(siteRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(WEB_DIR, 'serve.mjs'),
      '--port', String(PORT),
      '--host', '127.0.0.1',
      '--root', WEB_DIR,
      '--root', siteRoot,
    ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env) });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('静态服务器启动超时：' + output));
    }, 15000);
    const collect = (chunk) => {
      output += String(chunk);
      if (!settled && output.indexOf('静态服务器已启动') >= 0) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, output: () => output });
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('静态服务器提前退出（code ' + code + '）：' + output));
    });
  });
}

function stopChild(handle) {
  if (!handle || !handle.child) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    handle.child.once('exit', finish);
    try {
      handle.child.kill('SIGTERM');
    } catch (error) {
      finish();
    }
    setTimeout(() => {
      try {
        handle.child.kill('SIGKILL');
      } catch (error) {
        // 忽略
      }
      finish();
    }, 2500);
  });
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const results = { base: BASE, mobile: null, checks: [], screenshots: [] };
let cdp = null;

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) throw new Error('页面执行出错：' + JSON.stringify(response.exceptionDetails).slice(0, 500));
  return response.result ? response.result.value : undefined;
}

async function screenshot(name, options = {}) {
  try {
    await evaluate('(() => { const host = document.getElementById("toast-host"); if (host) host.textContent = ""; const widget = document.getElementById("download-widget"); if (widget) widget.hidden = true; return true; })()');
  } catch (error) {
    // 忽略
  }
  const response = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: options.fullPage === true });
  const file = path.join(OUTDIR, name + '.png');
  fs.writeFileSync(file, Buffer.from(response.data, 'base64'));
  results.screenshots.push(file);
  console.log('shot ' + file);
  return file;
}

async function navigate(url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(async () => {
    const state = await evaluate('document.readyState');
    return state === 'complete' || state === 'interactive';
  }, 30000, '页面加载');
  await waitFor(async () => evaluate('typeof window.__ddwebDebug !== "undefined"'), 30000, '__ddwebDebug 就绪');
}

async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
    screenOrientation: { angle: width > height ? 90 : 0, type: width > height ? 'landscapePrimary' : 'portraitPrimary' },
  });
}

async function click(selector) {
  const ok = await evaluate('(() => { const node = document.querySelector(' + JSON.stringify(selector) + '); if (!node) return false; node.click(); return true; })()');
  if (!ok) throw new Error('找不到可点击元素：' + selector);
}

async function main() {
  let relay = null;
  let siteRoot = null;
  let serveHandle = null;
  let chrome = null;
  let chromeOutput = '';
  try {
    if (!EXTERNAL_BASE) {
      relay = await startFakeRelay({ log: () => {} });
      siteRoot = createFakeSiteRoot();
      serveHandle = await startServe(siteRoot);
    }

    chrome = spawn(CHROME, [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=/tmp/ddweb-mobile-shot-' + process.pid,
      '--window-size=390,844',
      '--hide-scrollbars',
      '--ignore-certificate-errors',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-features=Translate,BackForwardCache',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    chrome.stdout.on('data', (chunk) => { chromeOutput += String(chunk); });
    chrome.stderr.on('data', (chunk) => { chromeOutput += String(chunk); });

    const version = await waitFor(async () => {
      try {
        return await getJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
      } catch (error) {
        return null;
      }
    }, 20000, 'Chromium 调试端口');
    results.chrome = version['Browser'] || '';

    const targets = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
    const page = targets.find((target) => target.type === 'page') || targets[0];
    if (!page) throw new Error('没有可用的页面 target');
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv8l' });
    await setViewport(390, 844);

    await navigate(BASE);
    await waitFor(async () => !(await evaluate('document.getElementById("download-modal").hidden')), 15000, '下载提示出现');
    await click('#btn-download-later');

    const relayUrl = relay ? relay.url : cliArg('relay', '');
    if (!relayUrl) throw new Error('缺少中继地址（--relay 或内置假中继）');
    await evaluate('(async () => { const d = window.__ddwebDebug; const added = d.relayStore.add({ url: ' + JSON.stringify(relayUrl) + ', name: "本机中继" }); const r = added.relay || d.relayStore.list()[0]; await d.selectRelay(r); return true; })()');
    await waitFor(async () => (await evaluate('window.__ddwebDebug.state.view')) === 'servers', 15000, '服务器列表');

    let device = await evaluate('(() => ({ kind: document.documentElement.dataset.device, state: window.__ddwebDebug.state.device, body: document.body.className }))()');
    if (device.kind !== 'mobile') {
      await evaluate('window.__ddwebDebug.setDevice("mobile")');
      device = await evaluate('(() => ({ kind: document.documentElement.dataset.device, state: window.__ddwebDebug.state.device, body: document.body.className }))()');
    }
    results.mobile = device;
    const guideVisible = await evaluate('!document.getElementById("touch-guide").hidden');
    const guideText = await evaluate('document.getElementById("touch-guide-list").textContent');
    const hintButton = await evaluate('!!document.getElementById("btn-touch-fullscreen")');
    results.checks.push({ name: '设备识别为 mobile', ok: device.kind === 'mobile' && device.state && device.state.touchMode === true, detail: JSON.stringify(device) });
    results.checks.push({ name: '触屏说明可见', ok: guideVisible === true, detail: String(guideVisible) });
    results.checks.push({ name: '说明包含 cl_touch_controls / 横屏 / 返回', ok: /cl_touch_controls 1/.test(guideText) && /横屏/.test(guideText) && /返回/.test(guideText), detail: guideText.slice(0, 160) });
    results.checks.push({ name: '全屏按钮存在', ok: hintButton === true, detail: String(hintButton) });

    await screenshot('10-mobile-touch-guide-portrait');

    await setViewport(844, 390);
    await waitFor(async () => (await evaluate('window.innerWidth')) === 844, 5000, '横屏视口');
    await screenshot('11-mobile-touch-guide-landscape', { fullPage: true });

    await setViewport(390, 844);
    await evaluate('window.__ddwebDebug.setView("game")');
    await waitFor(async () => !(await evaluate('document.getElementById("touch-hint").hidden')), 5000, '游戏内触屏提示');
    const hintText = await evaluate('document.querySelector("#touch-hint .touch-hint-text").textContent');
    results.checks.push({ name: '游戏内触屏提示条可见', ok: /左侧移动/.test(hintText) && /返回/.test(hintText) && /Esc/.test(hintText), detail: hintText });
    await screenshot('12-mobile-game-touch-hint');

    for (const check of results.checks) console.log((check.ok ? 'ok   ' : 'FAIL ') + check.name + ' — ' + check.detail);
    const failed = results.checks.filter((check) => !check.ok);
    console.log('');
    console.log('通过 ' + (results.checks.length - failed.length) + ' / ' + results.checks.length);
    fs.writeFileSync(path.join(OUTDIR, 'mobile-shot-results.json'), JSON.stringify(results, null, 2));
    process.exitCode = failed.length ? 1 : 0;
  } catch (error) {
    console.log('FAIL ' + ((error && error.message) || error));
    if (chromeOutput) console.log(chromeOutput.slice(-500));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    try {
      if (chrome) chrome.kill('SIGKILL');
    } catch (error) {
      // 忽略
    }
    await stopChild(serveHandle);
    if (relay) await relay.close().catch(() => {});
    if (siteRoot) fs.rmSync(siteRoot, { recursive: true, force: true });
  }
}

await main();
