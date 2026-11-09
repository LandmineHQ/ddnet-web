# DDNet Web 前端（第二轮 UX 重做）

浏览器里运行 DDNet 客户端的站点：原生 ESM、零构建、零依赖。第二轮按用户反馈整体重做 UI，
流程改为「下载缓存 → 后端选择 → 载入 → 服务器列表 → 游戏」五屏，配置项收进「高级」。

## 五屏流程

> 界面默认 **亮色主题**，右上角可切换深色；选择保存在 `ddweb.theme.v1`。

1. **首次打开：下载确认**
   - 明确列出需要下载的两个大文件：`DDNet.wasm`（约 8.5 MB）、`DDNet.data`（约 51.6 MB），展示名称与体积。
   - 用户点「开始下载」后，进度显示在**右下角悬浮组件**（两个进度条 + 实时速度 + 百分比），
     不阻塞页面，可最小化；下载完成后自动隐藏。
   - 两个文件下载后用 `manifest.json` 里的 sha256 校验，通过后写入 **Cache Storage**；再次打开直接命中缓存，不再提示。
2. **后端（中继）选择**
   - 大卡片列表：名称、地址、延迟徽章、区域/在线人数/推荐标签（来自 `GET /api/info`，拿不到就用地址兜底）。
   - 延迟用 **WebRTC 数据通道**实测（`POST /rtc/offer` 交换 SDP，datachannel 发 5 次 ping 取中位数），按延迟升序排列；
     WebRTC 不可用时自动回退 ws 握手 / HTTP TTFB，并在卡片上标注测量方式。
   - 列表最后是「添加自定义后端」卡片：支持任意 ws:// 或 wss://，可选 token，保存在本机。
   - 每张卡片右上角有操作按钮：`✎` 编辑（复用同一个弹窗，预填名称/URL/token，保存后自动重新测速）、`🗑` 删除（二次确认，删除后同步 localStorage；若删的是当前选中后端会回到列表页）。
   - 删除本地内置（种子）后端会记入 `ddweb.hidden-relays.v1`，下次打开不会自动加回；「添加自定义后端」旁的「恢复默认后端」按钮可一键找回（空状态里也有入口）。`relays.json` 远端推荐（`source === "discovered"`）和 relay master（`source === "master"`）后端保持只读，只显示编辑按钮。
   - 列表为空时显示空状态提示，并提供「添加自定义后端」与「恢复默认后端」入口。
3. **载入页**
   - 选中后端时若资源还没下完，屏幕中央显示「正在载入」，内含两个文件的进度条；
   - 右上角 X 可关闭，下载在右下角继续，关闭后回到后端选择页（不会偷偷进入下一步）。
4. **游戏服务器列表**
   - 后端连接成功：**直接读取 DDNet 官方 master**（`https://master1..4.ddnet.org/ddnet/15/servers.json`，约 1400 台），
     展示名称/地图/类型/地区/玩家数/协议/密码房；支持搜索、协议/类型/地区筛选、隐藏满员/密码房、
     按玩家数/名称/地区排序、每页 20 台分页；点选后经当前后端加入；
   - master 不可达时自动回退到该中继的 `GET /api/servers` 推荐列表（来源标记「后端推荐列表」）；
   - 后端连接失败：显示**错误输出面板**（请求 URL、HTTP 状态、错误、可能原因），可一键复制、重试。
   - **relay master 发现**：启动时还会请求 master 的 `/v1/serverlist`，把已验证的 relay 节点加入后端列表
     （标记「Master 节点」，只读）。默认是 `https://master.landmine.top/v1/serverlist`；本机开发使用
     `http://127.0.0.1:8391`，LAN HTTPS dev 使用同源 `/relay-master`。也可用
     `<meta name="relay-master-base">`、`window.DDWEB_MASTER_BASE`、`?masterBase=<base>` 或
     `?master=<完整 URL>` 覆盖。master 不可达时只记录日志，不影响本地种子/relays.json。
