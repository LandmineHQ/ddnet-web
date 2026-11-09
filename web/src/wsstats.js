// 前端流量观测：包装 WebSocket 统计 wasm 客户端经中继收发的字节数（best-effort）

function byteLengthOf(data) {
  if (data == null) return 0;
  if (typeof data === 'string') return data.length * 2;
  if (typeof ArrayBuffer !== 'undefined') {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size || 0;
  return 0;
}

function emptyTotals() {
  return { bytesIn: 0, bytesOut: 0, connections: 0, open: 0 };
}

export function installWebSocketStats(win = globalThis) {
  const Original = win && win.WebSocket;
  const instances = new Set();
  const unsupported = {
    supported: false,
    snapshot: () => [],
    totals: () => emptyTotals(),
    uninstall() {},
  };
  if (typeof Original !== 'function') return unsupported;
  if (Original.__ddwebStatsState) return Original.__ddwebStatsState;

  let Instrumented;
  try {
    Instrumented = class InstrumentedWebSocket extends Original {
      constructor(url, protocols) {
        super(url, protocols);
        const entry = {
          url: String(url),
          bytesIn: 0,
          bytesOut: 0,
          opened: false,
          closed: false,
          createdAt: Date.now(),
        };
        instances.add(entry);
        this.__ddwebStats = entry;
        this.addEventListener('open', () => {
          entry.opened = true;
        });
        this.addEventListener('close', () => {
          entry.closed = true;
          entry.opened = false;
        });
        this.addEventListener('message', (event) => {
          entry.bytesIn += byteLengthOf(event && event.data);
        });
      }

      send(data) {
        try {
          this.__ddwebStats.bytesOut += byteLengthOf(data);
        } catch (error) {
          // 忽略统计异常
        }
        return super.send(data);
      }
    };
  } catch (error) {
    return unsupported;
  }

  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try {
      Instrumented[key] = Original[key];
    } catch (error) {
      // 忽略
    }
  }

  const state = {
    supported: true,
    instances,
    snapshot() {
      return Array.from(instances);
    },
    totals(match) {
      const totals = emptyTotals();
      for (const entry of instances) {
        if (match && !match(entry.url)) continue;
        totals.bytesIn += entry.bytesIn;
        totals.bytesOut += entry.bytesOut;
        totals.connections += 1;
        if (entry.opened) totals.open += 1;
      }
      return totals;
    },
    uninstall() {
      try {
        win.WebSocket = Original;
      } catch (error) {
        // 忽略
      }
    },
  };

  Instrumented.__ddwebStatsState = state;
  try {
    win.WebSocket = Instrumented;
  } catch (error) {
    return unsupported;
  }
  return state;
}

export function isRelaySocketUrl(url) {
  return typeof url === 'string' && url.indexOf('/udp/') >= 0;
}
