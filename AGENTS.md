# AGENTS.md — DDNet Web 客户端 + WSS→UDP 后端节点

> 给后续 AI agent / 开发者：项目做了什么、代码改在哪、怎么构建/运行/验证，以及**必须遵守的约定**。
> 动手前先读第 3、7、8 节。最近一次大改：后端改为 **Go**、游戏内服务器浏览器可经后端加入、移动端触屏 UI、
> `Ctrl+反引号键` 快捷键、**WebRTC DataChannel（首选）/ WebSocket（回退）双传输**、全部 docker 走 compose；
> 新增 **relay master**（WS 探测 + 15 分钟存活检查）、前端相对 `/relay-master`、WebRTC `host/udpPort` 声明、
> **TCP/UDP 同端口**，生产 TLS/WSS/静态站点全部交给 **nginx**（不再使用 Caddy）。

---

## 1. 项目速览

在浏览器里运行**真正的 DDNet 客户端**（C++ → WebAssembly），通过 `wss://` 连接自建后端节点，
后端把 WebSocket 帧转成 UDP 数据报发给**任意原版 DDNet 服务器**（服务器端零改动）。

四个概念（务必分清）：

| 层 | 目录 | 说明 |
|---|---|---|
| **前端** | `web/` + `ddnet-dev/`（wasm） | 浏览器界面 + wasm 客户端 |
| **后端节点** | `relay-go/` | **Go** 实现，兼容层：让前端客户端连接任何 UDP 游戏服务器 |
| **relay master** | `relay-go/cmd/master` | **Go** 节点注册中心：注册、WS 首次验证、15 分钟存活检查；网页从 `/v1/serverlist` 获取节点 |
| **游戏服务器** | 不修改 | 原版 DDNet，只支持 UDP（0.6/0.7） |

- 状态：**可用 MVP+**。浏览器内可进服游玩（0.6/0.7 实测）；游戏内服务器浏览器可浏览并加入；
  移动端有触屏 UI；游戏流量默认走 **WebRTC DataChannel**（pion/webrtc），失败自动回退 WebSocket；
  新增 **relay master** 节点注册中心（WS 首次验证 + 15 分钟存活检查）；全部服务用 docker compose 起停/测试。
- 上游基线：`ddnet/ddnet@a02cf38`。
- 核心洞察：DDNet 上游已有完整 Emscripten 构建（渲染/音频/存档/HTTP 全通），**唯一缺口是网络**；
  本项目补了 WebSocket 传输，并让游戏内浏览器拿到的 UDP 地址经后端中转。

