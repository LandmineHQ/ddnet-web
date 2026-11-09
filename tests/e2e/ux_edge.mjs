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

// ---- A) 下载完成后刷新，不应再要求下载（缓存命中） ----
const ctxA = await browser.createBrowserContext();
const pageA = await ctxA.newPage();
const logsA = [];
pageA.on("console", (m) => logsA.push(m.text()));
await pageA.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
try {
	await pageA.waitForSelector("#btn-download-start", { visible: true, timeout: 20000 });
	await pageA.click("#btn-download-start");
	await pageA.waitForFunction(() => {
		const el = document.querySelector("#cache-badge");
		return el && !el.hidden && /已缓存|缓存/.test(el.textContent || "");
	}, { timeout: 180000 });
	record("首次下载完成后出现缓存标记", true);
} catch (e) {
	record("首次下载完成后出现缓存标记", false, String(e.message));
}
await pageA.reload({ waitUntil: "domcontentloaded" });
await sleep(3000);
const stillAsks = await pageA.$eval("#view-download", (e) => {
	const st = getComputedStyle(e);
	return st.display !== "none" && !e.hidden && e.getBoundingClientRect().height > 0;
}).catch(() => null);
record("二次访问不再要求下载（sha256 缓存命中）", stillAsks === false || stillAsks === null, `download view visible=${stillAsks}`);
await pageA.screenshot({ path: SHOTS + "/ux-e1-cached.png" });

// ---- B) 后端连不上时的错误输出 ----
const ctxB = await browser.createBrowserContext();
const pageB = await ctxB.newPage();
await pageB.goto(BASE + "?relayUrl=" + encodeURIComponent("ws://127.0.0.1:1"), { waitUntil: "domcontentloaded", timeout: 30000 });
const startBtnB = await pageB.$("#btn-download-start");
if (startBtnB) {
	await startBtnB.click();
	await pageB.waitForFunction(() => {
		const e = document.querySelector("#cache-badge");
		return e && !e.hidden && /缓存/.test(e.textContent || "");
	}, { timeout: 180000 });
}
try {
	const clicked = await pageB.evaluate(() => {
		const cards = [...document.querySelectorAll("#relay-grid .relay-card")];
		const dead = cards.find((c) => /127\.0\.0\.1:1\b|不可用/.test(c.textContent || ""));
		if (!dead) return null;
		dead.click();
		return true;
	});
	if (!clicked) throw new Error("未找到不可用的后端卡片");
	await pageB.waitForFunction(() => {
		const err = document.querySelector("#servers-error");
		return err && !err.hidden && getComputedStyle(err).display !== "none" && (err.innerText || "").trim().length > 5;
	}, { timeout: 60000 });
	const text = await pageB.$eval("#servers-error", (e) => e.innerText.trim().replace(/\s+/g, " ").slice(0, 160));
	record("后端不可达时显示错误输出", true, text.slice(0, 100));
	await pageB.screenshot({ path: SHOTS + "/ux-e2-error.png" });
} catch (e) {
	record("后端不可达时显示错误输出", false, String(e.message));
	await pageB.screenshot({ path: SHOTS + "/ux-e2-error.png" });
}

await browser.close();const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
