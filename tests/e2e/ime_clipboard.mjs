/**
 * wasm 内文本输入验收：中文 IME、剪贴板粘贴、复制、剪切。
 * 依赖本地 DDNet 测试服（TARGET 默认 127.0.0.1:8313）。
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const RELAY = process.env.RELAY_URL || "ws://127.0.0.1:8390";
const TARGET = process.env.TARGET || "127.0.0.1:8313";
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
await browser.defaultBrowserContext().overridePermissions(BASE, ["clipboard-read", "clipboard-write"]);
const page = await browser.newPage();
const logs = []; page.on("console", (m) => logs.push(m.text())); page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
const url = BASE + "/?connect=" + encodeURIComponent(RELAY + "/udp/" + TARGET) + "&autostart=1";
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
const waitLog = async (re, timeout = 120000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs.some((l) => re.test(l))) return true;
    await sleep(250);
  }
  return false;
};
record("经后端进入游戏", await waitLog(/client: connected, sending info/));
await sleep(2000);

const clickCanvas = async () => { await page.mouse.click(640, 400); await sleep(250); };
const imeActive = () => page.evaluate(() => Boolean(globalThis.ddwebIme && globalThis.ddwebIme.isActive() && document.activeElement && document.activeElement.id === "ddweb-ime-input"));
const openChat = async () => {
  await clickCanvas();
  await page.keyboard.press("Enter");
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (await imeActive()) return true;
    await sleep(150);
  }
  return false;
};
const sendChat = async () => { await page.keyboard.press("Enter"); await sleep(1000); };
const chatCount = () => logs.filter((l) => /chat\/all:/.test(l)).length;

// 1) 打开聊天 → 隐藏 textarea 激活
record("聊天输入激活浏览器 IME 桥", await openChat());
await sendChat();

// 2) 中文 IME 组合输入
record("重新打开聊天", await openChat());
const cdp = await page.target().createCDPSession();
await cdp.send("Input.imeSetComposition", { text: "zhongwen", selectionStart: 8, selectionEnd: 8 });
await sleep(250);
await cdp.send("Input.insertText", { text: "中文输入" });
await sleep(350);
await sendChat();
record("中文 IME 输入并发送", logs.some((l) => /chat\/all:.*中文输入/.test(l)), logs.filter((l) => /chat\/all:/.test(l)).slice(-1)[0] || "");

// 3) 粘贴事件（Ctrl+V 在真实浏览器触发的事件）
record("再次打开聊天（粘贴）", await openChat());
await page.evaluate(() => {
  const el = document.querySelector("#ddweb-ime-input");
  const data = new DataTransfer();
  data.setData("text/plain", "中文粘贴");
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
});
await sleep(500);
await sendChat();
record("中文粘贴并发送", logs.some((l) => /chat\/all:.*中文粘贴/.test(l)), logs.filter((l) => /chat\/all:/.test(l)).slice(-1)[0] || "");

// 4) Ctrl+A / Ctrl+C 复制
record("再次打开聊天（复制）", await openChat());
await cdp.send("Input.insertText", { text: "复制内容" });
await sleep(400);
await page.keyboard.down("Control");
await sleep(100);
await page.keyboard.press("a");
await sleep(500);
await page.keyboard.press("c");
await sleep(800);
await page.keyboard.up("Control");
await sleep(300);
const copied = await page.evaluate(() => navigator.clipboard.readText().catch((e) => "ERR:" + e));
record("Ctrl+C 复制中文到系统剪贴板", copied === "复制内容", JSON.stringify(copied));
await sendChat();

// 5) Ctrl+A / Ctrl+X 剪切
record("再次打开聊天（剪切）", await openChat());
const beforeCut = chatCount();
await cdp.send("Input.insertText", { text: "剪切内容" });
await sleep(400);
await page.keyboard.down("Control");
await sleep(100);
await page.keyboard.press("a");
await sleep(500);
await page.keyboard.press("x");
await sleep(800);
await page.keyboard.up("Control");
await sleep(300);
const cut = await page.evaluate(() => navigator.clipboard.readText().catch((e) => "ERR:" + e));
record("Ctrl+X 剪切中文到系统剪贴板", cut === "剪切内容", JSON.stringify(cut));
await sendChat();
record("剪切后聊天输入已清空", chatCount() === beforeCut, "新增聊天消息 " + (chatCount() - beforeCut));
await page.screenshot({ path: SHOTS + "/ime-chat.png" }).catch(() => {});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
