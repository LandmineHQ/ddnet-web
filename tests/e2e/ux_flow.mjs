import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const TIMEOUT = Number(process.env.TIMEOUT_MS || 240000);
const CHROME = process.env.CHROME || "/usr/bin/chromium";
const RELAY_URL = process.env.RELAY_URL || "ws://127.0.0.1:8390";
const TARGET = process.env.TARGET || "74.91.126.203:8300";
const SHOTS = process.env.SHOT_DIR || "/w/tests/out";

const results = [];
const record = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: "new",
	args: ["--no-sandbox", "--ignore-certificate-errors", "--disable-dev-shm-usage",
		"--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
		"--autoplay-policy=no-user-gesture-required", "--window-size=1280,800"],
	defaultViewport: { width: 1280, height: 800 },
});
const context = await browser.createBrowserContext();
const page = await context.newPage();
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR " + e));

async function waitVisible(selector, timeout = 30000) {
	const handle = await page.waitForSelector(selector, { visible: true, timeout });
	return handle;
}
async function exists(selector) {
	return (await page.$(selector)) !== null;
}
async function clickFirst(selectors) {
	for (const sel of selectors) {
		const el = await page.$(sel);
		if (el) { await el.click(); return sel; }
	}
	throw new Error("none of the selectors found: " + selectors.join(", "));
}

const started = Date.now();
console.log("[ux] loading " + BASE);
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });

// 1) 首次访问：资源下载确认
try {
	await waitVisible("#btn-download-start", 20000);
	const dialogText = await page.$eval("body", (b) => b.innerText);
	const mentions = ["DDNet.wasm", "DDNet.data"].filter((n) => dialogText.includes(n));
	record("首次访问显示下载确认", true, "提到 " + mentions.join("/"));
	await page.screenshot({ path: SHOTS + "/ux-1-consent.png" });
	await page.click("#btn-download-start");
} catch (e) {
	record("首次访问显示下载确认", false, String(e.message));
}

// 2) 右下角下载组件
try {
	await waitVisible("#widget-progress", 15000);
	record("右下角下载进度组件出现", true);
	await page.screenshot({ path: SHOTS + "/ux-2-widget.png" });
} catch (e) {
	record("右下角下载进度组件出现", false, String(e.message));
}

// 3) 中继列表
let relayReady = true;
try {
	await waitVisible("#relay-grid", 60000);
	const cards = await page.$$eval("#relay-grid .relay-card", (els) => els.length);
	if (cards === 0) {
		// 添加自定义后端
		await page.click("#btn-add-relay");
		await waitVisible("#relay-url", 10000);
		await page.type("#relay-url", RELAY_URL);
		const nameInput = await page.$("#relay-name");
		if (nameInput) await page.type("#relay-name", "本地中继");
		await page.click("#btn-relay-save");
		await sleep(1000);
	}
	const cardCount = await page.$$eval("#relay-grid .relay-card", (els) => els.length);
	record("中继列表出现后端卡片", cardCount > 0, "卡片数 " + cardCount);
	await page.screenshot({ path: SHOTS + "/ux-3-relays.png" });
} catch (e) {
	relayReady = false;
	record("中继列表出现后端卡片", false, String(e.message));
}

// 4) 中继延迟数值（本地中继优先 WebRTC；无 WebRTC 时回退 WS/HTTP）
if (relayReady) {
	try {
		await page.waitForFunction(() => {
			const badges = [...document.querySelectorAll("#relay-grid .latency-badge")];
			return badges.some((b) => /\d/.test(b.textContent || ""));
		}, { timeout: 30000 });
		const value = await page.$eval("#relay-grid .latency-badge", (b) => b.textContent.trim());
		record("中继延迟测量（WebRTC 或回退）", true, value);
		const methods = await page.evaluate(() => {
			const st = globalThis.__ddwebDebug && globalThis.__ddwebDebug.state;
			return st ? [...st.latency.values()].map((entry) => entry.method).filter(Boolean) : [];
		});
		record("延迟测量优先使用 WebRTC", methods.includes("webrtc"), methods.join(",") || "无");
	} catch (e) {
		record("中继延迟测量（WebRTC 或回退）", false, String(e.message));
	}
}

// 5) 选择后端 → 载入页 / 服务器列表
if (relayReady) {
	try {
		const clicked = await clickFirst(["#relay-grid .relay-card .btn", "#relay-grid .relay-card"]);
		console.log("[ux] clicked relay via " + clicked);
		await sleep(1500);
		const loadingVisible = await exists("#loading-view");
		if (loadingVisible) {
			await page.screenshot({ path: SHOTS + "/ux-4-loading.png" });
			record("中央载入页（可关闭）", await exists("#btn-loading-close"), "有关闭按钮");
		} else {
			record("中央载入页（可关闭）", true, "资源已缓存，直接进入服务器列表");
		}
	} catch (e) {
		record("中央载入页（可关闭）", false, String(e.message));
	}
}

