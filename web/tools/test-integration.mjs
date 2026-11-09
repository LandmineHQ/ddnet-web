// 集成测试：假中继（/api/info、/rtc/offer token、ws 回显）+ serve.mjs（多根目录、COOP/COEP、manifest、资源下载校验）
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startFakeRelay } from './fake-relay.mjs';
import { fetchServers, probeRelay } from '../src/probe.js';
import { fetchRelayInfo, measureRelayLatency, measureWebRtcRtt } from '../src/latency.js';
import { createAssetManager, sha256Hex } from '../src/assets.js';
import { buildConnectTarget } from '../src/connect.js';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.dirname(TOOLS_DIR);
const REPO_ROOT = path.dirname(WEB_DIR);
const SERVE = path.join(WEB_DIR, 'serve.mjs');

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

const PORT = await findFreePort();
const BASE = 'http://127.0.0.1:' + PORT + '/';

let passed = 0;
let failed = 0;

async function test(name, fn, timeoutMs = 20000) {
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

function startServer(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVE, ...args], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env),
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('服务器启动超时：' + output));
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
      reject(new Error('服务器提前退出（code ' + code + '）：' + output));
    });
  });
}

function stopServer(handle) {
  return new Promise((resolve) => {
    const child = handle.child;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        // 忽略
      }
      finish();
    }, 2500);
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

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
    };
  }
  return {
    async open(name) {
      if (!caches.has(name)) caches.set(name, makeCache());
      return caches.get(name);
    },
    async keys() {
      return Array.from(caches.keys());
    },
    async delete(name) {
      return caches.delete(name);
    },
  };
}

class FakeDataChannel {
  constructor() {
    this.readyState = 'open';
    this.listeners = {};
  }
  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }
  removeEventListener() {}
  send(payload) {
    setTimeout(() => {
      for (const handler of (this.listeners.message || []).slice()) handler({ data: payload });
    }, 1);
  }
  close() {}
}

