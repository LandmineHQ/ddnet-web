/**
 * 重连同一服务器：中继空闲超时（60s）会关闭 WebSocket，而 CNetClient 仍按
 * NETADDR 缓存连接。C++ 侧在发送失败时丢弃死连接并在冷却后重开，
 * 否则「再次加入同一服务器」会一直无响应。
 */
import puppeteer from "puppeteer-core";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const RELAY = process.env.RELAY_URL || "ws://127.0.0.1:8390";
const TARGET = process.env.TARGET || "74.91.126.203:8300";
const IDLE_WAIT = Number(process.env.IDLE_WAIT_MS || 70000);
const SHOTS = process.env.SHOT_DIR || "/w/tests/out";
const results = [];
const record = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  — " + d : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/chromium", headless: "new", protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800"],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const logs = []; page.on("console", (m) => logs.push(m.text())); page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
const waitLog = async (re, from = 0, timeout = 90000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (let i = from; i < logs.length; i++) if (re.test(logs[i])) return i;
    await sleep(250);
  }
  return -1;
};
const consoleCmd = async (cmd) => {
  const c = await page.$("#canvas"); if (c) await c.click({ offset: { x: 640, y: 400 } }).catch(() => {});
  await sleep(400);
  await page.keyboard.press("F1"); await sleep(1300);
  await page.keyboard.type(cmd, { delay: 20 }); await sleep(200);
  await page.keyboard.press("Enter"); await sleep(1800);
  await page.keyboard.press("F1"); await sleep(500);
};

const url = BASE + "/?connect=" + encodeURIComponent(RELAY + "/udp/" + TARGET) + "&autostart=1";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
const first = await waitLog(/client: connected, sending info/, 0, 90000);
record("初始连接成功", first >= 0);
if (first < 0) {
  const state = await page.evaluate(() => {
    const st = globalThis.__ddwebDebug && globalThis.__ddwebDebug.state;
    return { phase: st && st.phase, view: st && st.view, assets: st && st.assets && st.assets.isComplete && st.assets.isComplete(), loading: st && st.loading && st.loading.open };
  }).catch((e) => String(e));
  console.log("debug state:", JSON.stringify(state));
  console.log("last logs:\n" + logs.slice(-25).join("\n"));
  await page.screenshot({ path: SHOTS + "/relay-reconnect-initial-fail.png" }).catch(() => {});
  await browser.close();
  process.exit(1);
}
await page.waitForFunction(() => { const c = document.querySelector("#canvas"); return c && c.getBoundingClientRect().width > 0; }, { timeout: 60000 });
await sleep(2500); // let the join transition finish; F1 is ignored during it

await consoleCmd("disconnect");
record("已断开（等待中继空闲超时关闭 WS）", true, IDLE_WAIT + "ms");
await sleep(IDLE_WAIT);

const before = logs.length;
await consoleCmd("connect " + TARGET);
const second = await waitLog(/client: connected, sending info/, before, 60000);
const reopened = await waitLog(/opened WebSocket connection to/, before, 5000);
record("空闲超时后重连同一服务器成功", second >= 0, second >= 0 ? "log#" + second : "超时");
record("重连时重新建立了传输连接", reopened >= 0, reopened >= 0 ? logs[reopened].slice(0, 180) : "未重新打开");
if (second < 0) {
  console.log("last logs after reconnect attempt:\n" + logs.slice(before).slice(-30).join("\n"));
  console.log("all client logs tail:\n" + logs.filter((l) => /client:|websockets|disconnect/i.test(l)).slice(-20).join("\n"));
}
await page.screenshot({ path: SHOTS + "/relay-reconnect.png" }).catch(() => {});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