```
浏览器(HTTPS + COOP/COEP)                     后端节点(Go)                  游戏服务器
┌───────────────────────────┐ WebRTC   ┌──────────────────┐   UDP   ┌──────────────┐
│ Web Shell（原生 ESM）      │─────────▶│ pion/webrtc      │────────▶│ DDNet :8303  │
│ DDNet wasm（WebGL2）       │  (回退)  │ + 自实现 RFC6455  │         │ (未修改)      │
│ websockets_emscripten.cpp  │─────────▶│ SSRF/限流/token   │         └──────────────┘
└───────────────────────────┘   wss    └──────────────────┘
        │ GET /v1/serverlist                  ▲ POST /v1/register
        ▼                                      │（master 主动 WS 探测 /ws）
┌──────────────────────────────────────────────────────────────┐
│ relay-master（master.landmine.top / :8391）：注册 + 15 分钟存活检查 │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 目录结构

| 路径 | 说明 | 谁能改 |
|---|---|---|
| `ddnet/` | 上游 DDNet 源码（**基线，不要改**） | 只读 |
| `ddnet-dev/` | git worktree（分支 `web-client`），**含本项目补丁** | 改这里 |
| `patches/ddnet-web-client.patch` | 补丁导出（1283 行 / 9 文件），可干净 apply 到上游 | 由 ddnet-dev 生成 |
| `relay-go/` | **后端节点（Go 1.24 + pion/webrtc，依赖已 vendor）**：WebRTC↔UDP / WS↔UDP、API、鉴权、SSRF、限流、统计；另含 `cmd/master`（relay master）、`internal/master`（注册/WS 探测/健康检查）与 `internal/relaymaster`（relay 侧注册客户端）；`bin/` 为可选的本地预编译产物（不纳入提交） | 后端任务 |
| `relay/` | 旧 Node 中继（参考实现 + 原测试，保留对照；生产不用） | 只读/对照 |
| `web/` | 前端站点（原生 ESM 零依赖）+ Node 测试 + 移动端截图工具 | 前端任务 |
| `docs-site/` | VitePress Wiki：relay/master API、WASM 桥接、compose/二进制部署 | 文档任务 |
| `compose.dev.yml` | 开发栈：Go 后端 8390 + relay master 8391 + 站点 8392 + https+wss 8443；**不启动本地游戏服务器**，/api/servers 指向 DDNet 官方 Tutorial | 运维任务 |
| `compose.test.yml` | 测试栈（profiles）：`relay-unit` / `e2e-relay` / `e2e-web` / `syntax-check` / `slow:e2e-reconnect` / `fallback:e2e-rtc-fallback` / `local-server`（可选本地测试服） | 运维任务 |
| `compose.yml` | 生产：Go relay + relay master（**直接拉取 GHCR latest 镜像**；只绑 127.0.0.1:8390/8391；无 Caddy；TLS/WSS 由生产 nginx 终止，静态站点由 nginx root 到 `dist/web`） | 运维任务 |
| `deploy/` | 生产 nginx 配置示例：TLS/WSS、静态站点、`/relay-master/*` 反代 | 运维任务 |
| `.github/workflows/` | build（web/二进制/alpine 镜像）、pages（自动）、publish-ghcr/release（手动） | 运维任务 |
| `build/compose.yml` | wasm 构建（emsdk 镜像，一次性服务） | 均可 |
| `build/` | Docker 构建流水线 + 构建文档 | 构建任务 |
| `dist/web/` | **部署产物**（wasm + 前端 + manifest.json） | 由 assemble 生成 |
| `scripts/` | `dev-up.sh`/`dev-down.sh`（compose 包装）、`assemble-web.sh`、HTTPS+WSS 开发服务器 | 均可 |
| `tests/e2e/` | Puppeteer/Node E2E：`ux_flow` `ux_edge` `ux_settings` `relay_join` `mobile_mode` `desktop_mode` `desktop_touch` `ime_clipboard` `rtc_transport` `server_list` `master_discovery` `relay_reconnect` | Lead |
| `docs/` | `PLAN.md`（历史分析）、`QUICKSTART.md`、截图 | 均可 |

---

## 3. 客户端补丁清单（9 个文件，全部在 ddnet-dev）

| 文件 | 关键改动 |
|---|---|
| `src/engine/shared/websockets_emscripten.cpp`（**新增**） | 客户端传输层：`EM_JS` 直接调用浏览器 API，JS 侧收发队列 + C++ 轮询（不跨线程回调）。**优先尝试 WebRTC DataChannel**（POST `/rtc/offer?target=...` 非 trickle 信令），失败/超时自动回退 WebSocket；实现 websocket_init/create/destroy/send/recv/fd_set/fd_get；另有 URL 注册/反查、`websocket_addr_from_plain`（把纯 host:port 改写成 `<默认后端>/udp/host:port[?query&protocol=7]`）、`DDWeb_SetDefaultRelay(base, query)` 导出、死连接重开（发送失败时丢弃 slot，1 秒冷却后重开）、传输方式日志（`transport for ...: WebRTC data channel (preferred)` / `WebSocket (fallback)`） |
| `src/engine/shared/websockets.h` | 声明上述 emscripten 专用接口（`websocket_set_default_relay(url, query)`、`websocket_addr_from_plain(host, addr, sixup)`） |
| `src/base/net.cpp` | ① `net_host_lookup` 在 emscripten 下识别 ws:// 与 wss://（含 path/query），不走 DNS，注册 URL 并把 32 位 URL 哈希塞进 `NETADDR.ip`；② `net_addr_str` 反查打印原始 URL；③ `net_socket_read_wait` 用 `emscripten_sleep` 让出浏览器；④ 纯 `host:port` 在设置了默认后端时改写成后端 URL，并透传 `NETTYPE_TW7` 以便 URL 带上 `protocol=7` |
| `src/engine/client/client.cpp` | ① emscripten 下只绑 `NETTYPE_WEBSOCKET_IPV4`；② 关闭 STUN；③ connect 参数/地址缓冲加到 1024；④ 解析地址后重新推导 sixup；⑤ 调用 `net_host_lookup` 时把 sixup 标志放进 `types`，保证游戏内浏览器的 0.7 条目经后端连接时 URL 带 `?protocol=7`；⑥ Emscripten 下强制 `Inactive=false`，避免菜单/指针解锁/失焦走 `cl_refresh_rate_inactive` 的阻塞休眠 |
| `src/engine/client/client.h` | `m_aCmdConnect[1024]`（WebSocket URL + token 会超过原来的 256） |
| `src/game/client/ui.h` | `CUi::SetMouseTargetNormalized`：网页解锁鼠标时把游戏内光标 lerp 追踪到真实鼠标坐标（相邻位置直接落点） |
| `src/engine/client/input.cpp` | Emscripten 文本输入/剪贴板桥：`StartTextInput/StopTextInput` 调 `DDWeb_SetTextInputActive`；`SetClipboardText` 改走 `DDWeb_SetClipboardText`；新增 `DDWeb_InputText`（注入 `SDL_TEXTINPUT`，UTF-8 分块）与 `DDWeb_InputKey`（Backspace/Enter/Esc/方向键/Ctrl 组合） |
| `CMakeLists.txt` | emscripten 时 WEBSOCKETS=ON 但跳过 find_package(libwebsockets)，ENGINE_SHARED 用 websockets_emscripten.cpp 替换 websockets.cpp |
| `cmake/toolchains/Emscripten.toolchain` | EXPORTED_FUNCTIONS 增加 `_DDWeb_SetDefaultRelay`、`_DDWeb_InputText`、`_DDWeb_InputKey`、`_DDWeb_SetUiMousePos`、`_DDWeb_GetUiMouseX/Y`、`_DDWeb_SetAbsoluteMouse`、`_DDWeb_IsMenuOpen` |

**连接/地址语法**：

    ws[s]://relay.example.com/udp/<host>:<port>?token=<t>&protocol=7

- 1 个 WebSocket 二进制帧 / 1 个 DataChannel 消息 = 1 个 UDP 数据报（payload 是 DDNet 原始包，≤1400B）
- **传输选择**：`ws[s]://relay/udp/<host>:<port>` 在 wasm JS 层先建 RTCPeerConnection + `game` DataChannel
  （`ordered:false, maxRetransmits:0`），POST `<httpBase>/rtc/offer?target=...` 换 answer；
  ~6 秒内未 open 或信令失败则用同一 URL 回退 WebSocket。URL 加 `?transport=ws` 可强制 WS（调试用）。
- **延迟测量**：`POST /rtc/offer`（不带 target）回显 DataChannel 消息；`/api/info` 的 `iceServers`
  会经 `globalThis.DDWebIceServers` 传给 wasm 传输层和前端测速（公网需在 relay 配 STUN/TURN）。
- `protocol=7`（也接受 protocol=0.7 / sevenup=1 / tw7=1）→ 走 0.7（sixup）协议
- **游戏内服务器浏览器**：列表来自 DDNet master 的 HTTPS JSON（master 带 CORS，wasm 里可用），
  条目地址是 `host:port` 或 `tw-0.7+udp://host:port`。前端启动时调用
  `Module.ccall('DDWeb_SetDefaultRelay', null, ['string','string'], [后端base, query])`，
  C++ 在连接时把这些纯 UDP 地址改写成后端 URL。**没有这一步时点击加入只会 silently 失败。**

---

## 4. 构建 wasm 客户端

    export DOCKER_CONFIG=/root/test/.docker HOME=/root/test/.home   # 沙箱里 /root 只读，必须设置
    cd /root/test/ddnet-web/build
    DRY_RUN=1 ./build-wasm.sh           # 秒级自检
    BUILD_TYPE=Release ./build-wasm.sh  # 约 1.5 分钟，wasm 8.5MB，推荐
    # 也可以用 compose（一次性服务）：
    docker compose -f build/compose.yml run --rm -T wasm-build

- 源码默认 `/root/test/ddnet-web/ddnet-dev`；构建目录 `build/wasm-build`（Debug）、`build/wasm-build-release`（Release）
- 后端 Go 构建用 `golang:1.24-alpine`（pion/webrtc 要求 go>=1.24）；依赖在 `relay-go/vendor`，镜像构建不联网
- 工具链镜像：`ddnet-wasm-builder:emsdk-4.0.22`（官方 emsdk 4.0.22 + rust 1.89 + ninja）
- 备用宿主 emsdk：`/root/test/ddnet-web/build/emsdk-official`

**组装站点（改前端或重建 wasm 后必须执行）**：

    cd /root/test/ddnet-web
    npm ci --prefix docs-site                  # 首次/Wiki 依赖
    scripts/assemble-web.sh

生成 index.html/app.js/style.css/src/assets + manifest.json(sha256) + _headers + `wiki/`。
`assemble-web.sh` 在 `docs-site/node_modules` 存在时会自动构建 VitePress，产物进 `dist/web/wiki/`。
**坑**：wasm 重建后若忘记 assemble，manifest 里旧的 sha256 与文件不匹配，前端会报
“资源校验失败/大小不匹配”，进游戏卡在准备阶段。

---

## 5. 本地运行（全部 docker compose）

    ./scripts/dev-up.sh     # = docker compose -f compose.dev.yml up -d --build + 等待健康
    ./scripts/dev-down.sh   # = docker compose -f compose.dev.yml down

| 容器（compose 服务） | 端口 | 说明 |
|---|---|---|
| `relay` | 8390 | **Go 后端**（compose.dev.yml 内联 servers.json：官方 Tutorial 列表；自动注册到 master） |
| `relay-master` | 8391 | **relay 节点注册中心**：`/v1/register`、`/v1/serverlist`、`/healthz` |
| `web-http` | 8392 | 站点（本机 http://localhost:8392 即安全上下文） |
| `web-https` | 8443 | 站点 + `/api/*` + **同端口 wss 反代**（局域网只需这一个端口） |

访问：
- 本机：http://localhost:8392/
- 局域网：https://<host-ip>:8443/（自签证书 → 点"继续前往"，中继会自动出现「同源中继」）
- relay master：默认 `https://master.landmine.top/v1/serverlist`；本机开发用 `http://127.0.0.1:8391/v1/serverlist`，LAN HTTPS 开发用同源 `/relay-master/v1/serverlist`
- 一键直达：`https://<ip>:8443/?connect=wss%3A%2F%2F<ip>%3A8443%2Fudp%2F74.91.126.203%3A8300&autostart=1`（官方 USA1 Tutorial）

生产：`RELAY_DOMAIN=... MASTER_DOMAIN=... RELAY_PUBLIC_URL=... docker compose -f compose.yml pull && docker compose -f compose.yml up -d`（镜像来自 GHCR latest；`deploy/nginx.conf` 负责 TLS/WSS/静态站点）。

> 注意：用户要求清理时 compose 栈会被 `dev-down.sh` 停掉，端口 8390/8391/8392/8443 随之释放。
> 游戏服务器是 DDNet 官方 Tutorial，不在本机运行；中继需能出站 UDP 到对应官方 IP。

---

## 6. 验证

    # 后端（Go）：79 项单测 + 集成（含 master 注册/探测/健康检查、WebRTC echo、DataChannel↔UDP 桥接）
    docker compose -f compose.test.yml --profile test run --rm relay-unit

    # 后端 → DDNet 官方 Tutorial（gie3/inf3 + CONNECT/ACCEPT/NETMSG_INFO；官方服不保证回 map data）
    docker compose -f compose.test.yml --profile test run --rm e2e-relay

    # Wiki（VitePress）：npm ci --prefix docs-site && npm run docs:build --prefix docs-site
    # 构建后由 assemble-web.sh 复制到 dist/web/wiki

    # 前端 Node 测试（82 项）
    cd web && node tools/test-pure.mjs && node tools/test-assets.mjs && node tools/test-latency.mjs \
      && node tools/test-dom.mjs && node tools/test-integration.mjs

    # Emscripten 源码语法检查（compose）
    ./tests/syntax-check.sh

    # Chromium 全流程 + 游戏内加入 + 移动/触屏 PC + IME/剪贴板 + WebRTC + 服务器筛选（11 个文件，89 项）
    docker compose -f compose.test.yml --profile test run --rm e2e-web

    # WebRTC 失败回退：起一个 RTC_ENABLED=false 的后端（8397），客户端应自动回退 WS
    docker compose -f compose.test.yml --profile fallback run --rm e2e-rtc-fallback

    # 慢速：断开等后端空闲超时（60s）再重连同一服务器（验证死连接重开）
    docker compose -f compose.test.yml --profile slow run --rm e2e-reconnect

    # CI：build.yml 自动构建 web/wiki/linux 二进制/alpine 镜像；pages.yml 自动发布 Pages；
    # publish-ghcr.yml / publish-release.yml 需要 build.yml 的 run_id 手动触发。
    # 只构建 linux/amd64（Alpine 兼容），不生成其他平台。

判定"进游戏成功"：引擎日志出现 `client: connected, sending info`
（`client: using 0.7 (sixup) protocol` 表示走了 0.7）；`/api/stats` 的 targets 可见收发字节。

游戏内加入的验收：`tests/e2e/relay_join.mjs` 用与点击列表相同的 `CClient::Connect` 入参在控制台执行
`connect host:port` / `connect tw-0.7+udp://host:port`，断言连接成功、0.7 的 WebSocket URL 带
`?protocol=7`、后端统计出现目标流量。

---

## 7. 踩过的坑（最重要）

### 7.1 DDNet 命令行参数："+connect" 是错的
`CConsole::ParseArguments` 把**每个 argv 当成一整条控制台命令**执行，不会剥离前导 `+`。
- 错：`Module.arguments = ["+connect", url]` → `chatresp: No such command: +connect`
- 对：`Module.arguments = ["connect <url>"]`（命令和参数必须在同一个字符串里）
- 移动端额外命令要放在 connect 之前：`['cl_touch_controls 1', 'cl_back_button 1', 'connect <url>']`

### 7.2 浏览器安全上下文：SharedArrayBuffer 需要 https 或 localhost
- 站点必须同时发 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`；
- `http://192.168.x.x` **不是**安全上下文，会白屏报 `SharedArrayBuffer transfer requires self.crossOriginIsolated`；
- https 页面里的后端必须是 `wss://`（混合内容会被拦），http(localhost) 页面可用 `ws://`。

### 7.3 服务器列表：官方 master + 后端中转加入
- Web Shell 的服务器列表**直接 fetch DDNet 官方 master**（`https://master1..4.ddnet.org/ddnet/15/servers.json`，
  约 1.2 MB / 1400 台，带 `access-control-allow-origin: *`），前端本地筛选/排序/分页；
  失败时回退到后端 `/api/servers` 推荐列表（`source='relay'`）。
- 点击 master 条目时用该条目的协议（`addresses` 的 `tw-0.6/0.7+udp://` 前缀，双协议优先 0.6）拼
  `<后端>/udp/<host>:<port>`；0.6/0.7 分段按钮只是“默认协议”，用于手动输入/无协议条目。
- master 的 `info.clients` 用来算玩家数（`is_player` 过滤），`max_players`/`max_clients` 算容量；
  `location`（如 `eu:de`）显示为地区筛选；`passworded` 用于隐藏密码房。
- 新增筛选：搜索（名称/地图/地址/类型/地区/版本）、协议、类型、地区、隐藏满员、隐藏密码房、排序。

### 7.4 游戏内服务器浏览器：列表能看，但加入要经过后端
- 列表来自 `https://masterN.ddnet.org/ddnet/15/servers.json`，响应带 `access-control-allow-origin: *`，wasm 的
  `emscripten_fetch` 能取到，所以浏览器里**能浏览**（名字/地图/人数都来自 master）。
- 列表项的 ping 仍是 UDP（浏览器发不出去），所以 ping 列不可用——这是预期。
- 点击加入走 `CMenus::Connect` → `CClient::Connect(addr)`；必须在启动前调用
  `DDWeb_SetDefaultRelay(base, query)`，否则纯 `host:port` 会 `could not find address`（表现为"点了没反应"）。
- 0.7 条目的 `tw-0.7+udp://` 前缀要保留：`net_host_lookup` 的 `types` 里带 `NETTYPE_TW7`，生成的 URL 才会带
  `?protocol=7`；否则会按 0.6 连 0.7 服务器。
- `DDWeb_SetDefaultRelay` 在 `callMain` 之前调用，此时引擎 logger 还没初始化，**它自己的 log_info 可能看不到**；
  用 `__ddwebDebug.state.runtime.defaultRelayApplied` 或"纯 host:port 能否连上"来验证，不要依赖这条日志。

### 7.5 重新构建 wasm 后必须重新 assemble
`manifest.json` 的 sha256/size 与 `DDNet.wasm`/`.data` 必须一致；否则前端资源校验失败，
表现为"开始下载客户端资源…"后卡住（`ERR_CONNECTION_REFUSED`/大小不匹配）。

### 7.6 浏览器 WebSocket 连接会缓存，死连接要能重开
`CNetClient` 按 `NETADDR` 缓存 `SWebSocketConnection`。后端空闲超时（60s）或网络切换后浏览器 socket 会关闭，
如果直接复用旧 slot，发送永远失败（再次加入同一服务器无响应）。补丁里在 `websocket_send` 失败时
丢弃死连接并在 1 秒冷却后重开（`m_NextOpenTick`）。`tests/e2e/relay_reconnect.mjs` 覆盖此场景。

### 7.7 ddnet-libs 子模块：只有 .a 不够，必须有头文件
只 sparse 拉 `*/webasm` 会漏掉 freetype/png/opus/sdl/sqlite3/wavpack/zlib 的 `include/`，
CMake 报 "You must install libpng/Freetype/Ogg/Opus/..."。正确规则：`/*/webasm` + `/*/include`。

### 7.8 worktree 里 ddnet-libs 软链容易建错
目标目录已存在时 `ln -sfn target ddnet-dev/ddnet-libs` 会建出嵌套的
`ddnet-dev/ddnet-libs/ddnet-libs`，容器内解析失败。先 rmdir 再 ln -s，并用 `readlink -f` 验证。
（`tests/syntax-check-inner.sh` 里对绝对软链做了 `/root/test/ddnet-web` → `/w` 的路径翻译。）

### 7.9 沙箱只写 /root/test
- `docker build` 因 buildx 写 /root/.docker 失败 → `export DOCKER_CONFIG=/root/test/.docker`
- `apt-get` / npm 写 $HOME 失败 → `HOME=/root/test/.home`、`npm --cache /root/test/.npm`
- 宿主没有 g++/cmake/ninja/emsdk/go → **一切编译走 Docker**
- **Docker Hub 直连（registry-1.docker.io）在本沙箱不可用**；用 `dockerproxy.net/library/<image>` 拉取后
  `docker tag` 成本地名（golang:1.24-alpine、alpine:3.20、caddy:2-alpine 都已这样处理过）

### 7.10 emsdk 相关
- 官方 emscripten/emsdk:4.0.22 镜像没有 ninja、没有 rust；用 `-G "Unix Makefiles"`，rust 用派生镜像
- Debian12(gcc12) 过不了 CheckAtomic.cmake（libatomic not found），必须用官方镜像的 gcc11 做 base
- 宿主上跑 emsdk install 会因沙箱禁 chown 报 `tar: Cannot change ownership` → 在容器里解包

### 7.11 agent 会话的后台进程会被回收
`run_in_background` 起的 node 服务会随会话结束被回收。长期服务请用 **Docker 容器 + compose + restart**。

### 7.12 前端资源缓存加载
- Cache Storage 存 + sha256 校验，再 URL.createObjectURL 交给 Emscripten；
- `.wasm` 的 Blob **必须** `type: 'application/wasm'`，否则 instantiateStreaming 失败；
- Module.locateFile 映射 DDNet.wasm / DDNet.data 到 blob URL；DDNet.js 用 blob URL 当 script.src。

### 7.13 Emscripten 运行时不能在同一页面重启
退出游戏后重新进入必须刷新页面（UI 已提示）。如需无缝换服用 iframe 隔离重载。

### 7.14 无头 Chromium / E2E
- 无头 Chromium 容器默认没有中文字体，截图是方块 → 挂载 `/usr/share/fonts/opentype/noto`
- **必须加 `--autoplay-policy=no-user-gesture-required`**，否则 AudioContext 解锁等待用户手势，
  客户端卡在 `phase: launching`
- 游戏内控制台是 **F1**；加入/断开命令之间的间隔要足够（连接动画期间 F1 会被忽略），关闭控制台用 F1 而不是 Esc
- E2E 默认连 DDNet 官方 Tutorial（需要出站 UDP；官方服有并发/IP 限制），可用
  `TARGET=host:port TARGET2=host:port` 覆盖；需要完全确定性时临时起本地服务器并覆盖 TARGET
- 浏览器 WebSocket 会被客户端按地址复用：连接**同一个**目标不会打印新的 "opened WebSocket connection"，
  测试不要据此判断失败

### 7.15 WebRTC SDP 不能 TrimSpace
Chrome/Firefox 的 SDP 以 `\r\n` 结尾，pion 的 SDP parser 需要结尾换行；对 offer 做 `strings.TrimSpace`
会得到 714 字节（原 716），pion 报 `failed to unmarshal SDP: EOF`。Go 后端只 trim 用于校验的副本，
真正传给 `SetRemoteDescription` 的字符串保留原样，缺失换行时补 `\r\n`。

### 7.16 EM_JS 里不能写 `//` 注释和正则
`EM_JS` 的 JS 体在 C++ 预处理阶段会被 stringify：`//` 会被当成 C++ 注释吃掉整行，JS 正则里的 `\/`
等反斜杠也会被破坏，最终生成非法 JS（acorn 报 `Unexpected token`，位置在 DDNet.js 很靠后）。
规则：EM_JS 内**不要写 `//` 注释、不要用正则字面量**；路径解析用 `indexOf`/`slice`。JS 里改完必须跑一次
`build-wasm.sh` 验证，不要只看 C++ 能编译。

