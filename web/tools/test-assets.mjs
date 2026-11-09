// 资源下载 / sha256 校验 / Cache Storage 单测（mock fetch、caches、crypto 可注入）
import assert from 'node:assert/strict';
import {
  createAssetManager,
  normalizeManifest,
  sha256Hex,
  CACHE_PREFIX,
  FALLBACK_CACHE_NAME,
} from '../src/assets.js';

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
    const detail = String((error && error.stack) || error).split('\n').slice(0, 8).join('\n');
    console.log('     ' + detail.split('\n').join('\n     '));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const FILES = ['DDNet.js', 'DDNet.wasm', 'DDNet.data'];

async function makeFixture(options = {}) {
  const contents = {};
  const hashes = {};
  const sizes = {};
  for (const name of FILES) {
    const bytes = new TextEncoder().encode('payload-' + name + '-' + (options.salt || 'v1'));
    contents[name] = bytes;
    sizes[name] = bytes.byteLength;
    hashes[name] = await sha256Hex(bytes, globalThis.crypto);
  }
  const manifest = options.noManifest
    ? null
    : {
      version: options.version || 'test-version',
      files: Object.fromEntries(FILES.map((name) => [name, { sha256: options.badSha && name === 'DDNet.wasm' ? 'f'.repeat(64) : hashes[name], size: sizes[name] }])),
    };
  return { contents, hashes, sizes, manifest };
}

