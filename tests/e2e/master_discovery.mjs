/**
 * relay master 验收：
 *  - 新节点注册时 master 主动 WS 探测 <url>/ws，失败拒绝
 *  - 成功后 /v1/serverlist 可见
 *  - 网页从 master 获取节点并显示 Master 节点
 */
import http from "node:http";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const MASTER = process.env.MASTER_URL || "http://127.0.0.1:8391";
const NODE_URL = "ws://127.0.0.1:8399";
const SHOTS = process.env.SHOT_DIR || "/w/tests/out";
const results = [];
const record = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  — " + d : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wsRelay = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'master-e2e-relay' }));
});
wsRelay.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'] || '';
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.end();
});
await new Promise((resolve, reject) => wsRelay.listen(8399, '127.0.0.1', (err) => err ? reject(err) : resolve()));
record("测试 relay /ws 启动", true, NODE_URL + "/ws");

const post = async (path, payload) => {
  const response = await fetch(MASTER + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const bad = await post('/v1/register', { name: 'Dead Relay', transports: [{ type: 'websocket', url: 'ws://127.0.0.1:8398' }] });
record("注册时 WS 探测失败被拒绝", bad.status === 502 && bad.body.ok === false, JSON.stringify(bad).slice(0, 160));

const good = await post('/v1/register', { name: 'Master E2E Relay', region: 'TEST', version: '1.0.0', transports: [{ type: 'websocket', url: NODE_URL }] });
record("注册时 WS 探测成功并验证", good.status === 200 && good.body.verified === true, JSON.stringify(good).slice(0, 160));

const listResponse = await fetch(MASTER + '/v1/serverlist', { headers: { origin: 'https://play.example.com' } });
const list = await listResponse.json();
const listed = Array.isArray(list.servers) && list.servers.some((node) => Array.isArray(node.transports) && node.transports.some((t) => t.url === NODE_URL));
record("serverlist 返回已验证节点", listed, "count=" + list.count + " cors=" + (listResponse.headers.get('access-control-allow-origin') || ''));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader",
    "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800"],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => globalThis.__ddwebDebug && globalThis.__ddwebDebug.relayStore, { timeout: 30000 });
await page.waitForFunction((url) => globalThis.__ddwebDebug.relayStore.findByUrl(url) !== null, { timeout: 15000 }, NODE_URL).catch(() => {});
const relay = await page.evaluate((url) => {
  const entry = globalThis.__ddwebDebug.relayStore.findByUrl(url);
  return entry ? { name: entry.name, source: entry.source, note: entry.note } : null;
}, NODE_URL);
record("网页从 master 获取节点", relay && relay.source === 'master', JSON.stringify(relay));
const tag = await page.evaluate((url) => {
  const cards = [...document.querySelectorAll('#relay-grid .relay-card')];
  const card = cards.find((node) => (node.textContent || '').includes('8399'));
  return card ? card.textContent : '';
}, NODE_URL);
record("网页显示 Master 节点标记", /Master 节点/.test(tag), tag.slice(0, 160).replace(/\s+/g, ' '));
await page.screenshot({ path: SHOTS + "/master-discovery.png" }).catch(() => {});
await browser.close();

await post('/v1/unregister', { transports: [{ type: 'websocket', url: NODE_URL }] });
wsRelay.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