### 7.17 WebRTC 部署与回退
- 默认只用 host candidates：localhost/LAN 可用；公网部署要：
  1) `RTC_UDP_PORT`（默认与 relay TCP 同端口：dev 8390、生产 443）固定 ICE UDP 端口并放行防火墙；
  2) 后端在 1:1 NAT 后时设 `RTC_PUBLIC_IP` 通告公网 host candidate；
  3) 需要时配 `RTC_ICE_SERVERS`（STUN/TURN URL 列表）。前端从 `/api/info.iceServers` 取到后通过
     `DDWebIceServers` 传给 RTCPeerConnection（游戏传输和测速共用）。
- 游戏 DataChannel 是 `ordered:false, maxRetransmits:0`（UDP 语义）；DDNet netcode 能容忍丢包/重复。
- 浏览器先等 ICE gathering（最多 3s）再 POST 非 trickle offer；~6s 内未 open 就回退 WS。relay `rtc:false`
  时会立即回退。
- relay 侧 RTC 游戏会话不受 60s `maxLifetimeMs` 限制（那是测速 peer 的生命周期），用 `idleTimeoutMs`；
  DataChannel close / 空闲 / peer 上限会关闭并释放 UDP socket。
- `/api/stats.rtc` 有 `gameSessions/activeGameSessions/gamePackets|BytesToTarget/FromTarget`，用于确认游戏流量
  真的走了 WebRTC；`/api/stats.targets` 也会累计 RTC 流量。