5. **进入游戏**
   - 画布全屏，左上角「后端连接信息」悬浮面板（后端、地址、延迟、服务器、协议、上下行字节）；
   - **首次进入自动聚光灯引导**指向该面板，**Ctrl+`（~ 键）** 可随时显示/隐藏（引导只出现一次，记录在 localStorage）。

## 资源缓存与 blob 加载

- 清单：站点根目录的 `manifest.json`（由 `scripts/assemble-web.sh` 生成）：

      { "version": "c1fcf50e39666de9", "files": {
          "DDNet.js":   { "sha256": "…", "size": 376051 },
          "DDNet.wasm": { "sha256": "…", "size": 8872070 },
          "DDNet.data": { "sha256": "…", "size": 54150365 } } }

- 流程：`fetch` + `ReadableStream` 逐块读进度 → `crypto.subtle.digest('SHA-256')` 校验 →
  `cache.put` 写入 `ddweb-assets-<version>` → `cache.match().blob()` → `URL.createObjectURL`。
- 启动时通过 `Module.locateFile` 把 `DDNet.wasm` / `DDNet.data` 映射到 blob URL，
  `Module.mainScriptUrlOrBlob` 指向 `DDNet.js` 的 blob URL（pthread worker 也走缓存，无需网络）。
- `.wasm` 的 blob 显式设置为 `application/wasm`，否则 `WebAssembly.instantiateStreaming` 会失败。
- 缓存版本跟随 manifest version；版本变化会清理旧缓存。缓存约 60.5 MB。
- 没有 `manifest.json`（旧部署）时：回退用 HEAD `content-length` 取大小，跳过 sha256 校验，并在 UI/日志里提示。
- 下载失败可重试；「高级」里可以清除缓存或重新下载。

## WebRTC 延迟测量

- 对每个后端：创建 `RTCPeerConnection`（ICE 服务器取 `/api/info.iceServers`，默认空即 host candidates）→ `createDataChannel('lat')` → `POST <relay>/rtc/offer?token=…`
  （若后端配置了 token，query 参数会一并带上；也支持 `x-relay-token` 头，但前端默认用 query）→
  `setRemoteDescription(answer)` → 等 datachannel 打开 → 发 5 个 JSON ping（带时间戳）取 RTT 中位数。
- 失败自动回退：ws 握手 RTT（`/healthz`）→ HTTP `/healthz` TTFB；卡片标注 `WebRTC` / `WS 握手` / `HTTP`。
- 徽章配色：< 40 ms 绿、< 90 ms 浅绿、< 160 ms 黄、≥ 160 ms 红；不可用灰色；测量中蓝色。
- HUD 延迟优先显示 WebRTC 结果，只有 WebRTC 失败时才用回退结果覆盖并标注。

## 0.6 / 0.7 协议切换

- 工具栏 `0.6 / 0.7` 分段按钮是**默认连接协议**（手动输入 / 未声明协议的后端条目），默认 **0.6**，选择会持久化。
- 官方 master 条目自带协议（`addresses` 的 `tw-0.6/0.7+udp://` 前缀）：点选时用条目协议，0.7 时 URL 追加
  `?protocol=7`；列表另有「协议」筛选（全部/0.6/0.7）。
- HUD「协议」行显示当前会话协议；`?connect` 直连模式显示「直连」（直连 URL 原样透传，不追加参数）。

## 中文输入法 / 剪贴板

- `web/src/ime.js` 在引擎进入文本输入时聚焦不可见 `textarea#ddweb-ime-input`，把组合结束的
  UTF-8 文本通过 `DDWeb_InputText` 注入 wasm；退格/回车/Esc/方向键走 `DDWeb_InputKey`。
- `Ctrl+V` 由 textarea 的 `paste` 事件直接注入；`Ctrl+C/X/A` 注入带 Ctrl 的按键，复制/剪切由
  游戏原有 lineinput 调 `Input()->SetClipboardText`，Emscripten 分支再写回 `navigator.clipboard`。
- 复制失败会 toast 提示（通常是浏览器剪贴板权限或非安全上下文）。

