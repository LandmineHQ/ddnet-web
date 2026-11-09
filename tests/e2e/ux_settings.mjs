import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const CHROME = process.env.CHROME || "/usr/bin/chromium";
const SHOTS = process.env.SHOT_DIR || "/w/tests/out";
const results = [];
const record = (n, ok, d = "") => { results.push({ n, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
	executablePath: CHROME, headless: "new",
	args: ["--no-sandbox", "--ignore-certificate-errors", "--disable-dev-shm-usage",
		"--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
		"--autoplay-policy=no-user-gesture-required", "--window-size=1280,800"],
	defaultViewport: { width: 1280, height: 800 },
});
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });

// 跳过下载弹窗（资源会继续后台下载）
const dismissDownload = async () => {
	const later = await page.$("#btn-download-later");
	if (later) { await later.click(); await sleep(800); }
};
await dismissDownload();
await sleep(1500);

// 1) 默认亮色主题
const theme0 = await page.evaluate(() => document.documentElement.dataset.theme || "");
record("默认亮色主题", theme0 === "light", "data-theme=" + theme0);
await page.screenshot({ path: SHOTS + "/set-1-light.png" });

// 2) 切换到深色并持久化
try {
	await page.click("#btn-theme");
	await sleep(600);
	const theme1 = await page.evaluate(() => document.documentElement.dataset.theme || "");
	await page.reload({ waitUntil: "domcontentloaded" });
	await sleep(1500);
	await dismissDownload();
	const theme2 = await page.evaluate(() => document.documentElement.dataset.theme || "");
	record("主题切换并持久化", theme1 === "dark" && theme2 === "dark", `toggle=${theme1} reload=${theme2}`);
	await page.screenshot({ path: SHOTS + "/set-2-dark.png" });
	// 恢复亮色
	await page.click("#btn-theme");
	await sleep(400);
} catch (e) {
	record("主题切换并持久化", false, String(e.message));
}

// 3) 添加自定义后端
const CUSTOM = "ws://127.0.0.1:9999";
try {
	await page.click("#btn-add-relay");
	await page.waitForSelector("#relay-url", { visible: true, timeout: 10000 });
	await page.type("#relay-url", CUSTOM);
	const nameInput = await page.$("#relay-name");
	if (nameInput) { await nameInput.click(); await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control"); await page.type("#relay-name", "我的测试后端"); }
	await page.click("#btn-relay-save");
	await page.waitForFunction((u) => [...document.querySelectorAll("#relay-grid .relay-card")].some((c) => (c.textContent || "").includes("127.0.0.1:9999") || (c.textContent || "").includes(u)), { timeout: 15000 }, CUSTOM);
	record("添加自定义后端", true, CUSTOM);
} catch (e) {
	record("添加自定义后端", false, String(e.message));
}

// 4) 编辑自定义后端
try {
	const edited = await page.evaluate(() => {
		const cards = [...document.querySelectorAll("#relay-grid .relay-card")];
		const target = cards.find((c) => (c.textContent || "").includes("127.0.0.1:9999"));
		if (!target) return false;
		const btn = target.querySelector('.relay-card-actions [data-action="edit"]');
		if (!btn) return "no-edit-button";
		btn.click();
		return true;
	});
	if (edited !== true) throw new Error("编辑按钮不可用: " + edited);
	await page.waitForSelector("#relay-url", { visible: true, timeout: 10000 });
	const prefilled = await page.$eval("#relay-url", (e) => e.value);
	const nameInput = await page.$("#relay-name");
	await nameInput.click();
	await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
	await page.type("#relay-name", "改过名的后端");
	await page.click("#btn-relay-save");
	await page.waitForFunction(() => [...document.querySelectorAll("#relay-grid .relay-card")].some((c) => (c.textContent || "").includes("改过名的后端")), { timeout: 15000 });
	record("编辑自定义后端", true, "预填 URL=" + prefilled);
} catch (e) {
	record("编辑自定义后端", false, String(e.message));
}

// 5) 删除自定义后端（二次确认弹层）
try {
	const before = await page.$$eval("#relay-grid .relay-card", (els) => els.length);
	const clicked = await page.evaluate(() => {
		const cards = [...document.querySelectorAll("#relay-grid .relay-card")];
		const target = cards.find((c) => (c.textContent || "").includes("改过名的后端") || (c.textContent || "").includes("127.0.0.1:9999"));
		if (!target) return false;
		const btn = target.querySelector('.relay-card-actions [data-action="delete"]');
		if (!btn) return "no-delete-button";
		btn.click();
		return true;
	});
	if (clicked !== true) throw new Error("删除按钮不可用: " + clicked);
	await page.waitForSelector("#confirm-dialog", { visible: true, timeout: 10000 });
	const confirmText = await page.$eval("#confirm-dialog", (e) => e.innerText.replace(/\s+/g, " ").slice(0, 80));
	await page.click("#btn-confirm-ok");
	await sleep(1200);
	const finalCount = await page.$$eval("#relay-grid .relay-card", (els) => els.length);
	const gone = await page.evaluate(() => ![...document.querySelectorAll("#relay-grid .relay-card")].some((c) => (c.textContent || "").includes("127.0.0.1:9999") || (c.textContent || "").includes("改过名的后端")));
	record("删除自定义后端", finalCount < before && gone, `${before} -> ${finalCount}；确认弹层: ${confirmText.slice(0, 40)}`);
	await page.screenshot({ path: SHOTS + "/set-3-deleted.png" });
} catch (e) {
	record("删除自定义后端", false, String(e.message));
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