- HUD「传输」行和 `Module.DDWSTransport` 显示 `webrtc` / `ws` / `fallback`；流量数字来自 `Module.DDWSStats`
  （WebRTC 不经过 WebSocket，旧的 wsstats 统计不到）。

### 7.18 触控控件只应在触屏设备出现
DDNet 的 `cl_touch_controls` 会存进 IndexedDB。移动端玩过之后切到桌面，配置可能残留为 1，
导致桌面也显示触屏按钮。因此**桌面端启动时也显式执行 `cl_touch_controls 0` / `cl_back_button 0`**
（`buildLaunchArgs` 对两种设备都生成显式开关），并且 Web 层触屏引导/提示/全屏按钮只在
`html[data-device=mobile|tablet]` 或 `touchMode` 时显示。
- 触屏笔记本（fine 指针 + 多点触控）按 desktop 处理。
- **Windows/Linux/macOS/ChromeOS 桌面 + 大屏**即使 `pointer: coarse` / `maxTouchPoints>0`（触控显示器、
  触屏一体机）也按 desktop 处理（`desktop-os-large-screen`），不显示触控面板；小屏 Windows 触屏仍按 mobile。
- 触屏引导/提示的关闭状态写入 `ddweb.touch-guide-dismissed.v1` / `ddweb.touch-hint-dismissed.v1`，
  刷新后不会反复弹出。