function createFetchMock(config) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(String(url), 'http://test.local/').pathname;
    calls.push({ url: String(url), pathname, method: options.method || 'GET' });
    if (pathname === '/manifest.json') {
      if (!config.manifest) return new Response('missing', { status: 404 });
      return new Response(JSON.stringify(config.manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const name = pathname.replace(/^\//, '');
    const bytes = config.contents[name];
    if (!bytes) return new Response('not found', { status: 404 });
    const served = config.served ? config.served[name] || bytes : bytes;
    if (options.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
    }
    const chunks = config.chunks || 3;
    const stream = new ReadableStream({
      start(controller) {
        const size = Math.max(1, Math.ceil(served.byteLength / chunks));
        for (let offset = 0; offset < served.byteLength; offset += size) {
          controller.enqueue(served.slice(offset, offset + size));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-length': String(served.byteLength) } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function createMemoryCaches() {
  const caches = new Map();
  function makeCache(name) {
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

function createUrls() {
  const created = [];
  return {
    create: (blob) => {
      created.push(blob);
      return 'blob:mock-' + created.length;
    },
    created,
  };
}

await test('normalizeManifest 校验格式', () => {
  const good = normalizeManifest({
    version: 'v1',
    files: {
      'DDNet.js': { sha256: 'a'.repeat(64), size: 10 },
      'DDNet.wasm': { sha256: 'b'.repeat(64), size: 20 },
      'DDNet.data': { sha256: 'c'.repeat(64), size: 30 },
    },
  });
  assert.equal(good.ok, true);
  assert.equal(good.version, 'v1');
  assert.equal(good.files['DDNet.data'].size, 30);

  assert.equal(normalizeManifest(null).ok, false);
  assert.equal(normalizeManifest({ files: {} }).ok, false);
  assert.equal(normalizeManifest({ files: { 'DDNet.js': { sha256: 'short', size: 1 } } }).ok, false);
  assert.equal(normalizeManifest({ files: { 'DDNet.js': { sha256: 'a'.repeat(64), size: 0 } } }).ok, false);
});

await test('sha256Hex 与固定向量一致', async () => {
  const digest = await sha256Hex(new TextEncoder().encode('abc'), globalThis.crypto);
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

await test('首次下载：进度、校验、写入缓存', async () => {
  const fixture = await makeFixture();
  const fetchImpl = createFetchMock({ ...fixture });
  const caches = createMemoryCaches();
  const urls = createUrls();
  const updates = [];
  const manager = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl,
    cacheStorage: caches,
    cryptoImpl: globalThis.crypto,
    createObjectURL: urls.create,
    progressIntervalMs: 0,
    onUpdate: (info) => updates.push(info),
  });

  const initial = await manager.init();
  assert.equal(initial.complete, false);
  assert.equal(initial.items.length, 3);
  assert.equal(initial.cacheAvailable, true);
  assert.equal(initial.cacheName, CACHE_PREFIX + 'test-version');
  assert.ok(initial.items.every((item) => item.sha256.length === 64));

  const result = await manager.download();
  assert.equal(result.ok, true, JSON.stringify(result.snapshot.lastError));
  assert.equal(manager.isComplete(), true);
  const snap = manager.snapshot();
  for (const name of FILES) {
    const item = snap.items.find((entry) => entry.name === name);
    assert.equal(item.state, 'cached');
    assert.equal(item.received, fixture.sizes[name]);
    assert.equal(item.percent, 100);
  }
  assert.ok(snap.totalBytes >= fixture.sizes['DDNet.data']);
  assert.ok(updates.some((info) => info.type === 'progress' || info.type === 'cached'));
  assert.ok(updates.some((info) => info.type === 'done'));

  const cache = await caches.open(CACHE_PREFIX + 'test-version');
  for (const name of FILES) {
    const response = await cache.match('http://test.local/' + name);
    assert.ok(response, '缓存中应存在 ' + name);
    assert.equal(response.headers.get('x-ddweb-sha256'), fixture.hashes[name]);
    assert.equal(Number(response.headers.get('x-ddweb-size')), fixture.sizes[name]);
  }
  assert.equal((await cache.match('http://test.local/DDNet.wasm')).headers.get('content-type'), 'application/wasm');
});

await test('二次初始化命中缓存，不再下载资源', async () => {
  const fixture = await makeFixture();
  const fetchImpl = createFetchMock({ ...fixture });
  const caches = createMemoryCaches();
  const manager = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl,
    cacheStorage: caches,
    cryptoImpl: globalThis.crypto,
  });
  await manager.init();
  await manager.download();
  const before = fetchImpl.calls.length;

  const secondFetch = createFetchMock({ ...fixture });
  const second = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl: secondFetch,
    cacheStorage: caches,
    cryptoImpl: globalThis.crypto,
  });
  const snap = await second.init();
  assert.equal(snap.complete, true);
  assert.ok(snap.items.every((item) => item.state === 'cached' && item.fromCache));
  assert.equal(secondFetch.calls.filter((call) => call.pathname !== '/manifest.json').length, 0, '再次打开不应重新下载资源');
  assert.ok(before > 0);

  const urls = createUrls();
  const managerWithUrls = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl: secondFetch,
    cacheStorage: caches,
    cryptoImpl: globalThis.crypto,
    createObjectURL: urls.create,
  });
  await managerWithUrls.init();
  const wasmUrl = await managerWithUrls.objectUrl('DDNet.wasm');
  assert.equal(wasmUrl, 'blob:mock-1');
  assert.equal(urls.created[0].type, 'application/wasm');
  const all = await managerWithUrls.assetUrls();
  assert.deepEqual(Object.keys(all).sort(), ['DDNet.data', 'DDNet.js', 'DDNet.wasm']);
});

await test('sha256 不匹配时失败且不写入缓存', async () => {
  const fixture = await makeFixture({ badSha: true });
  const fetchImpl = createFetchMock({ ...fixture });
  const caches = createMemoryCaches();
  const manager = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl,
    cacheStorage: caches,
    cryptoImpl: globalThis.crypto,
  });
  await manager.init();
  const result = await manager.download();
  assert.equal(result.ok, false);
  const snap = manager.snapshot();
  assert.match(snap.lastError, /sha256 校验失败/);
  const wasm = snap.items.find((item) => item.name === 'DDNet.wasm');
  assert.equal(wasm.state, 'error');
  assert.match(wasm.error, /sha256/);
  const cache = await caches.open(CACHE_PREFIX + 'test-version');
  assert.equal(await cache.match('http://test.local/DDNet.wasm'), null);
});

await test('大小不匹配时报错', async () => {
  const fixture = await makeFixture();
  const served = Object.assign({}, fixture.contents);
  served['DDNet.data'] = new TextEncoder().encode('short');
  const fetchImpl = createFetchMock({ ...fixture, served });
  const manager = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl,
    cacheStorage: createMemoryCaches(),
    cryptoImpl: globalThis.crypto,
  });
  await manager.init();
  const result = await manager.download();
  assert.equal(result.ok, false);
  const data = manager.snapshot().items.find((item) => item.name === 'DDNet.data');
  assert.equal(data.state, 'error');
  assert.match(data.error, /大小不匹配/);
});

