/**
 * 移动端（安卓/平板）适配验收：
 *  - 触屏设备被识别为 mobile/tablet（<html data-device> + body class）
 *  - 服务器/游戏页展示触屏操作指南与全屏按钮
 *  - 启动参数为 ['cl_touch_controls 1','cl_back_button 1','connect <url>']（桌面端不应出现）
 */
import puppeteer from "puppeteer-core";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const RELAY = process.env.RELAY_URL || "ws://127.0.0.1:8390";
const TARGET = process.env.TARGET || "74.91.126.203:8300";
const SHOTS = process.env.SHOT_DIR || "/w/tests/out";
const results = [];
const record = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  — " + d : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader",
    "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
});
const page = await browser.newPage();
const ua = await browser.userAgent();
await page.setUserAgent(ua.replace(/HeadlessChrome|Chrome\/[\d.]+/, "Chrome/131.0.0.0") + " Mobile");
const logs = []; page.on("console", (m) => logs.push(m.text())); page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
const waitLog = async (re, timeout = 180000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (logs.some((l) => re.test(l))) return true; await sleep(250); }
  return false;
};

const url = BASE + "/?connect=" + encodeURIComponent(RELAY + "/udp/" + TARGET) + "&autostart=1";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
const connected = await waitLog(/client: connected, sending info/);
record("移动端经后端进入游戏", connected);

const info = await page.evaluate(() => {
  const st = globalThis.__ddwebDebug && globalThis.__ddwebDebug.state;
  const guide = document.querySelector("#touch-guide");
  const hint = document.querySelector("#touch-hint");
  const fs = document.querySelector("#btn-touch-fullscreen");
  return {
    device: document.documentElement.dataset.device || "",
    bodyClass: document.body.className,
    touchMode: st && st.device && st.device.touchMode,
    args: st && st.runtime && st.runtime.args,
    guideVisible: Boolean(guide && !guide.hidden),
    hintVisible: Boolean(hint && !hint.hidden),
    spotlightHidden: (() => { const sp = document.querySelector("#spotlight"); return Boolean(sp && sp.hidden); })(),
    fullscreenButton: Boolean(fs),
    canvasTouchAction: (() => { const c = document.querySelector("#canvas"); return c ? getComputedStyle(c).touchAction : ""; })(),
  };
}).catch((e) => ({ error: String(e) }));
record("识别为触屏设备", /mobile|tablet/.test(info.device || "") && info.touchMode === true, JSON.stringify({ device: info.device, cls: info.bodyClass }));
record("触屏操作指南/游戏内提示可见", info.guideVisible === true || info.hintVisible === true, JSON.stringify({ guide: info.guideVisible, hint: info.hintVisible }));
record("全屏按钮存在", info.fullscreenButton === true);
record("移动端不自动弹出 HUD 聚光灯", info.spotlightHidden === true);
// 触屏提示条上的「信息」按钮应能打开/关闭 HUD（移动端没有 Ctrl+`）
let hudToggle = false;
try {
  // 用真实触摸事件而不是 page.click：移动端按钮是触屏交互。
  const tap = async (selector) => {
    const point = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, selector);
    await page.touchscreen.tap(point.x, point.y);
    await sleep(500);
  };
  await tap("#btn-touch-hint-hud");
  const opened = await page.evaluate(() => { const el = document.querySelector("#hud-panel"); return Boolean(el && !el.hidden); });
  await tap("#btn-hud-close");
  const closed = await page.evaluate(() => { const el = document.querySelector("#hud-panel"); return Boolean(el && el.hidden); });
  hudToggle = opened && closed;
} catch (e) { hudToggle = false; }
record("触屏「信息」按钮可开关 HUD", hudToggle);
record("canvas 禁用浏览器手势", info.canvasTouchAction === "none", String(info.canvasTouchAction));
const args = Array.isArray(info.args) ? info.args : [];
record("启动参数启用内置触屏控件", args[0] === "cl_touch_controls 1" && args.some((a) => a === "cl_back_button 1") && args[args.length - 1].startsWith("connect "), JSON.stringify(args));
await page.screenshot({ path: SHOTS + "/mobile-game-final.png" }).catch(() => {});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