### 7.19 其他
- 浏览器没有 fd，`net_socket_read_wait` 必须自己 `emscripten_sleep` 让出，否则页面卡死
- `?protocol=7` 会原样带进 ws 路径，后端只按 path 取目标、忽略未知 query（正常）
- WebRTC 相关坑见 7.16/7.17；前端 `measureRelayLatency` 在 WebRTC 失败后必须继续走 `probeRelay`
  （曾因提前 return 导致延迟显示"不可用"，已修）
- 旧 Node 中继的 `node-datachannel` 是原生模块；Go 版无此依赖

### 7.20 Pointer Lock / ESC / 游戏内光标
- DDNet 的输入层调用 `SDL_SetRelativeMouseMode(true)`；Emscripten SDL 用
  `emscripten_request_pointerlock(canvas, defer=1)`，第一次点击画布后才真正捕获。**浏览器原生 ESC 一定会
  退出 Pointer Lock，网页无法 preventDefault**；DDNet 自己会在菜单里绘制光标（`menus.cpp` 的 `RenderCursor`）。
- 网页端不再试图拦截/重建 Pointer Lock：`#canvas { cursor: none }` 隐藏浏览器指针；ESC 后游戏菜单和
  **DDNet 自己绘制**的光标出现，浏览器指针不会叠在画面上。`pointerlockchange` 只更新状态/日志；
  再次点击画布时网页端调用 `requestPointerLock()` 恢复捕获（菜单点击也可以，游戏光标仍由 DDNet 绘制）。
