/**
 * 验证 wasm 客户端的数据传输：
 *  - 首选 WebRTC DataChannel（游戏 UDP 经 DataChannel 中转）
 *  - 失败时自动回退 WebSocket
 * 环境：BASE_URL、RELAY_URL、TARGET、EXPECT=webrtc|ws、SHOT_DIR
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const RELAY = process.env.RELAY_URL || "ws://127.0.0.1:8390";
const TARGET = process.env.TARGET || "74.91.126.203:8300";
const EXPECT = (process.env.EXPECT || "webrtc").toLowerCase();
const SHOTS = process.env.SHOT_DIR || "/w/tests/out";
const STATS_URL = process.env.STATS_URL || (RELAY.replace(/^ws/, "http"));
const results = [];
const record = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  — " + d : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader",
    "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--window-size=1280,800"],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const logs = []; page.on("console", (m) => logs.push(m.text())); page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
const waitLog = async (re, timeout = 180000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs.some((l) => re.test(l))) return logs.find((l) => re.test(l));
    await sleep(250);
  }
  return "";
};

const url = BASE + "/?connect=" + encodeURIComponent(RELAY + "/udp/" + TARGET) + "&autostart=1";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
const connected = await waitLog(/client: connected, sending info/);
record("经后端进入服务器", Boolean(connected));

if (EXPECT === "webrtc") {
  const jsLine = await waitLog(/\[ddws\] transport=webrtc/);
  record("浏览器选择了 WebRTC 数据通道", Boolean(jsLine), jsLine.slice(0, 200));
  const engineLine = await waitLog(/transport for .*: WebRTC data channel/);
  record("引擎确认使用 WebRTC 数据通道", Boolean(engineLine), engineLine.slice(-160));
  try {
    const stats = await fetch(STATS_URL + "/api/stats").then((r) => r.json());
    const rtc = stats.rtc || {};
    record("后端统计出现 WebRTC 游戏会话", Number(rtc.gameSessions) >= 1 && Number(rtc.gamePacketsToTarget) > 0,
      JSON.stringify({ gameSessions: rtc.gameSessions, to: rtc.gamePacketsToTarget, from: rtc.gamePacketsFromTarget, active: rtc.activeGameSessions }));
  } catch (e) { record("后端统计出现 WebRTC 游戏会话", false, String(e.message)); }
  let hud = "";
  try {
    await page.waitForFunction(() => /WebRTC/.test((document.querySelector("#hud-transport") || {}).textContent || ""), { timeout: 20000 });
    hud = await page.$eval("#hud-transport", (e) => e.textContent.trim());
  } catch (e) {
    hud = await page.$eval("#hud-transport", (e) => e.textContent.trim()).catch(() => "");
  }
  record("HUD 显示传输方式为 WebRTC", /WebRTC/.test(hud), hud);
} else {
  const jsLine = await waitLog(/\[ddws\] WebRTC unavailable .*falling back to WebSocket/);
  record("WebRTC 不可用时自动回退", Boolean(jsLine), jsLine.slice(0, 200));
  const engineLine = await waitLog(/transport for .*: WebSocket \(fallback\)/);
  record("引擎确认使用 WebSocket 回退", Boolean(engineLine), engineLine.slice(-160));
  try {
    const stats = await fetch(STATS_URL + "/api/stats").then((r) => r.json());
    const targets = stats.targets || [];
    const hit = targets.find((t) => JSON.stringify(t).includes(TARGET));
    record("回退后 WebSocket 路径有流量", Boolean(hit) && Number(hit.bytesToTarget) > 0, hit ? JSON.stringify(hit).slice(0, 160) : "无目标");
  } catch (e) { record("回退后 WebSocket 路径有流量", false, String(e.message)); }
}
await page.screenshot({ path: SHOTS + "/transport-" + EXPECT + ".png" }).catch(() => {});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
