/**
 * Windows / Linux / macOS 触屏或触控显示器：
 * 即使 maxTouchPoints > 0 / pointer:coarse，只要不是移动 UA 且屏幕够大，就按桌面处理：
 * 不显示触屏操作面板，启动参数显式 cl_touch_controls 0。
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const RELAY = process.env.RELAY_URL || "ws://127.0.0.1:8390";
const TARGET = process.env.TARGET || "127.0.0.1:8313";
const SHOTS = process.env.SHOT_DIR || "/w/tests/out";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const results = [];
const record = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  — " + d : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader",
    "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setUserAgent(WIN_UA);
await page.setViewport({ width: 1280, height: 800, isMobile: false, hasTouch: true });
const logs = []; page.on("console", (m) => logs.push(m.text())); page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
// 无头浏览器的 screen 默认是 800x600；模拟真实桌面 1920x1080 屏幕。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(window.screen, "width", { get: () => 1920 });
  Object.defineProperty(window.screen, "height", { get: () => 1080 });
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => globalThis.__ddwebDebug && globalThis.__ddwebDebug.relayStore && globalThis.__ddwebDebug.relayStore.list().length > 0, { timeout: 30000 });
const later = await page.$("#btn-download-later");
if (later) { await later.click(); await sleep(400); }
const device = await page.evaluate(() => ({
  device: document.documentElement.dataset.device,
  cls: document.body.className,
  touchPoints: navigator.maxTouchPoints,
  coarse: matchMedia("(pointer: coarse)").matches,
  fine: matchMedia("(pointer: fine)").matches,
}));
record("触屏 PC 识别为 desktop", device.device === "desktop" && /\bis-desktop\b/.test(device.cls || ""), JSON.stringify(device));

await page.evaluate(async () => { const d = globalThis.__ddwebDebug; await d.connectToRelay(d.relayStore.list()[0]); });
await page.waitForFunction(() => globalThis.__ddwebDebug.state.servers.status === "ok", { timeout: 60000 });
await sleep(400);
const guide = await page.evaluate(() => {
  const el = document.querySelector("#touch-guide");
  const r = el ? el.getBoundingClientRect() : null;
  return { hidden: !el || el.hidden || !r || r.height === 0, stored: localStorage.getItem("ddweb.touch-guide-dismissed.v1") };
});
record("触屏 PC 不显示触屏操作面板", guide.hidden === true, JSON.stringify(guide));

const url = BASE + "/?connect=" + encodeURIComponent(RELAY + "/udp/" + TARGET) + "&autostart=1";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
const connected = await (async () => { const start = Date.now(); while (Date.now() - start < 180000) { if (logs.some((l) => /client: connected, sending info/.test(l))) return true; await sleep(300); } return false; })();
record("触屏 PC 经后端进入游戏", connected === true);
await sleep(800);
const inGame = await page.evaluate(() => {
  const el = document.querySelector("#touch-hint");
  const r = el ? el.getBoundingClientRect() : null;
  const st = globalThis.__ddwebDebug && globalThis.__ddwebDebug.state;
  return {
    hintHidden: !el || el.hidden || !r || r.height === 0,
    args: (st && st.runtime && st.runtime.args) || [],
    fullscreenHidden: (() => { const b = document.querySelector("#btn-touch-fullscreen"); if (!b) return true; const br = b.getBoundingClientRect(); return br.width === 0 || br.height === 0; })(),
  };
});
record("触屏 PC 游戏内不显示触屏提示", inGame.hintHidden === true);
record("触屏 PC 启动参数关闭内置触屏控件", inGame.args[0] === "cl_touch_controls 0" && inGame.args[1] === "cl_back_button 0", JSON.stringify(inGame.args));
await page.screenshot({ path: SHOTS + "/desktop-touch.png" }).catch(() => {});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
