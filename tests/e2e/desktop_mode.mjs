/**
 * 桌面/非触控设备验收：
 *  - 识别为 desktop，页面不显示触屏引导/提示/全屏按钮
 *  - 启动参数显式关闭 DDNet 内置触屏控件（cl_touch_controls 0 / cl_back_button 0），
 *    connect <url> 仍是最后一条命令
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
    "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800"],
  defaultViewport: { width: 1280, height: 800, isMobile: false, hasTouch: false },
});
const page = await browser.newPage();
const logs = []; page.on("console", (m) => logs.push(m.text())); page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
const waitLog = async (re, timeout = 180000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs.some((l) => re.test(l))) return true;
    await sleep(250);
  }
  return false;
};
const url = BASE + "/?connect=" + encodeURIComponent(RELAY + "/udp/" + TARGET) + "&autostart=1";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
record("桌面端经后端进入游戏", await waitLog(/client: connected, sending info/));
await sleep(1500);
// 新手引导已改为四块遮罩；检查不会再用 9999px box-shadow 覆盖 WebGL 画布
await page.waitForFunction(() => { const el = document.querySelector("#spotlight"); return el && !el.hidden; }, { timeout: 15000 }).catch(() => {});
const spotlight = await page.evaluate(() => {
  const el = document.querySelector("#spotlight");
  const hole = document.querySelector("#spotlight-hole");
  const shades = [...document.querySelectorAll(".spotlight-shade")];
  return {
    visible: Boolean(el && !el.hidden),
    shades: shades.length,
    shadeVisible: shades.filter((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length,
    boxShadow: hole ? getComputedStyle(hole).boxShadow : "",
    cursor: getComputedStyle(document.querySelector("#canvas")).cursor,
  };
});
record("聚光灯使用轻量遮罩（无 9999px box-shadow）", spotlight.visible && spotlight.shades === 4 && spotlight.shadeVisible >= 2 && !/9999px/.test(spotlight.boxShadow), JSON.stringify(spotlight).slice(0, 180));
record("画布隐藏浏览器光标", spotlight.cursor === "none", spotlight.cursor);
// 点击画布捕获鼠标；释放后不应影响游戏
// 关闭菜单后再点击画布恢复捕获
for (let i = 0; i < 3; i++) {
  if (!(await page.evaluate(() => { try { return Module._DDWeb_IsMenuOpen() === 1; } catch (error) { return false; } }))) break;
  await page.keyboard.press("Escape");
  await sleep(400);
}
await page.mouse.click(640, 400);
await page.waitForFunction(() => document.pointerLockElement && document.pointerLockElement.id === "canvas", { timeout: 10000 }).catch(() => {});
await sleep(300);
const locked = await page.evaluate(() => ({ lock: document.pointerLockElement ? document.pointerLockElement.id : null, cls: document.body.classList.contains("is-pointer-locked"), debug: globalThis.__ddwebDebug.isPointerLocked() }));
record("点击画布捕获鼠标", locked.lock === "canvas" && locked.cls === true && locked.debug === true, JSON.stringify(locked));
// Tab 计分板：网页侧只隐藏 HUD 浮层，不把 Tab 交给浏览器做焦点切换
await page.keyboard.down("Tab");
await sleep(350);
const tabState = await page.evaluate(() => {
  const hud = document.querySelector("#hud-panel");
  const rect = hud ? hud.getBoundingClientRect() : null;
  return { cls: document.body.classList.contains("is-scoreboard-open"), hudHidden: !hud || hud.hidden || !rect || rect.height === 0 };
});
record("Tab 计分板隐藏网页 HUD 浮层", tabState.cls === true && tabState.hudHidden === true, JSON.stringify(tabState));
await page.keyboard.up("Tab");
await sleep(250);
record("松开 Tab 后 HUD 恢复", await page.evaluate(() => !document.body.classList.contains("is-scoreboard-open")));
// 打开游戏菜单（无头环境下第一次 ESC 可能被 pointer lock 吃掉，第二次才打开），
// 再模拟浏览器解除 pointer lock，界面上 UI::Update 才会运行并绘制菜单光标。
for (let i = 0; i < 4; i++) {
  if (await page.evaluate(() => { try { return Module._DDWeb_IsMenuOpen() === 1; } catch (error) { return false; } })) break;
  await page.keyboard.press("Escape");
  await sleep(500);
}
await page.evaluate(() => document.exitPointerLock());
await page.waitForFunction(() => !document.pointerLockElement && !document.body.classList.contains("is-pointer-locked"), { timeout: 5000 }).catch(() => {});
const released = await page.evaluate(() => ({ lock: document.pointerLockElement ? document.pointerLockElement.id : null, cls: document.body.classList.contains("is-pointer-locked"), menu: document.body.classList.contains("is-menu-open") }));
record("释放鼠标后状态同步", released.lock === null && released.cls === false && released.menu === true, JSON.stringify(released));
// 解锁后游戏内光标应跟随真实鼠标位置
await page.mouse.move(200, 150);
await sleep(400);
const uiMouse = await page.evaluate(() => {
  try {
    return { x: Module.ccall("DDWeb_GetUiMouseX", "number", [], []), y: Module.ccall("DDWeb_GetUiMouseY", "number", [], []) };
  } catch (error) {
    return { error: String(error && error.message) };
  }
});
record("游戏光标跟随实际鼠标位置", Math.abs(uiMouse.x - 200) <= 3 && Math.abs(uiMouse.y - 150) <= 3, JSON.stringify(uiMouse));
// 解锁状态下移动只允许 lerp 追踪，不应再叠加相对增量（否则会到 600,450 附近）
await page.mouse.move(400, 300);
await sleep(700);
const uiMouse2 = await page.evaluate(() => ({ x: Module.ccall("DDWeb_GetUiMouseX", "number", [], []), y: Module.ccall("DDWeb_GetUiMouseY", "number", [], []) }));
record("解锁状态不再叠加相对鼠标位移", Math.abs(uiMouse2.x - 400) <= 3 && Math.abs(uiMouse2.y - 300) <= 3, JSON.stringify(uiMouse2));
// 相邻位置直接写坐标，不做插值延迟
await page.mouse.move(402, 302);
await sleep(250);
const uiMouse3 = await page.evaluate(() => ({ x: Module.ccall("DDWeb_GetUiMouseX", "number", [], []), y: Module.ccall("DDWeb_GetUiMouseY", "number", [], []) }));
record("相邻光标位置直接落点", Math.abs(uiMouse3.x - 402) <= 1 && Math.abs(uiMouse3.y - 302) <= 1, JSON.stringify(uiMouse3));
// 关闭菜单后再点击画布恢复捕获
for (let i = 0; i < 3; i++) {
  if (!(await page.evaluate(() => { try { return Module._DDWeb_IsMenuOpen() === 1; } catch (error) { return false; } }))) break;
  await page.keyboard.press("Escape");
  await sleep(400);
}
await page.mouse.click(640, 400);
await page.waitForFunction(() => document.pointerLockElement && document.pointerLockElement.id === "canvas", { timeout: 10000 }).catch(() => {});
await sleep(300);
const relocked = await page.evaluate(() => ({ lock: document.pointerLockElement ? document.pointerLockElement.id : null, cls: document.body.classList.contains("is-pointer-locked"), menu: document.body.classList.contains("is-menu-open") }));
record("再次点击画布恢复鼠标捕获", relocked.lock === "canvas" && relocked.cls === true && relocked.menu === false, JSON.stringify(relocked));
await page.evaluate(() => document.exitPointerLock());
await sleep(200);
await page.screenshot({ path: SHOTS + "/desktop-pointer.png" });
const info = await page.evaluate(() => {
  const st = globalThis.__ddwebDebug && globalThis.__ddwebDebug.state;
  const hidden = (sel) => { const el = document.querySelector(sel); if (!el) return true; const rect = el.getBoundingClientRect(); return el.hidden || getComputedStyle(el).display === "none" || rect.width === 0 || rect.height === 0; };
  return {
    device: document.documentElement.dataset.device || "",
    bodyClass: document.body.className,
    args: (st && st.runtime && st.runtime.args) || [],
    guideHidden: hidden("#touch-guide"),
    hintHidden: hidden("#touch-hint"),
    touchFullscreenHidden: hidden("#btn-touch-fullscreen"),
    touchHintFullscreenHidden: hidden("#btn-touch-hint-fullscreen"),
  };
}).catch((e) => ({ error: String(e) }));
record("识别为 desktop", info.device === "desktop" && /\bis-desktop\b/.test(info.bodyClass || ""), JSON.stringify({ device: info.device, cls: info.bodyClass }));
record("不显示触屏引导", info.guideHidden === true);
record("不显示触屏提示条", info.hintHidden === true);
const args = Array.isArray(info.args) ? info.args : [];
record("启动参数显式关闭触屏控件", args[0] === "cl_touch_controls 0" && args[1] === "cl_back_button 0" && (args[args.length - 1] || "").startsWith("connect "), JSON.stringify(args));
record("不显示触屏全屏按钮", info.touchFullscreenHidden === true && info.touchHintFullscreenHidden === true);
await page.screenshot({ path: SHOTS + "/desktop-mode.png" }).catch(() => {});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
