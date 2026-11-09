// 真实后端检查：/api/info、/api/servers、测活回退、连接 URL（0.6/0.7）
// 用法：node web/tools/check-real-backend.mjs [relayBase] [host:port]
import { fetchServers, probeRelay } from '../src/probe.js';
import { fetchRelayInfo, measureRelayLatency } from '../src/latency.js';
import { buildConnectTarget } from '../src/connect.js';

const relayBase = process.argv[2] || 'ws://127.0.0.1:8390';
const targetText = process.argv[3] || "74.91.126.203:8300";
const [host, portText] = targetText.split(':');
const port = Number(portText);

function log(label, value) {
  console.log(label, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

log('测活 probeRelay:', await probeRelay(relayBase, { timeoutMs: 4000 }));
log('后端信息 /api/info:', await fetchRelayInfo({ url: relayBase, name: '本地' }, { timeoutMs: 4000 }));
const servers = await fetchServers(relayBase, { timeoutMs: 4000 });
log('服务器列表:', servers);

const fallback = await measureRelayLatency({ url: relayBase }, { webrtc: false, timeoutMs: 4000 });
log('延迟（无 WebRTC 回退）:', fallback);

for (const protocol of [6, 7]) {
  const built = buildConnectTarget({ url: relayBase }, { host, port }, { protocol });
  log('协议 ' + protocol + ' 连接 URL:', built.ok ? built.url : built);
  if (!built.ok) continue;
  const opened = await new Promise((resolve) => {
    let socket;
    const timer = setTimeout(() => resolve({ ok: false, error: '握手超时' }), 5000);
    try {
      socket = new WebSocket(built.url);
    } catch (error) {
      clearTimeout(timer);
      resolve({ ok: false, error: String(error && error.message) });
      return;
    }
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      setTimeout(() => {
        try {
          socket.close();
        } catch (error) {
          // 忽略
        }
      }, 200);
      resolve({ ok: true, url: built.url });
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'WebSocket 握手失败' });
    });
  });
  log('  ws 握手:', opened);
}

setTimeout(() => process.exit(0), 500);