## 启动契约

    wsUrl = '<relayBase>/udp/<host>:<port>[?protocol=7][&token=…]'
    Module.arguments = ['cl_touch_controls 0', 'cl_back_button 0', 'connect ' + wsUrl]  // 桌面/非触控：显式关闭
    Module.arguments = ['cl_touch_controls 1', 'cl_back_button 1', 'connect ' + wsUrl]  // 触屏设备
    Module.callMain(Module.arguments)

- 启动前挂载 IDBFS 到 `/home/web_user/.local/share/ddnet` 并 `FS.syncfs(true)` 恢复存档；退出时 `syncfs(false)` 写回。
- 退出后 Emscripten 运行时不能在同一页面重启，会提示返回列表或重新加载页面。

## 游戏内服务器浏览器：默认中继（DDWeb_SetDefaultRelay）

浏览器里 DDNet 自带的服务器浏览器拿到的仍是纯 UDP 地址（master list 走 HTTPS 能正常浏览），
所以启动时要把当前中继交给 C++，让 `host:port` 自动改写成 `<relayBase>/udp/<host>:<port>[?<query>&protocol=7]`。

- 时机：Emscripten 运行时 ready 之后、`Module.callMain(...)` **之前**。
- 调用：`Module.ccall('DDWeb_SetDefaultRelay', null, ['string','string'], [relayBase, relayQuery])`。
- `relayBase`：当前中继 URL 去掉结尾斜杠（可含路径，例如 `wss://host:8443`）；
  直连 `?connect=` 时从连接 URL 的 `/udp/` 前缀推导。
- `relayQuery`：已 URL 编码的查询串，例如 `token=secret`；没有 token 时传空字符串。
  直连模式会从 `?connect=` URL 的 query 里读取 `token`。
- 运行时没有 `ccall`（Node 假运行时 / 旧构建）时安全跳过，并通过日志与 `default-relay` 会话事件提示。
- 纯函数 `buildDefaultRelayCall()` / `applyDefaultRelay()` 在 `src/connect.js`，有单测覆盖。

## 移动端 / Android 适配

- 设备检测在 `src/device.js`：`matchMedia('(pointer: coarse)')`、`navigator.maxTouchPoints`、
  UA-CH `navigator.userAgentData.mobile`、UA 手机/平板标识、小屏 + 触摸（短边 ≤ 700 CSS px）。
  结果写入 `<html data-device="mobile|tablet|desktop">` 与 `body.is-mobile|is-tablet|is-desktop`（触摸设备另有 `has-touch`）。
- 完全没有触摸信号的桌面保持 desktop；`maxTouchPoints > 0` 的触摸设备按 tablet/mobile 处理，jsdom / 无 `matchMedia` 环境安全降级为 desktop。
- 移动端服务器列表页显示中文触屏操作说明（左侧移动、右侧圆形摇杆瞄准/开火、跳跃与武器按钮、
  左上角「＋」展开计分板/聊天/投票、屏幕上的返回按钮 = Esc、建议横屏），并提供「进入全屏」按钮。
- 进入游戏时在用户手势内请求全屏并尝试 `screen.orientation.lock('landscape')`；失败静默忽略。
  游戏内显示精简触屏提示条（可关闭）。
- 启动参数自动追加 `cl_touch_controls 1` 与 `cl_back_button 1`，`connect <url>` 始终是最后一条命令。
- CSS：canvas `touch-action: none` / `user-select: none` / `overscroll-behavior: none`，
  安全区内边距，触屏按钮加大；移动端隐藏桌面键盘提示（`.keyboard-only`）。

## URL 参数

| 参数 | 说明 |
| --- | --- |
| `?connect=<wsUrl>` | 直连：启动时把该地址原样作为 `connect <url>` 传给 wasm，不做任何改写 |
| `?autostart=1` | 页面加载完成后自动启动：自动下载资源 → 选最快后端（或直连）→ 自动进入 |
| `?relay=<id 或 url>` | 预选/添加该后端；配合 autostart 可自动进入服务器列表 |
| `?relayUrl=<url>` | 同上，直接给地址 |
| `?target=<host:port>` | 分享/预填目标服务器（服务器列表中高亮使用） |
| `?master=<url>` | 覆盖 relay master 完整地址（默认 `https://master.landmine.top/v1/serverlist`） |
| `?masterBase=<base>` | 覆盖 relay master base URL（相对或绝对） |

