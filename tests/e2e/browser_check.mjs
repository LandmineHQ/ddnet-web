#!/usr/bin/env node
// Browser end-to-end check for the DDNet web client.
//
// Loads the built client in headless Chromium, starts it with "+connect <url>"
// and reports what the engine logs. Requires the dist/web build artifacts and a
// running relay (and a reachable DDNet server behind it).
//
// Usage:
//   CHROME=/usr/bin/chromium BASE_URL=http://127.0.0.1:8392 \
//   CONNECT=ws://127.0.0.1:8390/udp/127.0.0.1:8313 \
//   node tests/e2e/browser_check.mjs [--timeout 60000] [--screenshot out.png]

import puppeteer from "puppeteer-core";

const arg = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};

const CHROME = process.env.CHROME || "/usr/bin/chromium";
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8392";
const CONNECT = process.env.CONNECT || "";
const TIMEOUT_MS = Number(arg("timeout", process.env.TIMEOUT_MS || 60000));
const SCREENSHOT = arg("screenshot", process.env.SCREENSHOT || "");

const lines = [];
const errors = [];

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: "new",
	args: [
		"--no-sandbox",
		"--ignore-certificate-errors",
		"--disable-dev-shm-usage",
		"--enable-unsafe-swiftshader",
		"--use-gl=angle",
		"--use-angle=swiftshader",
		"--autoplay-policy=no-user-gesture-required",
		"--window-size=1280,720",
	],
	defaultViewport: { width: 1280, height: 720 },
});

const page = await browser.newPage();
page.on("console", (msg) => lines.push(msg.text()));
page.on("pageerror", (err) => errors.push(String(err)));
page.on("requestfailed", (req) => errors.push(`request failed: ${req.url()} ${req.failure()?.errorText}`));
page.on("response", (res) => { if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`); });

const url = new URL(BASE_URL);
if (CONNECT) url.searchParams.set("connect", CONNECT);
url.searchParams.set("autostart", "1");

console.log(`[e2e] loading ${url.toString()}`);
await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });

const startedAt = Date.now();
let connected = false;
let lastLog = 0;

while (Date.now() - startedAt < TIMEOUT_MS) {
	await new Promise((resolve) => setTimeout(resolve, 1000));
	const joined = lines.join("\n");
	if (!connected && /\bconnected\b|STATE_ONLINE|online error=''|in game/i.test(joined)) connected = true;
	if (SCREENSHOT && Date.now() - lastLog > 10000) {
		lastLog = Date.now();
		await page.screenshot({ path: SCREENSHOT });
	}
	if (connected) break;
}

if (SCREENSHOT) await page.screenshot({ path: SCREENSHOT });

const interesting = lines.filter((line) =>
	/connect|network|websocket|offline|error|timeout|server|handshake|protocol|sixup/i.test(line));
console.log("---- engine log (filtered) ----");
for (const line of interesting.slice(-80)) console.log(line);
console.log("---- all console lines:", lines.length, "----");
if (errors.length > 0) {
	console.log("---- page errors ----");
	for (const err of errors.slice(0, 20)) console.log(err);
}

await browser.close();

if (connected) {
	console.log("[e2e] PASS: client reached the game world");
	process.exit(0);
}
console.log("[e2e] FAIL: no connection detected within the timeout");
process.exit(1);
