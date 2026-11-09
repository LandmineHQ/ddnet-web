// 客户端资源下载 / sha256 校验 / Cache Storage 本地缓存
// 全部依赖可注入（fetch / caches / crypto / createObjectURL），便于 Node 单测。

export const ASSET_FILES = [
  { name: 'DDNet.js', label: '客户端脚本', type: 'text/javascript; charset=utf-8', big: false, fallbackSize: 376051 },
  { name: 'DDNet.wasm', label: 'WASM 核心', type: 'application/wasm', big: true, fallbackSize: 8872070 },
  { name: 'DDNet.data', label: '游戏资源包', type: 'application/octet-stream', big: true, fallbackSize: 54150365 },
];

export const REQUIRED_FILES = ASSET_FILES.map((file) => file.name);
export const BIG_FILES = ASSET_FILES.filter((file) => file.big).map((file) => file.name);
export const MANIFEST_URL = 'manifest.json';
export const CACHE_PREFIX = 'ddweb-assets-';
export const FALLBACK_CACHE_NAME = 'ddweb-assets-fallback';

const SHA256_RE = /^[0-9a-f]{64}$/i;

export function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || !raw.files || typeof raw.files !== 'object') {
    return { ok: false, error: 'manifest.json 格式无效（缺少 files）' };
  }
  const files = {};
  for (const file of ASSET_FILES) {
    const entry = raw.files[file.name];
    if (!entry || typeof entry !== 'object') continue;
    const sha = typeof entry.sha256 === 'string' && SHA256_RE.test(entry.sha256.trim())
      ? entry.sha256.trim().toLowerCase()
      : '';
    const size = Number(entry.size);
    if (!sha || !Number.isFinite(size) || size <= 0) {
      return { ok: false, error: 'manifest.json 中 ' + file.name + ' 的 sha256/size 无效' };
    }
    files[file.name] = { sha256: sha, size };
  }
  if (!Object.keys(files).length) {
    return { ok: false, error: 'manifest.json 未包含任何客户端资源' };
  }
  return {
    ok: true,
    version: typeof raw.version === 'string' ? raw.version.slice(0, 64) : '',
    files,
  };
}

export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(bytes, cryptoImpl = globalThis.crypto) {
  const subtle = cryptoImpl && cryptoImpl.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('当前环境不支持 crypto.subtle，无法校验文件');
  }
  const digest = await subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

