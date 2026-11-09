import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: "new",
  args: ["--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader","--use-gl=angle","--use-angle=swiftshader","--autoplay-policy=no-user-gesture-required","--window-size=1280,720"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const logs = [];
page.on("console", m => logs.push(m.text()));
const url = "http://127.0.0.1:8392/?connect=" + encodeURIComponent("ws://127.0.0.1:8390/udp/127.0.0.1:8313") + "&autostart=1";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
const shots = [20, 45, 70];
let prev = 0;
for (const at of shots) {
  await new Promise(r => setTimeout(r, (at - prev) * 1000));
  prev = at;
  await page.screenshot({ path: "/w/tests/out/game-" + at + "s.png" });
  const state = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return { canvas: c ? c.width + "x" + c.height : null, display: c ? getComputedStyle(c).display : null };
  });
  console.log(at + "s:", JSON.stringify(state));
}
console.log("--- last engine lines ---");
for (const l of logs.filter(x => x.startsWith("[ddnet]")).slice(-12)) console.log(l);
await browser.close();
