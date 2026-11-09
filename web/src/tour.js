// 首次进入游戏后的聚光灯引导状态机（纯函数，可在 Node 中测试）

export const TOUR_STORAGE_KEY = 'ddweb.tour.v1';

export function createTour(steps = [], options = {}) {
  const list = Array.isArray(steps) ? steps.slice() : [];
  let index = 0;
  let active = false;
  let finished = options.finished === true;

  return {
    get active() {
      return active;
    },
    get index() {
      return index;
    },
    get total() {
      return list.length;
    },
    get finished() {
      return finished;
    },
    steps() {
      return list.slice();
    },
    start() {
      if (!list.length) return false;
      index = 0;
      active = true;
      finished = false;
      return true;
    },
    next() {
      if (!active) return false;
      if (index + 1 >= list.length) {
        active = false;
        finished = true;
        return false;
      }
      index += 1;
      return true;
    },
    prev() {
      if (!active) return false;
      if (index === 0) return false;
      index -= 1;
      return true;
    },
    skip() {
      active = false;
      finished = true;
      return true;
    },
    finish() {
      active = false;
      finished = true;
      return true;
    },
    current() {
      if (!active) return null;
      return list[index] || null;
    },
    isLast() {
      return active && index === list.length - 1;
    },
    snapshot() {
      return { active, index, total: list.length, finished, current: active ? list[index] || null : null };
    },
  };
}

export function readTourDone(storage, key = TOUR_STORAGE_KEY) {
  if (!storage) return false;
  try {
    return storage.getItem(key) === 'done';
  } catch (error) {
    return false;
  }
}

export function markTourDone(storage, key = TOUR_STORAGE_KEY) {
  if (!storage) return;
  try {
    storage.setItem(key, 'done');
  } catch (error) {
    // 忽略
  }
}
