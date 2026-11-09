/**
 * 验收「游戏内服务器浏览器 → 后端中继 → UDP 游戏服务器」链路。
 *
 * 背景：DDNet 自带的服务器浏览器从 master 拿到的仍是无 UDP 语义的地址
 * （host:port 或 tw-0.7+udp://host:port）。浏览器里不能发 UDP，所以前端在
 * 启动 wasm 之前调用 DDWeb_SetDefaultRelay(base, query)，C++ 侧把这类地址
 * 改写成 <base>/udp/<host>:<port>[?<query>&protocol=7] 再经中继连接。
 *
 * 本测试不模拟点击画布里的服务器列表（坐标不稳定），而是用与列表点击完全
 * 相同的 CClient::Connect 入参在游戏内控制台执行 connect，覆盖两条真实路径：
 *   1) connect host:port            （0.6 服务器）
 *   2) connect tw-0.7+udp://host:port（0.7 服务器；必须在 URL 里带 protocol=7）
 *
 * 环境：BASE_URL / RELAY_URL / TARGET / CHROME / SHOT_DIR
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8392";
const RELAY = process.env.RELAY_URL || "ws://127.0.0.1:8390";
const TARGET = process.env.TARGET || "74.91.126.203:8300";
const TARGET2 = process.env.TARGET2 || "5.78.113.138:8300";
const TARGET7 = process.env.TARGET7 || "45.141.57.22:8300";
const TIMEOUT = Number(process.env.TIMEOUT_MS || 240000);
const SHOTS = process.env.SHOT_DIR || "/w/tests/out";
const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  — " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCase({ label, command, expectLog, expectUrl, shot, expectConnected = true }) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/usr/bin/chromium",
    headless: "new",
    protocolTimeout: 300000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader",
      "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required",
      "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push("PAGEERROR " + e));
  const waitLog = async (re, from = 0, timeout = 90000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (let i = from; i < logs.length; i++) if (re.test(logs[i])) return i;
      await sleep(250);
    }
    return -1;
  };

  const url = BASE + "/?connect=" + encodeURIComponent(RELAY + "/udp/" + TARGET) + "&autostart=1";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  const connected = await waitLog(/client: connected, sending info/, 0, TIMEOUT);
  if (connected < 0) throw new Error("初始连接超时");
  await page.waitForFunction(() => { const c = document.querySelector("#canvas"); return c && c.getBoundingClientRect().width > 0; }, { timeout: 60000 });
  // 官方服务器连上后还要下载地图/进入游戏；在完成前按 F1 可能被吞掉。
  await waitLog(/entered and joined the game|motd:/, connected + 1, 90000);
  await sleep(1200);

  // 前端启动时（callMain 之前）已经调用过 DDWeb_SetDefaultRelay，从调试 API 验证。
  const runtime = await page.evaluate(() => {
    const st = globalThis.__ddwebDebug && globalThis.__ddwebDebug.state;
    if (!st || !st.runtime) return null;
    return {
      args: st.runtime.args,
      defaultRelay: st.runtime.defaultRelay,
      applied: st.runtime.defaultRelayApplied,
      phase: st.runtime.phase,
    };
  });
  const applied = runtime && runtime.applied;
  record(label + "：前端自动注入默认中继", Boolean(applied && applied.ok && applied.called),
    applied ? JSON.stringify({ base: applied.relayBase, query: applied.query }) : "无运行时信息");

  // 游戏内控制台：与点击服务器列表完全相同地调用 CClient::Connect。
  const canvas = await page.$("#canvas");
  await canvas.click({ offset: { x: 640, y: 400 } }).catch(() => {});
  await sleep(500);
  const before = logs.length;
  await page.keyboard.press("F1");
  await sleep(1300);
  await page.keyboard.type(command, { delay: 20 });
  await sleep(200);
  await page.keyboard.press("Enter");
  await sleep(1500);
  await page.keyboard.press("F1");
  await page.screenshot({ path: SHOTS + "/" + shot }).catch(() => {});
  const ok = await waitLog(expectLog, before, 60000);
  if (expectConnected) {
    record(label + "：经中继连接成功", ok >= 0, ok >= 0 ? "log#" + ok : "超时");
  } else {
    record(label + "：协议/地址改写生效", ok >= 0, ok >= 0 ? "log#" + ok : "超时");
  }
  if (expectUrl) {
    const hit = logs.slice(before).find((l) => expectUrl.test(l));
    record(label + "：WebSocket 地址改写正确", Boolean(hit), (hit || "").trim().slice(0, 200));
  }
  await browser.close();
}

try {
  await runCase({
    label: "0.6 隔壁服务器",
    // 初始连 TARGET，再从游戏内控制台加入另一台官方 Tutorial（TARGET2），
    // 与"在服务器浏览器里点另一台服务器"走同一条 CClient::Connect 路径。
    command: "connect " + TARGET2,
    expectLog: /connected, sending info/,
    expectUrl: new RegExp("/udp/" + TARGET2.replace(/[.:]/g, "\\$&")),
    shot: "relay-join-plain.png",
  });
} catch (e) { record("0.6 明文地址", false, String(e.message)); }

try {
  await runCase({
    label: "0.7 sixup 地址",
    // 官方 Tutorial 服务器不保证接受 0.7/sixup，因此这里只验证协议选择与
    // URL 改写（?protocol=7）；要验证 0.7 真正进服需用支持 sixup 的本地服务器
    // 并设置 SIXUP_CONNECT=1。
    command: "connect tw-0.7+udp://" + TARGET7,
    expectLog: /using 0\.7 \(sixup\) protocol/,
    expectUrl: new RegExp("/udp/" + TARGET7.replace(/[.:]/g, "\\$&") + "\\?protocol=7"),
    expectConnected: process.env.SIXUP_CONNECT === "1",
    shot: "relay-join-sixup.png",
  });
} catch (e) { record("0.7 sixup 地址", false, String(e.message)); }

// 中继侧确认确实有目标流量（经 Go 中继 /api/stats）。
try {
  const stats = await fetch(RELAY.replace(/^ws/, "http") + "/api/stats").then((r) => r.json());
  const targets = stats.targets || stats.Targets || [];
  const hit = targets.find((t) => JSON.stringify(t).includes(TARGET) || JSON.stringify(t).includes(TARGET2));
  record("中继统计出现目标服务器流量", Boolean(hit), hit ? JSON.stringify(hit).slice(0, 200) : JSON.stringify(targets).slice(0, 200));
} catch (e) { record("中继统计出现目标服务器流量", false, String(e.message)); }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