function concatChunks(chunks, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function createItem(definition, baseUrl) {
  return {
    name: definition.name,
    label: definition.label,
    type: definition.type,
    big: definition.big,
    url: new URL(definition.name, baseUrl).href,
    size: definition.fallbackSize,
    expectedSize: null,
    sha256: '',
    state: 'idle',
    received: 0,
    speed: 0,
    error: '',
    fromCache: false,
    verified: false,
    startedAt: 0,
    finishedAt: 0,
  };
}

export function createAssetManager(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cacheStorage = options.cacheStorage !== undefined ? options.cacheStorage : globalThis.caches;
  const cryptoImpl = options.cryptoImpl || globalThis.crypto;
  const createObjectURL = options.createObjectURL || ((blob) => globalThis.URL.createObjectURL(blob));
  const baseUrl = options.baseUrl || '/';
  const now = options.now || (() => (globalThis.performance && globalThis.performance.now ? globalThis.performance.now() : Date.now()));
  const progressIntervalMs = Number.isFinite(options.progressIntervalMs) ? options.progressIntervalMs : 80;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};

  const state = {
    initialized: false,
    manifest: null,
    manifestWarning: '',
    version: '',
    cacheName: '',
    cacheAvailable: false,
    cache: null,
    cacheError: '',
    usingFallbackManifest: false,
    lastError: '',
    items: new Map(),
  };

  const objectUrls = new Map();
  const memoryBlobs = new Map();
  let abortController = null;
  let activeDownload = null;

  function emit(type, item) {
    try {
      onUpdate({ type, item: item || null, snapshot: snapshot() });
    } catch (error) {
      // UI 回调异常不应打断下载
    }
  }

  function urlFor(name) {
    return new URL(name, baseUrl).href;
  }

  function itemByName(name) {
    return state.items.get(name) || null;
  }

  function snapshot() {
    const items = Array.from(state.items.values()).map((item) => {
      const size = item.size || 0;
      const percent = item.state === 'cached' ? 100 : size > 0 ? Math.min(100, (item.received / size) * 100) : 0;
      return {
        name: item.name,
        label: item.label,
        type: item.type,
        big: item.big,
        size,
        sha256: item.sha256,
        state: item.state,
        received: item.received,
        percent,
        speed: item.speed,
        error: item.error,
        fromCache: item.fromCache,
      };
    });
    const totalBytes = items.reduce((sum, item) => sum + (item.size || 0), 0);
    const receivedBytes = items.reduce((sum, item) => sum + (item.state === 'cached' ? item.size || item.received : item.received), 0);
    return {
      items,
      complete: items.length > 0 && items.every((item) => item.state === 'cached'),
      manifestVersion: state.version,
      manifestWarning: state.manifestWarning,
      cacheAvailable: state.cacheAvailable,
      cacheError: state.cacheError,
      cacheName: state.cacheName,
      usingFallbackManifest: state.usingFallbackManifest,
      totalBytes,
      receivedBytes,
      lastError: state.lastError,
    };
  }

  async function loadManifest() {
    state.items = new Map(ASSET_FILES.map((definition) => [definition.name, createItem(definition, baseUrl)]));
    try {
      const response = await fetchImpl(urlFor(MANIFEST_URL), { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      const parsed = normalizeManifest(data);
      if (!parsed.ok) throw new Error(parsed.error);
      state.manifest = parsed;
      state.version = parsed.version || '';
      state.usingFallbackManifest = false;
      state.cacheName = CACHE_PREFIX + (parsed.version || 'v1');
      for (const item of state.items.values()) {
        const entry = parsed.files[item.name];
        if (entry) {
          item.sha256 = entry.sha256;
          item.size = entry.size;
          item.expectedSize = entry.size;
          item.verified = true;
        } else {
          item.sha256 = '';
          item.expectedSize = null;
        }
      }
    } catch (error) {
      state.manifest = null;
      state.version = '';
      state.usingFallbackManifest = true;
      state.manifestWarning = 'manifest.json 不可用（' + ((error && error.message) || error) + '），本次下载将跳过 sha256 校验。';
      state.cacheName = FALLBACK_CACHE_NAME;
      await Promise.all(Array.from(state.items.values()).map(async (item) => {
        try {
          const response = await fetchImpl(item.url, { method: 'HEAD', cache: 'no-store' });
          if (response.ok) {
            const length = Number(response.headers.get('content-length'));
            if (Number.isFinite(length) && length > 0) item.size = length;
          }
        } catch (headError) {
          // HEAD 失败时保留兜底大小
        }
      }));
    }
  }

  async function setupCache() {
    state.cache = null;
    state.cacheAvailable = false;
    state.cacheError = '';
    if (!cacheStorage || typeof cacheStorage.open !== 'function') {
      state.cacheError = '当前环境不支持 Cache Storage';
      return;
    }
    try {
      state.cache = await cacheStorage.open(state.cacheName);
      state.cacheAvailable = true;
      if (typeof cacheStorage.keys === 'function') {
        try {
          const keys = await cacheStorage.keys();
          for (const key of keys) {
            if (typeof key === 'string' && key.indexOf(CACHE_PREFIX) === 0 && key !== state.cacheName) {
              try {
                await cacheStorage.delete(key);
              } catch (deleteError) {
                // 清理旧缓存失败不影响主流程
              }
            }
          }
        } catch (keysError) {
          // 忽略
        }
      }
    } catch (error) {
      state.cacheAvailable = false;
      state.cache = null;
      state.cacheError = (error && error.message) || '无法打开 Cache Storage';
    }
  }

  async function cachedResponse(item) {
    if (!state.cache) return null;
    let response = null;
    try {
      response = await state.cache.match(item.url);
    } catch (error) {
      return null;
    }
    if (!response) return null;
    const storedSha = response.headers.get('x-ddweb-sha256') || '';
    const storedSize = Number(response.headers.get('x-ddweb-size') || 0);
    if (item.sha256) {
      if (!storedSha || storedSha.toLowerCase() !== item.sha256) return null;
    }
    if (item.size && storedSize && storedSize !== item.size) return null;
    return response;
  }

  async function refreshCachedState() {
    for (const item of state.items.values()) {
      const response = await cachedResponse(item);
      if (response) {
        item.state = 'cached';
        item.fromCache = true;
        item.received = Number(response.headers.get('x-ddweb-size') || item.size || 0) || item.size;
        item.error = '';
        item.speed = 0;
      } else if (item.state !== 'error' && item.state !== 'downloading') {
        item.state = 'idle';
        item.received = 0;
        item.fromCache = false;
      }
    }
  }

  function updateSpeed(item, received) {
    const at = now();
    if (!item.sampleAt) {
      item.sampleAt = at;
      item.sampleBytes = received;
      return;
    }
    const elapsed = at - item.sampleAt;
    if (elapsed < 250) return;
    const instant = ((received - item.sampleBytes) * 1000) / elapsed;
    item.speed = item.speed > 0 ? item.speed * 0.55 + instant * 0.45 : instant;
    item.sampleAt = at;
    item.sampleBytes = received;
  }

  async function downloadOne(item) {
    item.state = 'downloading';
    item.error = '';
    item.received = 0;
    item.speed = 0;
    item.fromCache = false;
    item.sampleAt = 0;
    item.sampleBytes = 0;
    item.startedAt = now();
    emit('start', item);

    const response = await fetchImpl(item.url, {
      cache: 'no-store',
      signal: abortController ? abortController.signal : undefined,
    });
    if (!response.ok) throw new Error('下载 ' + item.name + ' 失败：HTTP ' + response.status);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 0) {
      item.size = length;
    }

    const chunks = [];
    let received = 0;
    let lastEmitAt = 0;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        if (result.value) {
          chunks.push(result.value);
          received += result.value.byteLength;
          item.received = received;
          updateSpeed(item, received);
          const at = now();
          if (at - lastEmitAt >= progressIntervalMs) {
            lastEmitAt = at;
            emit('progress', item);
          }
        }
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      chunks.push(buffer);
      received = buffer.byteLength;
      item.received = received;
    }

    const expectedSize = item.expectedSize || item.size;
    if (expectedSize && received !== expectedSize) {
      throw new Error(item.name + ' 大小不匹配：期望 ' + expectedSize + ' 字节，实际收到 ' + received + ' 字节');
    }

    const bytes = concatChunks(chunks, received);
    item.state = 'verifying';
    emit('verifying', item);
    if (item.sha256) {
      const digest = await sha256Hex(bytes, cryptoImpl);
      if (digest.toLowerCase() !== item.sha256) {
        throw new Error(item.name + ' sha256 校验失败（期望 ' + item.sha256.slice(0, 12) + '…，实际 ' + digest.slice(0, 12) + '…）');
      }
      item.verified = true;
    }

    if (state.cache) {
      try {
        await state.cache.put(item.url, new Response(bytes, {
          headers: {
            'content-type': item.type,
            'content-length': String(received),
            'x-ddweb-sha256': item.sha256 || '',
            'x-ddweb-size': String(received),
          },
        }));
      } catch (cacheError) {
        state.cacheError = (cacheError && cacheError.message) || '缓存写入失败';
        memoryBlobs.set(item.name, new Blob([bytes], { type: item.type }));
      }
    } else {
      memoryBlobs.set(item.name, new Blob([bytes], { type: item.type }));
    }

    item.state = 'cached';
    item.received = received;
    item.speed = 0;
    item.finishedAt = now();
    emit('cached', item);
  }

  async function init() {
    state.initialized = false;
    state.lastError = '';
    state.manifestWarning = '';
    objectUrls.forEach((url) => {
      try {
        globalThis.URL.revokeObjectURL(url);
      } catch (error) {
        // 忽略
      }
    });
    objectUrls.clear();
    memoryBlobs.clear();
    await loadManifest();
    await setupCache();
    await refreshCachedState();
    state.initialized = true;
    emit('init', null);
    return snapshot();
  }

  async function download(options = {}) {
    if (!state.initialized) await init();
    if (activeDownload) return activeDownload;
    abortController = new AbortController();
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      options.signal.addEventListener('abort', () => {
        if (abortController) abortController.abort();
      }, { once: true });
    }
    activeDownload = (async () => {
      const targets = Array.from(state.items.values()).filter((item) => item.state !== 'cached');
      await Promise.all(targets.map(async (item) => {
        try {
          await downloadOne(item);
        } catch (error) {
          item.state = 'error';
          item.error = (error && error.message) || String(error);
          item.speed = 0;
          state.lastError = item.error;
          emit('error', item);
        }
      }));
      const complete = Array.from(state.items.values()).every((item) => item.state === 'cached');
      emit('done', null);
      return { ok: complete, snapshot: snapshot() };
    })();
    try {
      return await activeDownload;
    } finally {
      activeDownload = null;
      abortController = null;
    }
  }

  function abort() {
    if (abortController) abortController.abort();
  }

  async function objectUrl(name) {
    if (objectUrls.has(name)) return objectUrls.get(name);
    const item = itemByName(name);
    if (!item) throw new Error('未知资源：' + name);
    let blob = memoryBlobs.get(name) || null;
    if (!blob && state.cache) {
      const response = await state.cache.match(item.url);
      if (response) blob = await response.blob();
    }
    if (!blob) throw new Error('资源尚未下载：' + name);
    // .wasm 必须是 application/wasm，否则 instantiateStreaming 会失败
    if (name === 'DDNet.wasm' && blob.type !== 'application/wasm') {
      blob = new Blob([blob], { type: 'application/wasm' });
    }
    const url = createObjectURL(blob);
    objectUrls.set(name, url);
    return url;
  }

  async function assetUrls() {
    const urls = {};
    for (const name of REQUIRED_FILES) {
      urls[name] = await objectUrl(name);
    }
    return urls;
  }

  function isComplete() {
    return REQUIRED_FILES.every((name) => {
      const item = itemByName(name);
      return item && item.state === 'cached';
    });
  }

  function getItem(name) {
    return itemByName(name);
  }

  async function clear() {
    objectUrls.forEach((url) => {
      try {
        globalThis.URL.revokeObjectURL(url);
      } catch (error) {
        // 忽略
      }
    });
    objectUrls.clear();
    memoryBlobs.clear();
    if (cacheStorage && typeof cacheStorage.delete === 'function') {
      try {
        await cacheStorage.delete(state.cacheName);
      } catch (error) {
        // 忽略
      }
    }
    for (const item of state.items.values()) {
      item.state = 'idle';
      item.received = 0;
      item.speed = 0;
      item.error = '';
      item.fromCache = false;
    }
    emit('cleared', null);
    return snapshot();
  }

  return {
    init,
    download,
    abort,
    objectUrl,
    assetUrls,
    isComplete,
    getItem,
    snapshot,
    clear,
    get initialized() {
      return state.initialized;
    },
    get cacheAvailable() {
      return state.cacheAvailable;
    },
    get manifestWarning() {
      return state.manifestWarning;
    },
  };
}
