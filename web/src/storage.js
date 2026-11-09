// localStorage 适配器：不可用（隐私模式 / file://）时退化为内存存储

export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      const k = String(key);
      return map.has(k) ? map.get(k) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    key(index) {
      const keys = Array.from(map.keys());
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    get length() {
      return map.size;
    },
  };
}

export function createStorage(win = globalThis) {
  try {
    const storage = win && win.localStorage;
    if (!storage) throw new Error('当前环境没有 localStorage');
    const probeKey = '__ddweb_probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return { ok: true, storage, reason: '' };
  } catch (error) {
    return {
      ok: false,
      storage: createMemoryStorage(),
      reason: (error && error.message) || 'localStorage 不可用',
    };
  }
}

export function readJson(storage, key) {
  if (!storage) return { ok: false, error: '存储不可用' };
  try {
    const text = storage.getItem(key);
    if (!text) return { ok: true, data: null };
    return { ok: true, data: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: (error && error.message) || '读取失败' };
  }
}

export function writeJson(storage, key, data) {
  if (!storage) return { ok: false, error: '存储不可用' };
  try {
    storage.setItem(key, JSON.stringify(data));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error && error.message) || '写入失败' };
  }
}