- 不要用 CSS/DOM 给画布画光标；否则会和 DDNet 的内置光标重复。
- **光标位置同步**：解锁鼠标时网页端监听 `mousemove`，把 `clientX/clientY` 归一化后通过
  `DDWeb_SetUiMousePos` 写入 `CUi` 的目标位置；同时 `DDWeb_SetAbsoluteMouse(1)` 让 `MouseRelative`
  返回 false，避免再叠加相对增量（否则会双倍移动）。
- 光标用 `CUi::SetMouseTargetNormalized` + `CUi::Update` 做 lerp；距离 `< 4px` 时直接落点，
  只有跨屏/大跨度移动才插值。

### 7.21 聚光灯引导不能用整屏 box-shadow
新手引导原来的 `.spotlight-hole { box-shadow: 0 0 0 9999px rgba(...) }` 会在 WebGL 画布上覆盖一整块
合成层；释放鼠标/移动光标时触发整屏重绘，实测 FPS 从 ~195 掉到 ~12。现在用**四块矩形 `.spotlight-shade`**
围出高亮孔（`pointer-events:none`），FPS 保持 ~170–190。游戏内还会关闭 `.hud-panel` / `.touch-hint` 的
`backdrop-filter`，避免对每帧变化的 WebGL 背景持续做模糊。任何覆盖画布的大面积 blur/shadow 都要谨慎。

### 7.22 Tab/ESC 菜单性能
- Emscripten 下窗口失焦/指针解锁可能让 `WindowActive()` 变 false，原逻辑会走
  `cl_refresh_rate_inactive` + `std::this_thread::sleep_for` 阻塞路径，浏览器主循环容易卡顿；
  `client.cpp` 现在在 Emscripten 下强制 `Inactive=false`，保持正常刷新路径。
- 游戏中 Tab 是计分板，但浏览器会拿 Tab 做焦点切换；网页端在 game 视图下对 Tab
  `preventDefault()`，并在 pointerlockchange/解锁时把焦点还给 canvas。
- Tab（`is-scoreboard-open`）和 ESC 菜单（`is-menu-open`）期间隐藏网页 HUD/引导/触屏提示，
  减少浏览器在菜单上的合成开销；松开/关闭后恢复。
- 按住 Tab/ESC 时浏览器会持续发 repeat keydown；在 window capture 阶段直接截断 `event.repeat`，
  避免 DDNet 反复 +scoreboard 和网页类名反复切换触发布局。

### 7.23 wasm 中文 IME / 剪贴板桥
Emscripten 版 DDNet 的 canvas 不是可编辑元素，SDL 只收 keypress，因此：
- 中文输入法不会弹候选框；`Ctrl+V` 也没有可粘贴目标；`SDL_GetClipboardText/SetClipboardText`
  在浏览器里没有可用实现（复制/剪切也失效）。
- 方案：`CInput::StartTextInput` / `StopTextInput` 通过 EM_JS `DDWeb_SetTextInputActive` 通知网页；
  `web/src/ime.js` 激活一个不可见 `textarea#ddweb-ime-input` 并聚焦，组合结束/粘贴后把 UTF-8 文本
  按 30 字节分块，通过 `Module.ccall("DDWeb_InputText")` 注入 `SDL_TEXTINPUT`。
- Backspace/Enter/Esc/方向键等通过 `DDWeb_InputKey` 注入 SDL 键盘事件；`Ctrl+C/X/A` 在隐藏 textarea
  的 keydown 里拦截，先注入真实的 Ctrl 按下，再注入 C/X/A，避免 `ModifierIsPressed()` 在 lineinput
  处理时已释放导致复制/剪切不触发。Ctrl 的释放跟随真实 keyup。
- 复制/剪切由游戏原有 lineinput 逻辑调用 `Input()->SetClipboardText`，Emscripten 分支改为
  EM_JS `DDWeb_SetClipboardText` → `navigator.clipboard.writeText`（execCommand 兜底）。
- 不要在 `#canvas { cursor:none }` 之外再叠加 DOM 光标；隐藏 textarea 只做输入通道。
- `ime_clipboard.mjs` 覆盖：组合输入中文、粘贴、Ctrl+C、Ctrl+X、剪切后输入清空。

### 7.24 relay master（节点注册中心）
- 新服务 `cmd/master`（镜像 `Dockerfile.master`），默认域名 `master.landmine.top`，开发栈监听
  `0.0.0.0:8391`；生产由 nginx 的 `master.landmine.top` 反代到宿主 `127.0.0.1:8391`。