class FakePeerConnection {
  constructor() {
    this.iceGatheringState = 'complete';
    this.localDescription = null;
    this.channel = new FakeDataChannel();
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 itest offer' };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription() {
    this.channel.readyState = 'open';
    for (const handler of (this.channel.listeners.open || []).slice()) handler({});
  }
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// ---------------------------------------------------------------- 准备临时站点根目录

const TMP = path.join('/tmp', 'ddweb-itest-' + process.pid);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const manifest = { version: 'itest-v1', files: {} };
for (const name of ['DDNet.js', 'DDNet.wasm', 'DDNet.data']) {
  const source = path.join(WEB_DIR, 'tools', 'fake-build', name);
  const target = path.join(TMP, name);
  fs.copyFileSync(source, target);
  const bytes = fs.readFileSync(target);
  manifest.files[name] = {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}
fs.writeFileSync(path.join(TMP, 'manifest.json'), JSON.stringify(manifest, null, 2));

const fakeRelay = await startFakeRelay({ log: () => {} });
const server = await startServer(['--port', String(PORT), '--host', '127.0.0.1', '--root', WEB_DIR, '--root', TMP]);

try {
  await test('假中继 /api/info 与 fetchRelayInfo', async () => {
    const result = await fetchRelayInfo({ url: fakeRelay.url, name: '本地' });
    assert.equal(result.ok, true);
    assert.equal(result.info.name, '测试中继');
    assert.equal(result.info.region, 'LOCAL');
    assert.equal(result.info.players, 3);
    assert.equal(result.info.recommended, true);
  });

  await test('假中继 /api/servers 与测活回退（ws 握手）', async () => {
    const list = await fetchServers(fakeRelay.url);
    assert.equal(list.ok, true);
    assert.equal(list.servers.length, 2);

    const probe = await probeRelay(fakeRelay.url);
    assert.equal(probe.ok, true);
    assert.equal(probe.method, 'ws');

    const latency = await measureRelayLatency({ url: fakeRelay.url }, { webrtc: false });
    assert.equal(latency.ok, true);
    assert.equal(latency.method, 'ws');
  });

  await test('/rtc/offer 请求携带 token 与 offer SDP', async () => {
    const before = fakeRelay.stats.rtcRequests.length;
    const result = await measureWebRtcRtt(
      { url: fakeRelay.url, token: 'tok-123' },
      { RTCPeerConnectionImpl: FakePeerConnection, timeoutMs: 3000, pingCount: 1 }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 501/);
    assert.equal(fakeRelay.stats.rtcRequests.length, before + 1);
    const request = fakeRelay.stats.rtcRequests[before];
    assert.ok(request.url.indexOf('token=tok-123') >= 0, request.url);
    assert.equal(JSON.parse(request.body).type, 'offer');
    assert.ok(JSON.parse(request.body).sdp);
  });

  await test('serve.mjs：COOP/COEP、wasm MIME、manifest', async () => {
    const page = await fetchWithTimeout(BASE);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
    const html = await page.text();
    assert.ok(html.indexOf('download-modal') >= 0);
    assert.ok(html.indexOf('hud-panel') >= 0);
    assert.ok(html.indexOf('touch-guide') >= 0, 'index.html 应包含触屏说明节点');
    assert.ok(html.indexOf('touch-hint') >= 0, 'index.html 应包含游戏内触屏提示节点');
    assert.ok(html.indexOf('Ctrl+' + 'Esc') < 0, 'index.html 不应再出现旧的 Esc 快捷键');
    assert.ok(html.indexOf('Ctrl+`') >= 0, 'HUD 提示应为 Ctrl+`');

    const appJs = await fetchWithTimeout(BASE + 'app.js');
    assert.equal(appJs.status, 200);
    assert.match(appJs.headers.get('content-type') || '', /javascript/);
    await appJs.text();

    const deviceJs = await fetchWithTimeout(BASE + 'src/device.js');
    assert.equal(deviceJs.status, 200);
    assert.match(deviceJs.headers.get('content-type') || '', /javascript/);
    assert.ok((await deviceJs.text()).indexOf('detectDeviceFromWindow') >= 0);

    const connectJs = await fetchWithTimeout(BASE + 'src/connect.js');
    assert.equal(connectJs.status, 200);
    const connectSource = await connectJs.text();
    assert.ok(connectSource.indexOf('DDWeb_SetDefaultRelay') >= 0, 'connect.js 应调用 DDWeb_SetDefaultRelay');
    assert.ok(connectSource.indexOf('cl_touch_controls 1') >= 0, 'connect.js 应注入触屏控制命令');

    const manifestResponse = await fetchWithTimeout(BASE + 'manifest.json');
    assert.equal(manifestResponse.status, 200);
    const servedManifest = await manifestResponse.json();
    assert.equal(servedManifest.version, 'itest-v1');

    const wasm = await fetchWithTimeout(BASE + 'DDNet.wasm', { method: 'HEAD' });
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.equal(wasm.headers.get('content-length'), '8');

    const data = await fetchWithTimeout(BASE + 'DDNet.data', { method: 'HEAD' });
    assert.equal(data.headers.get('content-type'), 'application/octet-stream');
  });

  await test('资源下载：真实 HTTP + sha256 校验 + Cache Storage', async () => {
    const caches = createMemoryCaches();
    const createdUrls = [];
    const progress = [];
    const manager = createAssetManager({
      baseUrl: BASE,
      fetchImpl: globalThis.fetch,
      cacheStorage: caches,
      cryptoImpl: globalThis.crypto,
      createObjectURL: (blob) => {
        createdUrls.push(blob);
        return 'blob:itest-' + createdUrls.length;
      },
      progressIntervalMs: 0,
    });
    const initial = await manager.init();
    assert.equal(initial.complete, false);
    assert.equal(initial.items.length, 3);
    assert.equal(initial.items.find((item) => item.name === 'DDNet.wasm').sha256, manifest.files['DDNet.wasm'].sha256);

    const result = await manager.download();
    assert.equal(result.ok, true, JSON.stringify(result.snapshot.lastError));
    assert.equal(manager.isComplete(), true);
    const snapshot = manager.snapshot();
    for (const name of Object.keys(manifest.files)) {
      const item = snapshot.items.find((entry) => entry.name === name);
      assert.equal(item.state, 'cached');
      assert.equal(item.received, manifest.files[name].size);
      assert.equal(item.sha256, manifest.files[name].sha256);
    }
    progress.push(snapshot);

    const urls = await manager.assetUrls();
    assert.deepEqual(Object.keys(urls).sort(), ['DDNet.data', 'DDNet.js', 'DDNet.wasm']);
    assert.match(urls['DDNet.wasm'], /^blob:itest-\d+$/);
    assert.ok(createdUrls.some((blob) => blob.type === 'application/wasm'), 'wasm blob 必须带 application/wasm 类型');

    // 第二次初始化应完全命中缓存
    let assetFetches = 0;
    const countingFetch = async (url, options) => {
      if (!String(url).endsWith('manifest.json')) assetFetches += 1;
      return fetch(url, options);
    };
    const second = createAssetManager({
      baseUrl: BASE,
      fetchImpl: countingFetch,
      cacheStorage: caches,
      cryptoImpl: globalThis.crypto,
    });
    const secondSnapshot = await second.init();
    assert.equal(secondSnapshot.complete, true);
    assert.equal(assetFetches, 0, '命中缓存后不应再下载资源');
  });

  await test('serve.mjs：404 / 目录穿越 / 多根目录', async () => {
    const missing = await fetchWithTimeout(BASE + 'no-such.txt');
    assert.equal(missing.status, 404);
    await missing.text();

    const traversal = await fetchWithTimeout(BASE + '%2e%2e/%2e%2e/etc/passwd');
    assert.ok(traversal.status === 403 || traversal.status === 404);
    await traversal.text();

    const wrongMethod = await fetchWithTimeout(BASE, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    await wrongMethod.text();

    const info = await (await fetchWithTimeout(BASE + '__ddweb/info')).json();
    assert.equal(info.roots[0], WEB_DIR);
    assert.ok(info.roots.indexOf(TMP) >= 0);
    assert.ok(info.buildArtifacts['DDNet.wasm'].endsWith(path.join('ddweb-itest-' + process.pid, 'DDNet.wasm')));
  });
} finally {
  await stopServer(server);
  await fakeRelay.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : ''));
process.exit(failed ? 1 : 0);