await test('manifest 缺失时回退 HEAD 大小并跳过 sha 校验', async () => {
  const fixture = await makeFixture({ noManifest: true });
  const fetchImpl = createFetchMock({ ...fixture, manifest: null });
  const caches = createMemoryCaches();
  const manager = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl,
    cacheStorage: caches,
    cryptoImpl: globalThis.crypto,
  });
  const snap = await manager.init();
  assert.equal(snap.usingFallbackManifest, true);
  assert.match(snap.manifestWarning, /manifest\.json/);
  assert.equal(snap.cacheName, FALLBACK_CACHE_NAME);
  assert.equal(snap.items.find((item) => item.name === 'DDNet.wasm').size, fixture.sizes['DDNet.wasm']);
  const result = await manager.download();
  assert.equal(result.ok, true);
  assert.ok(fetchImpl.calls.some((call) => call.method === 'HEAD'));
  const cache = await caches.open(FALLBACK_CACHE_NAME);
  assert.ok(await cache.match('http://test.local/DDNet.wasm'));
});

await test('abort 中断下载并标记错误', async () => {
  const fixture = await makeFixture();
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(String(url), 'http://test.local/').pathname;
    if (pathname === '/manifest.json') {
      return new Response(JSON.stringify(fixture.manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } }));
      }, 30);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }
    });
  };
  const manager = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl,
    cacheStorage: createMemoryCaches(),
    cryptoImpl: globalThis.crypto,
    progressIntervalMs: 0,
  });
  await manager.init();
  const promise = manager.download();
  setTimeout(() => manager.abort(), 5);
  const result = await promise;
  assert.equal(result.ok, false);
});

await test('Range 分块下载从 1 并发逐步增加并校验', async () => {
  const FILES2 = ['DDNet.js', 'DDNet.wasm', 'DDNet.data'];
  const contents = {
    'DDNet.js': new TextEncoder().encode('small-js'),
    'DDNet.wasm': new TextEncoder().encode('small-wasm'),
    'DDNet.data': new Uint8Array(8 * 1024 * 1024 + 123),
  };
  for (let i = 0; i < contents['DDNet.data'].length; i += 1) contents['DDNet.data'][i] = i % 251;
  const files = {};
  for (const name of FILES2) {
    files[name] = {
      sha256: await sha256Hex(contents[name], globalThis.crypto),
      size: contents[name].byteLength,
    };
  }
  const manifest = { version: 'range-test', files };
  let active = 0;
  let peak = 0;
  const rangeCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(String(url), 'http://test.local/').pathname;
    if (pathname === '/manifest.json') {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const name = pathname.replace(/^\//, '');
    const bytes = contents[name];
    if (!bytes) return new Response('missing', { status: 404 });
    const range = options.headers && options.headers.Range;
    if (range) {
      const match = /bytes=(\d+)-(\d+)/.exec(String(range));
      if (!match) return new Response('bad range', { status: 400 });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), bytes.byteLength - 1);
      rangeCalls.push([start, end]);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes ' + start + '-' + end + '/' + bytes.byteLength, 'content-length': String(end - start + 1) },
      });
    }
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  };
  const manager = createAssetManager({
    baseUrl: 'http://test.local/',
    fetchImpl,
    cacheStorage: createMemoryCaches(),
    cryptoImpl: globalThis.crypto,
    progressIntervalMs: 0,
    maxParallel: 16,
    minParallel: 8,
    rampIntervalMs: 10,
    probeIntervalMs: 30,
    startupTimeoutMs: 2000,
    stallTimeoutMs: 2000,
  });
  await manager.init();
  const result = await manager.download();
  assert.equal(result.ok, true, JSON.stringify(result.snapshot.lastError));
  assert.ok(rangeCalls.length >= 2, 'expected multiple range requests');
  assert.ok(peak >= 8, 'expected at least 8 concurrent range workers, peak=' + peak);
  assert.equal(manager.isComplete(), true);
});

console.log('');
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : ''));
process.exit(failed ? 1 : 0);