// 6) 服务器列表：DDNet 官方 master 全量列表 + 搜索
let serverListReady = false;
let useManualTarget = false;
try {
	await waitVisible("#view-servers", 180000);
	await page.waitForFunction(() => document.querySelectorAll("#server-list .server-card").length > 0, { timeout: 60000 });
	const meta = await page.evaluate(() => {
		const st = globalThis.__ddwebDebug && globalThis.__ddwebDebug.state;
		return {
			total: st && st.servers ? st.servers.list.length : 0,
			source: st && st.servers ? st.servers.source : '',
			subtitle: (document.querySelector("#servers-subtitle") || {}).textContent || "",
		};
	});
	record("服务器列表来自 DDNet 官方 master", meta.source === "master" && meta.total > 100, meta.total + " 台 / " + meta.subtitle.slice(0, 120));
	await page.type("#server-search", TARGET.split(":")[0], { delay: 20 });
	await sleep(500);
	const filtered = await page.$$eval("#server-list .server-card", (els) => els.length);
	if (filtered > 0) {
		record("搜索筛选生效", filtered < meta.total, "筛选后首屏 " + filtered + " 张卡片（总 " + meta.total + "）");
		serverListReady = true;
	} else {
		// 本地测试服不在官方 master 中：改用手动输入，仍走同一条后端连接链路。
		useManualTarget = true;
		serverListReady = true;
		record("搜索筛选生效", true, "本地 TARGET " + TARGET + " 不在官方 master，改用手动输入");
	}
	await page.screenshot({ path: SHOTS + "/ux-5-servers.png" });
} catch (e) {
	record("服务器列表来自 DDNet 官方 master", false, String(e.message));
	record("搜索筛选生效", false, String(e.message));
	const errText = await page.evaluate(() => (document.querySelector("#servers-error") || {}).innerText || "");
	if (errText) console.log("[ux] 错误面板内容: " + errText.slice(0, 300));
}

// 7) 进入游戏（官方 TARGET 点列表卡片；本地 TARGET 走手动输入）
try {
	if (!serverListReady) throw new Error("服务器列表未就绪");
	if (useManualTarget) {
		await page.evaluate(() => { const d = document.querySelector("#advanced-connect"); if (d) d.open = true; });
		await page.type("#manual-target", TARGET, { delay: 20 });
		await page.click("#btn-manual-connect");
	} else {
		const btn = await page.$("#server-list .server-card .btn, #server-list .server-card button");
		if (btn) await btn.click();
		else await page.click("#server-list .server-card");
	}
	const ok = await page.waitForFunction(
		() => [...document.querySelectorAll("canvas")].some((c) => c.offsetWidth > 300 && getComputedStyle(c).display !== "none"),
		{ timeout: 180000 });
	record("进入游戏（canvas 可见）", Boolean(ok), "耗时 " + Math.round((Date.now() - started) / 1000) + "s");
	await sleep(8000);
	await page.screenshot({ path: SHOTS + "/ux-6-game.png" });
} catch (e) {
	record("进入游戏（canvas 可见）", false, String(e.message));
}

// 8) 引擎连接日志
const connected = logs.some((l) => /client: connected, sending info/.test(l));
record("引擎日志出现 connected", connected, logs.filter((l) => /client:/.test(l)).slice(-2).join(" | "));

// 9) 聚光灯引导
try {
	await waitVisible("#spotlight", 20000);
	const title = await page.$eval("#spotlight-title", (e) => e.textContent.trim()).catch(() => "");
	record("进入游戏触发聚光灯引导", true, title);
	await page.screenshot({ path: SHOTS + "/ux-7-spotlight.png" });
	await clickFirst(["#btn-spotlight-skip", "#btn-spotlight-next"]);
} catch (e) {
	record("进入游戏触发聚光灯引导", false, String(e.message));
}

// 10) Ctrl+`（Backquote，~ 键）切换面板；Ctrl+Esc 被 Windows 占用，不再使用
try {
	const before = await page.$eval("#hud-panel", (e) => { const st = getComputedStyle(e); return !e.hidden && st.display !== "none" && st.visibility !== "hidden" && e.getBoundingClientRect().width > 0; }).catch(() => false);
	await page.keyboard.down("Control");
	await page.keyboard.press("Backquote");
	await page.keyboard.up("Control");
	await sleep(400);
	const after = await page.$eval("#hud-panel", (e) => { const st = getComputedStyle(e); return !e.hidden && st.display !== "none" && st.visibility !== "hidden" && e.getBoundingClientRect().width > 0; }).catch(() => false);
	record("Ctrl+` 切换后端面板", before !== after, `before=${before} after=${after}`);
	await page.keyboard.down("Control");
	await page.keyboard.press("Backquote");
	await page.keyboard.up("Control");
} catch (e) {
	record("Ctrl+` 切换后端面板", false, String(e.message));
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log("\n---- summary ----");
for (const r of results) console.log((r.ok ? "✔" : "✘") + " " + r.name + (r.detail ? "  — " + r.detail : ""));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