示例：`/?connect=ws%3A%2F%2F127.0.0.1%3A8390%2Fudp%2F74.91.126.203%3A8300&autostart=1`（DDNet 官方 USA1 Tutorial）

## 快捷键与引导

- **Ctrl+`（~ 键，Backquote）**：游戏中显示/隐藏「后端连接信息」面板；全局生效（输入框内也可用），匹配时 `preventDefault`。
- 移动端不显示键盘提示，改为游戏内的触屏提示条；
- 桌面/非触控设备（含触屏笔记本）不显示触控 UI，并显式传 `cl_touch_controls 0`、`cl_back_button 0`，
  避免 IndexedDB 里残留移动端配置。
- 首次进入游戏自动聚光灯（步骤状态机见 `src/tour.js`），结束或跳过写入 `ddweb.tour.v1`。

## 主题（默认亮色 + 深色切换）

- `<html data-theme="light|dark">` 驱动 CSS 变量；首屏内联脚本在渲染前应用已保存主题，避免闪烁。
- **首次访问默认亮色**；右上角按钮切换明暗，写入 `ddweb.theme.v1`，刷新后保留。
- 亮色是独立配色（浅灰背景、白卡片 + 柔和阴影、DDNet 橙主色、深色文字），不是简单反色；正文/次要文字按 WCAG AA 对比度选取。
- 游戏内 HUD 与快捷键提示保持半透明深色以适配游戏画面；聚光灯卡片、toast、下载组件、对话框、表单都跟随主题。
- 截图对比：`04-relays-ready.png`（亮色）与 `04d-relays-dark.png`（深色）。

## 目录结构

    web/
    ├── index.html          五屏 UI + 弹层 + HUD + 聚光灯 + 高级/自定义后端对话框
    ├── style.css           DDNet 风格深色主题（跨平台中文字体栈、移动端适配）
    ├── app.js              控制器（视图状态机、下载/载入、后端/服务器、游戏、HUD）
    ├── serve.mjs           零依赖静态服务器（COOP/COEP、wasm MIME、多根目录、端口 8392）
    ├── README.md
    ├── assets/background.png
    ├── src/
    │   ├── assets.js       资源清单 / 下载进度 / sha256 / Cache Storage / blob URL
    │   ├── latency.js      WebRTC RTT、回退、排序、/api/info
    │   ├── relays.js       后端存储（localStorage）+ 本地种子 + relays.json/relay master 发现
    │   ├── relayurl.js     地址规范化、/udp/ URL、connect 参数、分享/直连参数
    │   ├── connect.js      启动会话编排（可注入 createModule/loadScript/launch）
    │   ├── launch.js       Module 配置、locateFile、IDBFS + callMain
    │   ├── probe.js        ws 探活、HTTP 回退、/api/servers
    │   ├── tour.js         聚光灯状态机
    │   ├── shortcuts.js    Ctrl+`（Backquote）快捷键判定
    │   ├── device.js       移动端 / 触屏检测、data-device、全屏与横屏锁定
    │   ├── theme.js        明暗主题（默认亮色、切换与持久化）
    │   ├── diagnostics.js  HTTPS / COOP-COEP / SAB / WebGL2 / localStorage 自检
    │   ├── wsstats.js      WebSocket 流量观测
    │   ├── audio.js        用户手势解锁 AudioContext
    │   ├── storage.js      localStorage 适配器
    │   ├── dom.js          极简 DOM 构建（textContent 防 XSS）
    │   └── format.js       字节 / 速度 / RTT / 时间格式化
    └── tools/
        ├── test-pure.mjs            纯函数/契约（41 例，含游戏服务器 master、relay master、聚光灯性能、IME 分块）
        ├── test-assets.mjs          下载/校验/缓存（8 例）
        ├── test-latency.mjs         WebRTC/回退/排序（11 例）
        ├── test-dom.mjs             DOM 五屏流程（16 例）
        ├── test-integration.mjs     假中继 + serve（6 例）
        ├── dom-shim.mjs             极简 DOM 垫片
        ├── fake-relay.mjs           测试用中继（/healthz /api/* /rtc/offer / ws 回显）
        ├── fake-build/              假 DDNet.js/.wasm/.data（验证启动链路）
        ├── check-real-backend.mjs   真实后端检查
        ├── check-real-ui.mjs        真实后端 UI 冒烟
        ├── e2e-browser.mjs          Chromium（CDP）全流程 E2E + 截图
        └── mobile-shot.mjs          移动端模拟（CDP）触屏 UI 截图

## 本地开发

    # 站点根目录需要 index.html / app.js / … 以及 DDNet.js/.wasm/.data + manifest.json
    node web/serve.mjs                          # 默认 8392，根目录 dist/web（缺失退化 web/）
    node web/serve.mjs --port 8393 --root dist/web
    # 前端源文件与构建产物分开时（例如还没跑 assemble）：
    node web/serve.mjs --port 8393 --root web --root dist/web

- `--root` 可重复，按顺序查找；`web/` 始终作为前端回退根目录。
- 所有响应带 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`，
  `.wasm` 为 `application/wasm`；`GET /__ddweb/info` 可查看解析后的根目录与构建产物状态。
- 本地演示栈（中继 8390、HTTP 8392、HTTPS 8443；游戏服务器默认是 DDNet 官方 Tutorial）见 `scripts/dev-up.sh`。

## 部署要求

- 必须是安全上下文（HTTPS 或 localhost），并发送 COOP/COEP（否则 SharedArrayBuffer 不可用）；
- `.wasm` 必须是 `application/wasm`；`manifest.json` 建议 `Cache-Control: no-cache`；
- `DDNet.js/.wasm/.data/manifest.json` 必须与 `index.html` 同目录（可由 `scripts/assemble-web.sh` 生成）；
- 站点想下发推荐后端时，可放置可选的 `relays.json`：`{"relays":[{"name":"…","url":"wss://…"}]}`。

## 测试

    node web/tools/test-pure.mjs          # 41 例：URL/参数/存储/引导/快捷键/设备检测/触屏参数/默认中继/启动契约/游戏服务器 master/relay master/聚光灯/IME 分块/假构建 vm
    node web/tools/test-assets.mjs        # 8 例：进度、sha256、缓存命中、失败回退、abort
    node web/tools/test-latency.mjs       # 11 例：WebRTC mock、ping 超时、/rtc/offer token、回退、排序
    node web/tools/test-dom.mjs           # 16 例：五屏流程、主题、后端编辑/删除/隐藏/恢复、空状态、协议切换、错误面板、HUD、聚光灯、Ctrl+`、中继回归、移动端触屏 UI
    node web/tools/test-integration.mjs   # 6 例：假中继 + 真实 HTTP 下载校验 + serve 头/MIME

    # 真实后端（中继 8390 在跑时；默认目标为 DDNet 官方 Tutorial）：
    node web/tools/check-real-backend.mjs ws://127.0.0.1:8390 74.91.126.203:8300
    node web/tools/check-real-ui.mjs

    # 移动端触屏 UI 截图（假构建资源 + 假中继，只监听 127.0.0.1 高位端口）：
    docker run --rm --name web-mobile-shot --network host --shm-size=1g \
      -v /root/test/ddnet-web:/root/test/ddnet-web -w /root/test/ddnet-web \
      -v /usr/share/fonts/opentype/noto:/usr/share/fonts/opentype/noto:ro \
      ddchrome:latest env CHROME=/usr/bin/chromium \
      node web/tools/mobile-shot.mjs --port 8394 --cdp-port 9334

    # Chromium 全流程 E2E（容器内自带 chromium + node，--network host 访问本机站点）：
    docker run --rm --network host --shm-size=1g -v /root/test/ddnet-web:/root/test/ddnet-web -w /root/test/ddnet-web \
      ddchrome:latest node web/tools/e2e-browser.mjs --base http://127.0.0.1:8393/

最近一次真实浏览器结果（本次快捷键/移动端改动前）：**35/35 通过**（亮色主题、后端新增/编辑/删除、内置后端删除+隐藏+恢复默认、
空状态入口、WebRTC 延迟、载入页、服务器列表、游戏、聚光灯、旧快捷键、缓存与主题刷新保留、autostart 直连）。
本次已把 E2E 的快捷键断言改成 Ctrl+`，需在 Lead 重新 assemble dist/web 后重跑。
截图在 `web/tools/screenshots/`：01 下载提示、02 下载悬浮进度、03 载入页、04 后端列表（亮色）、
04b 编辑弹窗、04c 删除确认、04d 后端列表（深色）、04e 空状态、04f 恢复默认、05 服务器列表、
06 游戏 + HUD + 聚光灯、07 HUD、08 缓存命中（亮/深各一张）、09 autostart 直连；结果 JSON 为 `e2e-results.json`。
移动端模拟截图：`10-mobile-touch-guide-portrait.png`、`11-mobile-touch-guide-landscape.png`、
`12-mobile-game-touch-hint.png`；结果 JSON 为 `mobile-shot-results.json`（5/5 检查通过）。
真实中继实测 WebRTC RTT 0.6–2.0 ms，引擎日志出现
`client: connected, sending info`，0.7 协议实测 `Module.arguments` 为 `["./this.program", "connect ws://…?protocol=7"]`。
截图中的中文显示为方块是测试容器缺中文字体，不是页面问题（CSS 已显式声明跨平台中文字体栈，
支持 PingFang SC / 微软雅黑 / Noto Sans CJK / 文泉驿等）。

## 调试接口（供 Puppeteer / 控制台）

页面加载后暴露 `window.__ddwebDebug`：

| 字段 / 方法 | 说明 |
| --- | --- |
| `state` | 运行时状态：`view`(relays/servers/game)、`phase`、`download`、`servers`、`protocol`、`hud`、`spot`、`direct`、`latency`、`lastConnectUrl`、`lastConnectProtocol`、`runtime` |
| `refs` | 全部 DOM 节点引用（按语义命名） |
| `assets` | 资源管理器（`isComplete()` / `snapshot()` / `objectUrl()`） |
| `relayStore` | 后端存储（增删改查） |
| `entries()` | 当前后端 + 延迟 + 测量方式 |
| `measureAllLatency()` | 重新测速 |
| `selectRelay(relay)` / `connectToRelay(relay)` | 选择 / 连接后端 |
| `enterGame(relay, target)` / `startDirectSession(url)` | 进入游戏 / 直连启动 |
| `startSession(options)` | 底层启动（可断言 `state.lastConnectUrl`） |
| `startDownload()` / `ensureAssets()` | 触发下载 / 等待资源就绪 |
| `showLoadingView(relay, stage)` / `hideLoading()` / `closeLoadingView()` | 载入页控制 |
| `toggleHud(force)` / `setView(name)` / `setProtocol(6\|7)` | HUD、视图、协议 |
| `setTheme("light"\|"dark")` | 切换明暗主题（持久化到 `ddweb.theme.v1`） |
| `deleteRelay(id)` / `measureRelayOnce(id)` / `canDeleteRelay(relay)` | 后端删除（含确认）/ 单后端重新测速 / 是否可删（discovered 只读） |
| `ensureRelays()` / `restoreDefaultRelays()` / `hiddenRelays()` | 重新执行种子发现 / 清空隐藏列表并恢复默认后端 / 当前隐藏的 URL 列表 |
| `refreshEnvironment()` / `renderAll()` | 自检、全量重绘 |
| `buildConnectTarget` / `buildDirectConnectTarget` | 连接 URL 组装（纯函数） |
| `buildDefaultRelayCall(options)` / `buildLaunchArgs(args, opts)` | 默认中继调用参数（纯函数）/ 移动端启动参数（纯函数） |
| `device()` / `setDevice(kind\|object)` / `detectDevice(env)` | 当前设备信息 / 手动切换设备（调试用）/ 纯函数检测 |
| `enterFullscreenMode()` / `requestFullscreenForGame()` | 全屏 + 横屏锁定 |
| `fetchServers` / `fetchRelayInfo` / `buildServersHttpUrl` | 后端接口调试 |
| `runAutostart()` | 触发 autostart 流程 |

关键 DOM id（E2E 可用）：

- 下载：`#download-modal`、`#download-files`、`#btn-download-start`、`#btn-download-later`、`#download-widget`、`#widget-progress`、`#widget-overall`、`#btn-widget-min`
- 载入：`#loading-view`、`#loading-progress`、`#btn-loading-close`、`#btn-loading-cancel`
- 后端：`#relay-grid`、`.relay-card[data-relay-id]`、`.relay-card.is-custom`、`.relay-action[data-action=edit|delete]`、`.latency-badge`、`#relay-summary`、`#btn-refresh-latency`、`#btn-add-relay`、`#btn-restore-relays`、`#cache-badge`
- 空状态：`#relay-empty`、`#btn-empty-add`、`#btn-empty-restore`
- 主题：`#btn-theme`、`#theme-icon`、`#theme-label`（`<html data-theme="light|dark">`）
- 确认弹层：`#confirm-dialog`、`#confirm-title`、`#confirm-text`、`#btn-confirm-ok`、`#btn-confirm-cancel`
- 服务器：`#view-servers`、`#servers-title`、`#servers-subtitle`、`#servers-latency`、`#server-search`、`#server-list`、`.server-card`、`#server-pager`、`#servers-error`、`#servers-error-text`、`#btn-error-copy`、`#btn-error-retry`、`#btn-protocol-6`、`#btn-protocol-7`、`#manual-target`、`#btn-manual-connect`
- 触屏：`#touch-guide`、`#touch-guide-list`、`#btn-touch-guide-close`、`#btn-touch-fullscreen`、`#touch-hint`、`#btn-touch-hint-close`、`#btn-touch-hint-fullscreen`（`<html data-device="mobile|tablet|desktop">`）
- 游戏：`#canvas`、`#hud-panel`、`#hud-relay-name`、`#hud-relay-address`、`#hud-latency`、`#hud-latency-method`、`#hud-target`、`#hud-protocol`、`#hud-traffic`、`#btn-hud-close`、`#btn-hud-reconnect`、`#hud-hint`
- 聚光灯：`#spotlight`、`#spotlight-hole`、`#spotlight-card`、`#spotlight-title`、`#btn-spotlight-next`、`#btn-spotlight-skip`
- 其他：`#relay-dialog`、`#advanced-dialog`、`#nickname-input`、`#btn-clear-cache`、`#btn-redownload`、`#game-exit`、`#toast-host`

## localStorage

| key | 内容 |
| --- | --- |
| `ddweb.relays.v2` | 已添加的后端：`{version, relays:[{id,name,url,token,source,addedAt}]}`；编辑/删除都会同步此键 |
| `ddweb.last-relay.v1` | 上次选择的后端 id |
| `ddweb.nickname.v1` | 昵称（仅本地） |
| `ddweb.protocol.v1` | `6` 或 `7` |
| `ddweb.theme.v1` | `light`（默认）或 `dark` |
| `ddweb.hidden-relays.v1` | 被删除的本地内置后端 URL 列表：`{version, urls:[...]}`，用于阻止种子再次加回 |
| `ddweb.tour.v1` | `done` 表示聚光灯引导已完成 |

## 已知限制

- Emscripten 运行时退出后不能在同一页面重启（需刷新），退出面板会提示。
- 首次下载 60.5 MB；下载/校验期间页面可用，但进入游戏需要等资源就绪。
- 中继的 `/api/*` 与 `/rtc/offer` 需要允许站点 Origin 跨域；自签 wss 需先信任证书。
- `relays.json` 发现功能为可选；不存在时不影响使用。
- 移动端全屏与横屏锁定依赖浏览器支持：iOS Safari 不支持 `screen.orientation.lock`，会静默降级为普通全屏。
- 触屏按钮布局由 DDNet 内置 `cl_touch_controls` 提供，可在游戏内「设置 → 触屏控制」里调整位置/大小。
- 触屏按钮只在进入游戏后出现；返回游戏菜单可用屏幕上的返回按钮（= Esc）或浏览器返回键。