- API：
  - `POST /v1/register`：`{name,url,region,version,players,transports,webrtc}`，`url` 必须是
    `ws://`/`wss://` base；`webrtc:{enabled,host,signalUrl,udpPort}` 声明媒体主机/IP、信令地址和固定 ICE UDP 端口。
    **首次注册 master 主动对 `<url>/ws` 做 RFC6455 握手探测**；失败返回 502，不进入列表。
  - `POST /v1/unregister`：`{url}`，relay 优雅退出时尽力调用。
  - `GET /v1/serverlist`：只返回已验证 + healthy 节点；带 CORS（默认 `*`）。
  - `GET /healthz`、`GET /api/stats`。
- 前端默认请求 **`https://master.landmine.top/v1/serverlist`**；生产也可以改用 nginx 反代 `/relay-master/*`，
  可用 `<meta name="relay-master-base">` / `window.DDWEB_MASTER_BASE` / `?masterBase=` / `?master=` 调整。
- relay 注册同时声明 `transports`（`websocket`/`webrtc`）与
  `webrtc:{enabled,host,signalUrl,udpPort}`。`host` 是 WebRTC UDP 入口的域名/IP（优先
  `RTC_PUBLIC_IP`，否则取广告 URL 主机名）；master 会校验 host，并拒绝
  `webrtc.enabled=true` 且 `udpPort=0`（禁止按用户分配 UDP 端口）。
- relay 默认 `master.domain=master.landmine.top`、`scheme=https`、`enabled=true`、`skipWhenToken=true`；
  可通过 `RELAY_MASTER_DOMAIN` / `--master-domain`（支持 `http://host:port` 形式）、
  `RELAY_MASTER_ADVERTISE_URL` / `--master-advertise-url` 等修改。
- TCP(WS) 与 UDP(ICE) 默认同一端口：dev `8390`、生产 `443`；`RTC_UDP_PORT=0` 会被配置层转换为 relay TCP 端口，
  所有 WebRTC peer 共用 `ice.UDPMuxDefault` 的固定 UDP 端口，不会按用户分配。
- 注册心跳默认 30s；master 对已验证节点的心跳**不重复探测**。master 每 **15 分钟**（`MASTER_PROBE_INTERVAL_MS`）
  用 WS 检查所有节点，失败即 `Remove` 并从 `/v1/serverlist` 消失。
- **设置了 token 的 relay 不注册**（`config.ShouldRegister`）；广告 URL 是 loopback 而 master 是远程域时也跳过，
  避免把 `ws://127.0.0.1` 注册到公网 master。公网部署必须设置 `RELAY_MASTER_ADVERTISE_URL` / `RELAY_PUBLIC_URL`。
- relay 新增 `/ws` 健康升级端点（只接受升级并立即关闭），供 master 探测；生产 nginx 与 dev-https 已放行 `/ws`。
- 注册表是内存态，master 重启后由 relay 30s 心跳重新注册；无持久化。

### 7.25 生产 nginx / 无 Caddy
- Go relay **不实现 TLS**：只监听明文 HTTP/WS；生产 compose 不再包含 Caddy，只把
  `relay` / `relay-master` 绑到 `127.0.0.1:8390/8391`，由 nginx 做 TLS、WSS、HTTP/2、静态站点和限流。
- 生产入口：`deploy/nginx.conf`
  - `play.example.com`：root `dist/web`，加 COOP/COEP，代理 `/udp/`、`/ws`、`/healthz`、`/api/`、`/rtc/`
    到 `127.0.0.1:8390`，`/relay-master/` 到 `127.0.0.1:8391`；
  - `master.landmine.top`：反代 `127.0.0.1:8391`；
  - TCP 443 由 nginx 占用，**UDP 443** 由 relay 占用（同号不同协议）；WebRTC 使用共享固定 `udpPort`。
- 自签证书只适合内网测试：浏览器仍会校验证书；同源页面与 wss 同主机/端口且用户已接受例外时通常可复用，
  跨域名/端口需要单独信任。正式环境直接使用 nginx + 公网证书。
- `deploy/README.md` 有启动参数、证书路径、防火墙和验证命令。
- GitHub Pages 自定义域名 `ddnet.landmine.top` 下 wiki 使用 `/wiki/` base；无自定义域名的项目 Pages
  需要设置仓库变量 `PAGES_BASE=/ddnet-web/wiki/`。

### 7.26 前端 relay master base
- 默认是 `https://master.landmine.top/v1/serverlist`；本机开发用 `http://127.0.0.1:8391`，
  LAN HTTPS dev（8443）走同源 `/relay-master`。生产可继续用 nginx 反代，并用 meta/window/query 覆盖。
- 运行时覆盖：`<meta name="relay-master-base">`、`window.DDWEB_MASTER_BASE`、
  `?masterBase=<base>`、`?master=<完整 endpoint>`。
- dev-http（8392）和 dev-https（8443）都代理 `/relay-master/*`；
  master 返回的 `source='master'` 节点只读，master 不再返回的旧节点会在下次加载时自动清理。

---

## 8. 约定（后续 agent 请遵守）

1. **不要直接改 `ddnet/`**（上游基线）；改 `ddnet-dev/`，再导出补丁：
   `cd ddnet-dev && git add -N src/engine/shared/websockets_emscripten.cpp && git diff master -- CMakeLists.txt cmake src > ../patches/ddnet-web-client.patch`
2. 改完 C++ 必须**重新构建 wasm + 重新 assemble-web.sh**，否则 dist/web 还是旧产物。
3. 前端启动 wasm 的契约：`connect <url>` 永远是一个完整字符串且最后执行。触屏设备前置
   `cl_touch_controls 1`、`cl_back_button 1`；**桌面端前置 `cl_touch_controls 0`、`cl_back_button 0`**
   （显式关闭，避免 IndexedDB 里残留移动端配置导致桌面显示触控控件）。
4. relay master 契约：relay 默认向 `master.landmine.top` 注册；master 首次用 WS `<url>/ws` 验证，
   每 15 分钟复检；有 token 的 relay 不注册；公网 relay 必须显式设置广告 ws(s) URL。
   注册需带 `transports` 和 `webrtc:{enabled,host,signalUrl,udpPort}`；`host`/固定 UDP 端口不可省略。
