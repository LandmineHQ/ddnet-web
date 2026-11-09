/**
 * DDNet 官方 master 服务器列表 + 筛选验收：
 *  - 列表来自 master1..4，展示全部服务器（非静态推荐列表）
 *  - 搜索 / 类型 / 地区 / 协议 / 隐藏满员 / 隐藏密码房 生效
 *  - 分页与计数正确
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
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
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const logs = []; page.on("console", (m) => logs.push(m.text())); page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => globalThis.__ddwebDebug && globalThis.__ddwebDebug.relayStore && globalThis.__ddwebDebug.relayStore.list().length > 0, { timeout: 30000 });
// 关闭首次下载弹窗，避免遮住筛选控件（本测试不需要 wasm 资源）。
const later = await page.$("#btn-download-later");
if (later) { await later.click(); await sleep(500); }

const state = () => page.evaluate(() => {
  const st = globalThis.__ddwebDebug && globalThis.__ddwebDebug.state;
  if (!st) return null;
  return {
    view: st.view,
    status: st.servers.status,
    source: st.servers.source,
    total: st.servers.list.length,
    filters: { ...st.servers.filters },
    query: st.servers.query,
    filtered: globalThis.__ddwebDebug.filteredServers().length,
    cards: document.querySelectorAll("#server-list .server-card").length,
    countText: (document.querySelector("#servers-count") || {}).textContent || "",
    subtitle: (document.querySelector("#servers-subtitle") || {}).textContent || "",
  };
});

// 直接用调试 API 连接后端，跳过客户端资源下载（服务器列表不需要 wasm）。
await page.evaluate(async () => {
  const debug = globalThis.__ddwebDebug;
  const relay = debug.relayStore.list()[0];
  await debug.connectToRelay(relay);
});
await page.waitForFunction(() => globalThis.__ddwebDebug && globalThis.__ddwebDebug.state.servers.status === "ok", { timeout: 60000 });
await sleep(500);

let snap = await state();
record("服务器列表来自 DDNet 官方 master", snap.source === "master" && snap.total > 1000, snap.total + " 台 · " + snap.subtitle.slice(0, 100));
record("默认展示全部服务器（首屏 20 张）", snap.filtered === snap.total && snap.cards === 20, "filtered=" + snap.filtered + " cards=" + snap.cards);
record("筛选计数显示", /筛选后 \d+ \/ \d+ 台/.test(snap.countText), snap.countText);
await page.screenshot({ path: SHOTS + "/servers-master-all.png" });

// 搜索
await page.type("#server-search", "Tutorial", { delay: 15 });
await sleep(500);
snap = await state();
record("搜索 Tutorial 生效", snap.filtered > 0 && snap.filtered < snap.total && snap.query === "Tutorial", snap.filtered + " 台");
await page.evaluate(() => { const input = document.querySelector("#server-search"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); });
await sleep(400);

// 类型筛选
const typeValue = await page.evaluate(() => {
  const options = [...document.querySelectorAll("#server-filter-type option")].filter((o) => o.value);
  return options.length ? options[0].value : "";
});
if (typeValue) {
  await page.select("#server-filter-type", typeValue);
  await sleep(400);
  snap = await state();
  const expected = await page.evaluate((type) => globalThis.__ddwebDebug.state.servers.list.filter((s) => String(s.gameType).toLowerCase() === String(type).toLowerCase()).length, typeValue);
  record("类型筛选生效", snap.filtered === expected && snap.filtered < snap.total, typeValue + " · actual=" + snap.filtered + " expected=" + expected);
} else record("类型筛选生效", false, "无类型选项");

// 地区筛选
await page.select("#server-filter-type", "");
await sleep(300);
const regionValue = await page.evaluate(() => {
  const options = [...document.querySelectorAll("#server-filter-region option")].filter((o) => o.value);
  return options.length ? options[0].value : "";
});
if (regionValue) {
  await page.select("#server-filter-region", regionValue);
  await sleep(400);
  snap = await state();
  const expected = await page.evaluate((region) => globalThis.__ddwebDebug.state.servers.list.filter((s) => s.region === region).length, regionValue);
  record("地区筛选生效", snap.filtered === expected && snap.filtered < snap.total, regionValue + " · " + snap.filtered + " 台");
} else record("地区筛选生效", false, "无地区选项");

// 协议筛选
await page.select("#server-filter-region", "");
await sleep(300);
await page.select("#server-filter-protocol", "7");
await sleep(400);
snap = await state();
const expected7 = await page.evaluate(() => globalThis.__ddwebDebug.state.servers.list.filter((s) => s.protocol === 7).length);
record("协议筛选 0.7 生效", snap.filtered === expected7, snap.filtered + " 台（0.7）");
await page.select("#server-filter-protocol", "");
await sleep(300);

// 隐藏满员 / 密码房
const fullCount = await page.evaluate(() => globalThis.__ddwebDebug.state.servers.list.filter((s) => Number.isFinite(s.maxPlayers) && s.maxPlayers > 0 && s.players >= s.maxPlayers).length);
await page.click("#server-filter-hide-full");
await sleep(400);
snap = await state();
record("隐藏满员生效", snap.filters.hideFull === true && snap.filtered === snap.total - fullCount, "满员 " + fullCount + " actual=" + snap.filtered + " expected=" + (snap.total - fullCount) + " flag=" + snap.filters.hideFull);
await page.click("#server-filter-hide-full");
await sleep(300);
const lockedCount = await page.evaluate(() => globalThis.__ddwebDebug.state.servers.list.filter((s) => s.passworded).length);
await page.click("#server-filter-hide-locked");
await sleep(400);
snap = await state();
record("隐藏密码房生效", snap.filters.hideLocked === true && snap.filtered === snap.total - lockedCount, "密码房 " + lockedCount + " actual=" + snap.filtered + " expected=" + (snap.total - lockedCount) + " flag=" + snap.filters.hideLocked);
await page.click("#server-filter-hide-locked");
await sleep(300);

// 分页：第 2 页仍是 20 张卡片，页码正确
const pagerButtons = await page.$$eval("#server-pager button", (els) => els.map((el) => el.textContent.trim()));
if (pagerButtons.includes("下一页")) {
  await page.evaluate(() => { const btn = [...document.querySelectorAll("#server-pager button")].find((el) => el.textContent.trim() === "下一页"); btn.click(); });
  await sleep(400);
  const page2 = await page.evaluate(() => ({ cards: document.querySelectorAll("#server-list .server-card").length, pager: (document.querySelector("#server-pager") || {}).textContent || "" }));
  record("分页下一页生效", page2.cards === 20 && /第 2 \//.test(page2.pager), page2.pager.replace(/\s+/g, " ").slice(0, 60));
  await page.evaluate(() => { const btn = [...document.querySelectorAll("#server-pager button")].find((el) => el.textContent.trim() === "上一页"); btn.click(); });
  await sleep(300);
} else record("分页下一页生效", false, "没有下一页按钮");

// 排序：玩家数从多到少
await page.select("#server-filter-sort", "players");
await sleep(400);
const sorted = await page.evaluate(() => {
  const list = globalThis.__ddwebDebug.filteredServers();
  return list.length < 2 || list[0].players >= list[list.length - 1].players;
});
record("按玩家数排序生效", sorted === true);
await page.screenshot({ path: SHOTS + "/servers-master-filtered.png" });
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
