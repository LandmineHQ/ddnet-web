import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: "new",
  args: ["--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader","--use-gl=angle","--use-angle=swiftshader"] });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
await page.goto("http://127.0.0.1:8392/blob_probe.html", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 30000));
const state = await page.evaluate(() => ({ ready: window.__ready === true, error: window.__error || null, urls: window.__urls ? Object.keys(window.__urls) : [] }));
console.log(JSON.stringify(state));
for (const l of logs.filter((x) => /sha256|RUNTIME|cache contains|script loaded|ERROR|MISMATCH/.test(x)).slice(-16)) console.log(l);
await browser.close();