5. 游戏内地址改写的契约：`DDWeb_SetDefaultRelay(base, query)`，`base` 不带尾斜杠、可含路径；
   `query` 是已 URL 编码的查询串（如 `token=abc`，不带 `?`）；C++ 负责拼 `/udp/<host>:<port>` 并在 0.7 时追加
   `protocol=7`（已有 query 时用 `&`）。
6. 生产 TLS/WSS 由 nginx 负责，Go relay 只实现 HTTP/WS；不要重新引入 Caddy 或应用内 TLS。
7. 长期服务用 Docker compose，不要依赖会话里的后台进程；**不要再多加 `docker run` 式服务启动**。
8. 端口约定：开发/测试后端 8390、relay master 8391、站点 http 8392、站点 https(+wss) 8443；
   生产 nginx 使用 80/443，relay 使用 UDP 443，生产 compose 只绑定 127.0.0.1:8390/8391。
   本沙箱开发环境**不要占用 80/443/3080**（生产部署在外网主机自行放行）。
9. 汇报时给出可复现命令 + 实测输出，不要只说"应该可以"。
10. 前端资源清单：新增 `web/src/*.js` 会被 `assemble-web.sh` 整目录复制，无需改脚本；新增顶层文件要加进脚本列表。

---

## 9. 已知限制 / 后续可做

1. **游戏内浏览器 ping** 仍是 UDP 语义（列表来自 master 所以有名字/人数，ping 列不可用）；加入已通。
   可选：把 ping 也经后端（每台服务器一条 WS，成本高），或后端做服务器信息聚合 API。
2. **WebRTC 依赖 ICE/网络环境**：默认 host candidates 只适合 localhost/LAN；公网需要固定并放行
   `RTC_UDP_PORT`（compose 默认 443/udp，与 TCP 443 同号）、NAT 后设 `RTC_PUBLIC_IP`，必要时再配 `RTC_ICE_SERVERS`
   （STUN/TURN），否则客户端会在 ~6s 后回退 WebSocket。ICE/DTLS 建链会让首次连接多 0.3–2s；
   游戏中的抖动/丢包由不可靠 DataChannel 承担。
3. ws over TCP 有队头阻塞；后端就近部署可缓解。
4. `.data` 资源包 51.6 MB，首屏偏大（已做 sha256 本地缓存 + 进度条）。
5. 生产 `compose.yml` + `deploy/nginx.conf` 只做了 `config` 校验、镜像构建和 nginx 语法校验
   （本机 80/443 被占用），未在真实域名/证书下做端到端验证；生产 TLS 完全由 nginx 负责。
6. 移动端目前是"桌面 wasm + 触屏控件"（`cl_touch_controls`，仅触屏设备启用；桌面/触屏笔记本显式关闭），未做安卓原生壳/手势导航栏适配；WebGL 性能依赖设备。
7. 后端多节点自动选优由前端完成；后端本身无集群/共享统计。
8. 旧的 `relay/`（Node）保留作参考与对照测试，生产镜像已切到 `relay-go/`。
9. relay master 注册表是内存态，没有持久化；master 重启后依赖 relay 心跳重新注册。公开注册只有 IP 限流 +
   节点数上限，没有账号体系；需要更强控制时应在 nginx/网关加鉴权。
10. master 的 `/ws` 探测只验证 WebSocket 握手可达，不验证 relay 的 UDP 出口/游戏转发质量。

---

## 10. 关键文件速查

    ddnet-dev/src/engine/shared/websockets_emscripten.cpp   # wasm 侧 WebRTC/WS 双传输 + 默认后端改写 + 死连接重开
    ddnet-dev/src/base/net.cpp                              # 地址解析 / 默认后端 / read_wait
    ddnet-dev/src/engine/client/client.cpp                  # 绑定类型 / sixup / 缓冲区
    relay-go/internal/relay/server.go                       # HTTP API + WS upgrade + /rtc/offer
    relay-go/internal/relay/session.go                      # WS↔UDP 会话
    relay-go/internal/rtc/manager.go                        # pion/webrtc：echo + DataChannel↔UDP 游戏传输
    relay-go/internal/master/                               # registry + /v1 API + WS 探测 + 15 分钟健康检查
    relay-go/internal/relaymaster/                          # relay 侧 master 注册/心跳客户端
    relay-go/cmd/master/main.go relay-go/Dockerfile.master  # relay master 服务
    relay-go/internal/config/master.go                      # master 地址/注册配置 + ShouldRegister
    deploy/nginx.conf deploy/README.md                       # 生产 TLS/WSS/静态站点/反代
    relay-go/internal/wsproto/                              # 自实现 RFC6455
    relay-go/internal/ssrf/ relay-go/internal/config/       # 安全策略 / 配置
    web/app.js web/src/master.js web/src/ime.js web/src/device.js web/src/connect.js web/src/shortcuts.js
    web/src/latency.js web/src/relayurl.js web/src/probe.js
    .github/workflows/build.yml .github/workflows/pages.yml
    .github/workflows/publish-ghcr.yml .github/workflows/publish-release.yml
    compose.dev.yml compose.test.yml compose.yml deploy/nginx.conf
    scripts/dev-up.sh scripts/dev-down.sh scripts/assemble-web.sh
    docs-site/.vitepress/config.mts docs-site/index.md docs-site/guide docs-site/api
    scripts/build-wiki.sh
    tests/e2e/ux_flow.mjs tests/e2e/relay_join.mjs tests/e2e/mobile_mode.mjs
    tests/e2e/rtc_transport.mjs tests/e2e/server_list.mjs tests/e2e/master_discovery.mjs tests/e2e/desktop_touch.mjs tests/e2e/ime_clipboard.mjs tests/e2e/relay_reconnect.mjs
    docs/QUICKSTART.md docs/PLAN.md
```
