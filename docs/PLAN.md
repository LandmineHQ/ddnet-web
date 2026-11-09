# DDNet Web 客户端 + WSS→UDP 中继：技术分析与实施路线

> 目标：在浏览器中运行一个真实可玩的 DDNet 客户端（C++ → WebAssembly），
> 通过 WebSocket(wss) 连接到我们自己实现的中继后端，由中继把数据报转发给任意 DDNet 服务器（UDP）。
> 前端网站可添加/自定义多个中继后端。

仓库：https://github.com/ddnet/ddnet.git（已 clone 到 `/root/test/ddnet-web/ddnet`，当前 HEAD `a02cf38`）

---

## 0. 结论摘要（TL;DR）

1. **可行性高**：DDNet 上游**已经内置 Emscripten(WebAssembly) 构建**（`cmake/toolchains/Emscripten.toolchain`、`other/emscripten/index.html`、CI `build-emscripten` job），WebGL2/GLES3 渲染、SDL2 输入音频、IndexedDB 存档、Fetch HTTP 全部可用，CI 还能跑 headless 冒烟测试。**唯一缺口是网络**：工具链里明确写着 `TODO: Networking not supported`。
2. **网络缺口正是本项目的核心工作量**。上游的 WebSocket 支持只在**服务器侧**（`src/engine/shared/websockets.cpp`，libwebsockets），且默认 `WEBSOCKETS=OFF`，wasm 目标根本没有编译它。
3. **正确的改造点很小**：只需要让 wasm 客户端拥有一套"客户端侧 WebSocket 传输"，并让 DDNet 的 `NETADDR`/`net_udp_send/recv` 能路由到它。DDNet 的网络抽象（`NETTYPE_WEBSOCKET_IPV4/6` + `ws://` 地址语法）**已经为此留好了挂钩**，改动集中在 4 个文件左右，不动游戏逻辑。
4. **中继协议极简**：DDNet 自己的 lws 桥接就是"**1 个 WebSocket 二进制帧 = 1 个 UDP 数据报**"，我们沿用该约定，中继无需理解游戏协议，只是 UDP 转发器。DDNet 服务器**无需任何修改**（这是相对上游方案的关键优势：上游要求每个游戏服务器自己编译 WebSocket 支持）。
5. **风险点**：wasm 构建链（emsdk 4.0.22 + Rust wasm32 + 预编译第三方库，首次构建 1–2 小时）、pthread/ASYNCIFY 下的 WebSocket 事件线程模型（用"JS 队列 + C++ 轮询"绕开）、SharedArrayBuffer 需要 COOP/COEP + HTTPS。

---

## 1. 需求拆解与验收标准

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | 浏览器中是真正的 DDNet 客户端 | 打开网页能进入游戏主菜单、可移动角色、可说话、画面/音频正常 |
| R2 | WSS 连接中继后端 | 浏览器仅通过 `wss://` 与中继通信，无 UDP 能力依赖 |
| R3 | 中继转发到指定 DDNet 服务器 | 目标服务器可为任意公网/局域网 UDP 服务器（0.6/0.7 协议均可），服务器端零改动 |
| R4 | 可添加多个/自定义后端 | 前端可增删改中继列表（名称、URL、备注、鉴权 token），持久化到 localStorage，可一键测活 |
| R5 | 可用的连接体验 | 服务器列表、连接状态、延迟显示、断线提示、全屏、昵称/皮肤设置 |
| R6 | 可部署 | docker-compose 一键起中继 + 静态站点（Caddy 自动 TLS） |

---

## 2. DDNet 代码分析

### 2.1 仓库结构（重要目录）

```
ddnet/
├── CMakeLists.txt              # 140 KB，单文件巨型构建脚本，逐平台分支
├── cmake/toolchains/           # Emscripten.toolchain 等交叉编译工具链
├── src/base/                   # net.cpp(MADDR/UDP/WS 抽象)、os、thread、log、str
├── src/engine/shared/          # network.cpp(连接/分块/重传)、websockets.cpp(lws 服务端桥)、
│                               # http_emscripten.cpp(fetch 实现)、config_variables.h
├── src/engine/client/          # client.cpp(主循环/连接流程)、serverbrowser、backend_sdl、graphics_threaded
├── src/game/client/            # 游戏客户端 UI/HUD/菜单
├── src/game/server/            # 服务器逻辑（本项目不用）
├── data/                       # 54 MB 资源（字体/皮肤/地图/音效/网络）
├── other/emscripten/           # index.html(官方 web 启动器)、server.py(带 COOP/COEP 的静态服务器)
├── scripts/compile_libs/       # gen_libs.sh：为 android/ios/webasm 预编译第三方库
├── ddnet-libs/                 # git submodule，存放各平台预编译库（含 webasm/libwasm）
└── Cargo.toml                  # Rust 依赖（cxx bridge），wasm 需 wasm32-unknown-emscripten
```

### 2.2 构建系统要点

- **工具链文件** `cmake/toolchains/Emscripten.toolchain`（必须 `EMSDK` 环境变量），关键旗标：
  - `-pthread -s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=10`（固定线程池）
  - `-s ALLOW_BLOCKING_ON_MAIN_THREAD=1`（因 `PROXY_TO_PTHREAD` 暂不支持，被注释）
  - `-s ASYNCIFY=1 -s ASYNCIFY_STACK_SIZE=1MB`（**关键**：主循环靠协程让出浏览器线程）
  - `-s USE_WEBGL2=1 -s FULL_ES3=1`（GLES3 后端，见 `detect.h: CONF_BACKEND_OPENGL_ES3`）
  - `-s FILESYSTEM=1 -lidbfs.js`（IndexedDB 持久化存档）、`-s FETCH=1`（HTTP 走浏览器 fetch）
  - `-s EXPORTED_FUNCTIONS=_main,_EmscriptenCallbackDropFile,_EmscriptenCallbackQuit,_EmscriptenCallbackQuitForce`
  - `-s SHARED_MEMORY=1` → **站点必须发送 COOP/COEP 头**（否则 SharedArrayBuffer 不可用，pthread 起不来）
  - 第 27–28 行注释：
    ```
    # TODO: Networking not supported. Full socket proxying is also blocked by PROXY_TO_PTHREAD not being supported.
    #set(WASM_LINKER_FLAGS "... -lwebsocket.js -s PROXY_POSIX_SOCKETS=1")
    ```
    → **这就是我们要填的坑**。
- **第三方库**：`ddnet-libs/{sdl,freetype,png,zlib,ogg,opus,opusfile,wavpack,sqlite3}/webasm/libwasm/*.a`，
  由 `scripts/compile_libs/gen_libs.sh <build-dir> webasm` 生成（CI 见 `build-libraries-emscripten.yml`，emsdk 4.0.22）。
- **Rust**：`RUST_BRIDGE_SHARED`（cxx），wasm 需 `rustup target add wasm32-unknown-emscripten`，`CMAKE_RUST_COMPILER_TARGET=wasm32-unknown-emscripten`。
- **产物**：`game-client` 目标是 `.html`，但打包时改为自建 `index.html` + `DDNet.data` + `DDNet.js` + `DDNet.wasm`（CMakeLists.txt:4047 起）。

CI 现成的构建命令（可直接复用）：

```bash
emcmake cmake -H. -B build-wasm -DCMAKE_BUILD_TYPE=Release -DVIDEORECORDER=OFF -DVULKAN=OFF \
    -DSERVER=OFF -DTOOLS=OFF -DPREFER_BUNDLED_LIBS=ON
cmake --build build-wasm --target game-client -j16
cmake --build build-wasm --target package_default   # 生成 tar.xz
```

### 2.3 平台抽象

`src/base/detect.h`：`__EMSCRIPTEN__` → `CONF_PLATFORM_EMSCRIPTEN`、`CONF_FAMILY_UNIX`、`CONF_BACKEND_OPENGL_ES/ES3`。

### 2.4 网络栈（本项目最核心的部分）

层次自下而上：

```
CClient (engine/client/client.cpp)
  └ CNetClient / CNetConnection (engine/shared/network.cpp)  ← 握手、分块、重传、token
      └ net_udp_send / net_udp_recv (base/net.cpp)           ← 收发数据报，按 NETADDR 路由
          ├─ 真实 UDP socket (priv_net_create_socket)
          └─ WebSocket 通道 (CONF_WEBSOCKETS 时启用)
                └ websocket_send/recv → libwebsockets
```

- **NETADDR**：`{ unsigned char ip[16]; unsigned short port; int type; }`，`type` 是位集：
  `NETTYPE_IPV4/IPV6/WEBSOCKET_IPV4(1<<2)/WEBSOCKET_IPV6(1<<3)/LINK_BROADCAST/TW7`（`src/base/types.h:114-157`）。
- **`net_udp_send`**（net.cpp:1065 起）：`if(addr->type & NETTYPE_WEBSOCKET_IPV4) → websocket_send(sock->web_ipv4sock, ...)`，
  否则走 `sendto()`。`net_udp_recv` 反之。
- **`net_udp_create(BindAddr)`**（net.cpp:906）：按 `bindaddr.type` 分别创建 IPv4 UDP / IPv6 UDP / **WebSocket 通道**（`CONF_WEBSOCKETS` 守卫）。
  返回的 `sock->type` 就是 `CNetClient::NetType()`，用于 `net_host_lookup` 的地址族过滤。
- **`net_host_lookup`**（net.cpp:602）：`if(str_startswith(hostname, "ws://"))` → 解析主机、DNS、把 type 改成 `NETTYPE_WEBSOCKET_IPV4/6`。
  也就是说 **DDNet 已经支持用 `ws://host:port` 作为服务器地址**，客户端会把包发到 WebSocket 通道而不是 UDP。
- **`websockets.cpp`（服务端 lws 桥）**：接收浏览器 WebSocket 连接，把每个二进制帧当成一个"来自该浏览器"的数据报注入服务器；
  回包时用 `lws_client_connect_via_info`/writable 回调写回。**协议约定：1 帧 = 1 数据报，payload 就是裸 DDNet 包**。
  （`mutes.cpp`/`netban.cpp` 对 WS 地址做了 NAT 地址映射处理。）

**结论**：DDNet 的数据面抽象天然适合本项目。我们只需提供一个"**客户端版**"的 `websocket_*` 实现，并让 Emscripten 目标编译它。

### 2.5 现有 WebSocket 支持的真实边界

- `WEBSOCKETS` 是 CMake option，**默认 OFF**；开启需 `find_package(Websockets)`（libwebsockets）。
- `gen_libs.sh` 里 **没有** 为 webasm 编译 libwebsockets → wasm 目标拿不到 lws。
- 因此 `other/emscripten/index.html` 里"Connection to most servers is currently not possible. Servers must be compiled with support for WebSockets." 目前的实际含义是：web 客户端**基本无法联网**。
- 我们的路线**不依赖 libwebsockets**：在 wasm 里直接用浏览器原生 WebSocket（`EM_JS`），既小又快。

### 2.6 客户端连接流程（改造点定位）

```
CClient::Connect(pAddress)                     client.cpp:598
  ├ 按 ',' 切分多地址
  ├ net_addr_from_url()                        只认 tw-0.6+udp:// tw-0.7+udp://
  ├ net_host_lookup(host, &addr, NetType())    ★ 这里识别 ws:// 并决定地址族（需扩展 wss:// 与 path）
  ├ 端口默认 8303，sixup 标记 NETTYPE_TW7
  └ CNetClient::Connect/addrs → 握手（security token、连接包、5s 超时）
        ↓ 每帧
     net_udp_send/recv  →  ★ 我们的 WebSocket 通道
```

其它相关点：
- `CClient::ResetSocket()`（client.cpp:1115）：`BindAddr.type = NETTYPE_ALL` → emscripten 下要改成只绑 WebSocket 类型。
- `CNetClient` 构造里 `new CStun(m_Socket)`（network_client.cpp:26）→ emscripten 下必须禁用 STUN/UPnP。
- `CServerBrowser` 的局域网广播（`NETTYPE_LINK_BROADCAST`）在浏览器中无意义，忽略。
- 双连接 `CONN_MAIN`/`CONN_DUMMY`（`cl_dummy`）会开两条 WS，中继需支持同一目标的多连接。

### 2.7 Emscripten 现状小结

| 能力 | wasm 现状 | 说明 |
|---|---|---|
| 渲染 | ✅ WebGL2/GLES3 | `backend_sdl.cpp` + `CONF_BACKEND_OPENGL_ES3` |
| 输入 | ✅ SDL2 | 键鼠触摸 |
| 音频 | ✅ SDL2 | 需用户手势解锁 |
| 存档 | ✅ IndexedDB | `/home/web_user/.local/share/ddnet` |
| HTTP | ✅ fetch | `http_emscripten.cpp`（master server 列表可用） |
| 定时器/主循环 | ✅ ASYNCIFY | 不能用 `emscripten_set_main_loop` |
| **UDP** | ❌ | 浏览器无 UDP |
| **WebSocket 客户端** | ❌ | 本文档要补的部分 |
| 线程 | ✅ pthread（需 COOP/COEP） | 固定线程池 10 |

---

## 3. 总体架构

```
┌──────────────────────────── 浏览器（HTTPS 站点） ────────────────────────────┐
│  Web 前端 Shell (HTML/ESM)                       DDNet 客户端 (WASM)          │
│  ├ 中继管理 UI（多后端、自定义、测活）   ──launch──▶  Module.callMain([...])   │
│  ├ 服务器列表 / 分享链接                              │                      │
│  └ 状态/延迟浮层                                      ▼                      │
│                                         net_udp_send → websockets_emscripten │
│                                                    │ (EM_JS)                 │
│                                         browser WebSocket  ── 1 帧=1 数据报 ──┐│
└──────────────────────────────────────────────────────────────┬─────────────┘│
                                                                │ wss://        │
                                            ┌───────────────────▼───────────┐   │
                                            │  中继后端 Relay (Node.js)      │   │
                                            │  wss 接入 / 目标解析 / 鉴权    │   │
                                            │  限流 / 多连接 / 统计          │   │
                                            │  每连接一个 dgram UDP socket   │   │
                                            └───────────────┬───────────────┘   │
                                                            │ UDP               │
                                            ┌───────────────▼───────────────┐   │
                                            │  任意 DDNet 服务器 :8303       │   │
                                            │  （无需改动，0.6/0.7 均可）    │   │
                                            └───────────────────────────────┘   │
```

**为什么不用别的方案**：

| 备选 | 结论 |
|---|---|
| Emscripten `-sPROXY_POSIX_SOCKETS` + wsproxy | TCP 流会丢数据报边界，需自造分帧；且依赖 `PROXY_TO_PTHREAD`（上游注释说不支持）。**否决** |
| 让游戏服务器自己开 lws（上游方案） | 需要每个服务器重编译并开放额外端口，公共服务器不可用。**否决**（但可作为兼容模式保留） |
| WebRTC DataChannel + TURN | 延迟更优，但信令/TURN 复杂度高，作为 M5+ 优化项 |
| Linux 客户端 + xvfb + noVNC 串流 | 带宽/延迟/成本不可接受。**否决** |

---

## 4. 中继协议设计（v1）

### 4.1 连接地址

浏览器（DDNet 客户端内部地址语法）：

```
wss://relay.example.com:443/udp/<target-host>:<target-port>?token=<optional>
```

- 兼容上游的 `ws://`，新增 `wss://`；**authority 之后的 path 保留**（上游 `net_host_lookup` 会把它当主机名的一部分，需要我们打补丁拆开）。
- 客户端内部把整条 URL 注册到表里，用 32 位 FNV-1a(URL) 填进 `NETADDR.ip`，`port` 填 URL 端口，type 置 `NETTYPE_WEBSOCKET_IPV4`。
  这样 `net_addr_comp`/`ServerAddress()` 等原有逻辑继续有效，同时可以反查回 URL（用于 UI 显示）。

### 4.2 数据帧

- 每个 **WebSocket 二进制消息 = 1 个 UDP 数据报**，双向对称，payload 即 DDNet 原始包（`NET_MAX_PACKETSIZE` = 1400 字节上限）。
- 文本消息仅用于控制（如 `{"type":"hello"...}`、`{"type":"pong"}`），非必需。
- 保活：中继每 20s 发 ws ping；60s 无流量断开；客户端侧由浏览器自动应答 pong。

### 4.3 中继职责

1. **目标解析**：从 path/`?target=` 解析 `host:port`，做 SSRF 防护（默认禁止私有网段/回环/链路本地，可白名单）。
2. **会话**：每个 ws 连接对应一个 `dgram.socket('udp4')`（或复用池，按 目标 分组），`message` 事件回写 ws。
3. **鉴权**：可选 `?token=` 或 `Authorization`，与配置里的 token 列表比对；支持 `Origin` 白名单。
4. **限流**：每 IP 并发连接数、每连接 pps/bps、帧大小上限（>1400 丢弃）、连接时长上限。
5. **HTTP 辅助接口**：`GET /healthz`、`GET /api/servers`（运营者维护的推荐服务器列表，供前端"服务器列表"使用）、`GET /api/stats`。
6. **可观测**：结构化日志（连接ID/目标/字节数/时长）、`/metrics`（Prometheus 文本）。

### 4.4 与 DDNet 协议的兼容性说明

- DDNet 客户端连接握手依赖"服务器回包能对它发出的地址"；中继对客户端是一个透明的 UDP 对端，服务器看到的是中继的外网地址，回包原路返回 → 完全兼容。
- 服务器侧 `security token`/`0.7 connless` 机制对中继透明（中继不改字节）。
- 多连接（dummy、同时 ping 多台服务器）天然支持：每个 `NETADDR` 一条 WS，一个 WS 一个 UDP 五元组。

---

## 5. DDNet 客户端改造方案（文件级清单）

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| C1 | `cmake/toolchains/Emscripten.toolchain` | 新增 wasm 需要的导出/方法旗标；**不**启用 lws | 低 |
| C2 | `CMakeLists.txt` | `TARGET_OS==emscripten` 时：`WEBSOCKETS` 自动 ON、跳过 `find_package(Websockets)`、把 `src/engine/shared/websockets_emscripten.cpp` 加入 `ENGINE_SHARED`、为目标加 `CONF_WEBSOCKETS` | 中（CMake 巨文件，需谨慎） |
| C3 | `src/engine/shared/websockets_emscripten.cpp/.h`（新增） | 客户端 WS 传输：`websocket_init/create/destroy/send/recv/fd_set/fd_get`，内部用 `EM_JS` 调浏览器 WebSocket；引用计数 + URL 注册表 | 中 |
| C4 | `src/base/net.cpp` | `net_host_lookup` 支持 `wss://` 与 path，emscripten 下跳过 DNS 与 `getaddrinfo`，改为 URL→hash 注册；`net_udp_create` 在 emscripten 下只建 WS 通道 | 中 |
| C5 | `src/engine/client/client.cpp` | emscripten 下 `BindAddr.type` 只含 WS 位；禁用 STUN/UPnP；连接日志打印原始 URL | 低 |
| C6 | `other/emscripten/index.html` | **替换**为我们自己的前端 Shell（保留其 Module 配置/IDBFS/错误处理等成熟逻辑） | 低 |
| C7 | `CMakeLists.txt`（打包） | 输出 `DDNet.js/.wasm/.data` 到 `dist/web/`，并生成带 COOP/COEP 的 `_headers`/`server.py` | 低 |

### 5.1 C3 技术要点（关键设计）

不对齐 libwebsockets API 的语义，只实现 `websockets.h` 里被 `net.cpp` 用到的 5 个函数。底层用 **`EM_JS` + JS 侧队列 + C++ 轮询**，避免在 pthread/ASYNCIFY 模型下把 WebSocket 回调跨线程调度回 wasm：

```cpp
// JS 侧：每个 slot 一个 WebSocket 对象 + 待发队列 + 待收队列
EM_JS(int, dd_ws_open, (int slot, const char *url_ptr), { ... });
EM_JS(int, dd_ws_send, (int slot, const void *ptr, int len), { ... });  // 未 open 时入待发队列
EM_JS(int, dd_ws_poll, (int slot, void *dst, int maxlen), { ... });    // 返回帧长 / 0 无数据 / -1 已关闭
EM_JS(int, dd_ws_state, (int slot), { ... });
EM_JS(void, dd_ws_close, (int slot), { ... });
```

- `binaryType = 'arraybuffer'`，`onmessage` 中 `queue.push(new Uint8Array(e.data))`，**不做任何 wasm 回调**。
- `net_udp_recv` 每帧轮询即可；浏览器事件在 wasm 让出（ASYNCIFY 的 `emscripten_sleep`）期间被 JS 事件循环处理。
- 断线：`ws.onclose` 置状态位，`websocket_recv` 返回 -1，`CNetConnection` 自然进入超时重连逻辑（Web 端可在前端做"重连"按钮）。

### 5.2 地址语法示例

```
+connect wss://relay.example.com/udp/ddnet.example.org:8303
+connect wss://relay2.example.com:8443/udp/1.2.3.4:8303?token=abcd
```

---

## 6. 前端网站设计

- **技术选型**：原生 ESM + HTML/CSS（零构建、直接静态托管，减少工具链风险）；复杂后再引入 Vite。
- **页面结构**
  1. 启动页：DDNet logo + 资源加载进度（复用上游 `monitorRunDependencies`）+ "开始"（用户手势解锁音频）。
  2. 中继管理面板：列表（名称/URL/启用/延迟/在线人数）、新增/编辑/删除/拖动排序、导入导出 JSON、一键测活（ws 握手 + 往返 ping）。
  3. 目标服务器：输入 `host:port` 或从中继的 `/api/servers` 列表选择；支持 `ddnet://` 深链。
  4. 客户端画布：全屏、指针锁定、退出后回到 Shell。
  5. 状态浮层：当前中继、目标、RTT、上下行字节、丢包（由中继回控制帧统计）。
- **持久化**：`localStorage`（中继列表、最近连接的服务器、昵称、画质设置）。
- **部署要求**：必须 HTTPS（Secure Context）+ COOP/COEP 头（`Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Embedder-Policy: require-corp`）+ 正确的 MIME（`.wasm: application/wasm`）。
- **分享链接**：`/?relay=<id>&target=host:port`，可生成"加入房间"链接。

---

## 7. 里程碑与验收

| 里程碑 | 内容 | 验收标准 | 预估 |
|---|---|---|---|
| **M0 构建可复现** | Docker(emsdk 4.0.22 + cmake/ninja + rust wasm32) + 预编译 webasm 库；`make wasm` 产出 `DDNet.{js,wasm,data}` | 本地静态服务器打开，客户端能进主菜单、能播放 demo、能退出 | 4–6 h（首次下载/编译占大头） |
| **M1 中继 v1** | Node 中继：wss↔UDP、目标解析、鉴权、限流、/healthz、/api/servers、日志 | 单元测试 + 用本地 DDNet 服务器（docker）验证：模拟客户端经 wss 完成一次完整握手 | 3–5 h |
| **M2 wasm 联网打通** | C1–C5 补丁 + 端到端联调 | 浏览器 `connect wss://relay/udp/<本地服务器>` 成功进游戏、能移动/聊天，5 分钟不超时 | 6–10 h |
| **M3 前端站点** | Shell + 中继管理 + 服务器列表 + 状态浮层 + 深链 | 真实用户流程：添加中继→选服务器→进入游戏→断线提示→重连 | 5–8 h |
| **M4 稳定性** | 心跳/重连/延迟显示/大包/移动端触摸/全屏/音量解锁 | 1 小时连续游玩无卡死；弱网（限速 200ms/2% 丢包）可玩 | 4–6 h |
| **M5 增强（可选）** | 游戏内服务器浏览器改写为 ws 地址、皮肤、录像、多中继自动选优、WebRTC 直连 | 浏览器内能翻服务器列表并双击进入 | 6–10 h |
| **M6 交付** | docker-compose（Caddy TLS + relay + 静态站点）、压力测试、文档、CI | 一条命令部署；100 并发连接稳定；README 可复现 | 4–6 h |

**总工作量估算：约 32–50 小时**（其中 M0 受网络下载速度影响最大）。

---

## 8. 风险清单与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| emsdk/依赖下载慢（本机实测 ~0.1–0.3 MB/s，代理） | M0 拖期 | 后台长任务下载；docker 层缓存；优先复用 CI 预编译 `ddnet-libs`；必要时只做 `-DVIDEORECORDER=OFF -DSERVER=OFF -DTOOLS=OFF` 的最小构建 |
| Rust `wasm32-unknown-emscripten` 目标 + cxx 桥 | 构建失败 | 镜像内 `rustup target add`；CI 已验证 1.89.0 可用 |
| pthread/ASYNCIFY 下的 WS 回调线程模型 | 事件丢/崩溃 | **JS 队列 + C++ 轮询**（不做跨线程回调），已在设计中规避 |
| SharedArrayBuffer/COOP-COEP | 客户端启动失败 | 站点统一加头；`server.py` 本地开发也加；用 `crossOriginIsolated` 自检并提示 |
| ws over TCP 的队头阻塞/抖动 | 游戏体验差（卡顿） | 中继就近部署、`nodelay`、限制单帧 1400B、必要时聚合多目标连接；前端显示 RTT |
| 私网/回环被 SSRF 滥用 | 安全 | 默认拒绝私有网段，白名单放行局域网模式 |
| 开放中继被当作 UDP 放大器 | 滥用/被封 | 鉴权 token、Origin 白名单、pps/bps 限流、单 IP 连接数上限 |
| `net_addr_str` 对 ws 地址显示为哈希 IP | UI 困惑 | 维护 addr→URL 表，前端/控制台显示原始 URL；必要时给 `CClient` 加 `ServerAddressString()` |
| 协议差异（0.6/0.7、`NETTYPE_TW7`） | 连不上某些服务器 | 中继与协议无关；客户端同时支持 `connect` 与 `connect6`；服务器端无需改动 |
| 资源包 54 MB（`.data`） | 首屏慢 | 拆分/裁剪资源，或 gzip+brotli + HTTP 缓存 |

---

## 9. 目录结构（本项目）

```
/root/test/ddnet-web/
├── ddnet/                  # 上游源码（唯一写者：Lead），含我们的补丁
├── build/                  # 构建脚本、Dockerfile、CMake 缓存（不入库构建产物）
├── relay/                  # 中继后端（Node.js + ws + dgram）+ 测试
├── web/                    # 前端 Shell（静态站点源）
├── dist/                   # 构建产物：web/（DDNet.js/.wasm/.data + 前端整合）
├── docs/                   # 本计划、联调记录、部署文档
└── docker-compose.yml      # 一键部署（relay + caddy + 静态站点）
```

---

## 10. 测试与验收方法

1. **中继单测**：`host:port` 解析、SSRF 拒绝、帧大小、限流、鉴权、UDP echo 往返。
2. **中继集成**：`docker run ddnet/ddnet-server` 起本地服务器（或用 `ddnet-server` 源构建），写一个 Node 假客户端通过 wss 完成 0.6 握手。
3. **wasm 冒烟**：CI 同款 `emrun --browser firefox --headless` 跑 `quit` 命令；再用 puppeteer 打开页面断言 `crossOriginIsolated === true` 且无 JS 错误。
4. **端到端**：浏览器 `+connect wss://...` → 断言进入 `STATE_ONLINE`（可通过 `Module.print` 日志匹配 "connected" 字样）。
5. **压力**：`ws` 客户端脚本模拟 100 连接，检查 CPU/内存/延迟。

---

## 11. 部署

```yaml
# docker-compose.yml（草案）
services:
  relay:
    build: ./relay
    environment:
      - RELAY_TOKEN_LIST=...      # 可选
      - ALLOW_PRIVATE=false
      - MAX_CONNS_PER_IP=8
    expose: ["8080"]
  web:
    build: ./web               # 静态站点 + DDNet 产物
    expose: ["80"]
  caddy:                       # 自动 HTTPS/证书
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: [./Caddyfile:/etc/caddy/Caddyfile]
```

```caddyfile
example.com {
  handle /relay/* { reverse_proxy relay:8080 }
  handle { root * /srv/web; file_server; encode zstd gzip }
  header Cross-Origin-Opener-Policy same-origin
  header Cross-Origin-Embedder-Policy require-corp
  header /DDNet.wasm Content-Type application/wasm
}
```

---

## 12. 立即执行的下一步（本次任务顺序）

1. 拉取 `emscripten/emsdk:4.0.22` 镜像并安装 cmake/ninja/rust wasm32（后台进行中）。
2. 初始化 `ddnet-libs` 子模块，确认 `webasm/libwasm` 预编译库是否齐全；缺失则跑 `gen_libs.sh`。
3. 首次全量构建，记录耗时与产物大小，形成 `build/` 下的可复现脚本。
4. 并行开发：中继后端（`relay/`）与前端 Shell（`web/`）——这两块不依赖 wasm 构建。
5. wasm 联网补丁（C1–C5）→ 与中继联调 → 端到端验收。

---

## 13. 实施结果（本次已完成）

> 本章是计划执行后的实际结果记录，日期：2026-11-07。

### 13.1 已完成

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 构建可复现 | ✅ | `build/build-wasm.sh`（Debug 2m38s / Release 2m09s），产物 `dist/web`、`dist/web-release`；`build/README.md` 记录两条可复现路径与 9 个坑 |
| M1 中继 v1 | ✅ | `relay/`，`npm test` 90 项全绿；真实 DDNet 20.2.1 服务器 `inf3` 回包 + 完整 0.6 握手 + 地图 4 个 chunk |
| M2 wasm 联网 | ✅ | 浏览器 → `ws://`/`wss://` 中继 → 真实服务器，日志 `client: connected, sending info`，截图见 `docs/screenshots/` |
| M3 前端站点 | ✅ | 中继管理/服务器列表/状态浮层/深链；Chromium 实测 `crossOriginIsolated=true`、`+connect` 参数链路 |
| M4 稳定性 | 🟡 部分 | 心跳、限流、空闲超时、重连（客户端原生超时逻辑）已具备；移动端/弱网未系统测试 |
| M5 增强 | ⬜ 未做 | 游戏内服务器浏览器改写、0.7 支持、WebRTC |
| M6 交付 | 🟡 部分 | docker-compose + Caddyfile + relay Dockerfile 已写；未做压测 |

### 13.2 关键实测数据

- wasm 体积：Debug 66.4 MB / **Release 8.5 MB**（`-O3 -flto` 构建仅 2 分钟，无需回避）
- 中继 RTT（localhost）：1.9–2.0 ms；客户端 60 pps 在 300pps/600burst 限流下无丢包
- Chromium headless 下 WebGL2（SwiftShader）可用，`crossOriginIsolated` 与 SharedArrayBuffer 正常

### 13.3 与原计划的偏差

1. **不需要 libwebsockets**：原计划就预判到，实际确认用 `EM_JS` 方案更简单，且避免了为 wasm 编译 lws。
2. **构建时间远低于预期**：原估 M0 需 4–6 小时（主要是下载），实际 emsdk 用官方镜像 +
   并行 range 下载解决，构建本身仅 2 分钟。
3. **命令行参数语法修正**：DDNet 的 `ParseArguments` 按“每个 argv 就是一条控制台命令”解析，
   因此必须传 `"connect <url>"` 单个参数，而不是 `"+connect"` + url 两个参数。前端已修正。
4. **调试期发现的两个真实缺陷**（已修）：ddnet-libs 只有 `.a` 没有头文件；worktree 的
   `ddnet-libs` 软链创建方式错误导致容器内解析失败。

### 13.4 后续建议（按优先级）

1. 游戏内服务器浏览器直连（改写 `CServerBrowser` 条目的 NETADDR 为 ws URL）——体验提升最大。
2. 弱网与移动端专项测试（触摸、全屏、音频解锁、切后台断线重连）。
3. 中继就近多节点 + 前端自动选优；可选 WebRTC DataChannel 降低 TCP 队头阻塞。
4. 资源包裁剪（51.6 MB 的 `.data`）与 CDN 缓存策略。

### 13.5 第二轮迭代（用户验收后）

用户实测反馈"能玩，但前端不好看、配置太多"，并提出新的五屏流程 + 兼容性优化。本轮改动：

**A. 前端 UX 重做**
1. 首屏先提示下载 `DDNet.wasm`(8.5MB) 与 `DDNet.data`(51.6MB)，确认后右下角悬浮进度条后台下载；
   两个文件按 `manifest.json` 里的 **sha256** 校验后写入 Cache Storage 本地缓存，之后不再提示。
2. 中继后端选择页：卡片列表 + **WebRTC 数据通道实测 RTT**（中继 `POST /rtc/offer` 提供 offer/answer 与回显），
   按延迟升序；底部"自定义"卡片可添加任意后端（ws/wss + 可选 token）。
3. 选中后端后若资源未就绪 → 屏幕中央载入页 + 双进度条，可关闭返回重选。
4. 后端连接成功 → 游戏服务器列表（`/api/servers`）；失败 → 明确错误面板，可重试。
5. 进入游戏后首次聚光灯引导指向"后端连接信息"面板，`Ctrl+反引号键`（后续版本替换了被 Windows 占用的 Ctrl+Esc）切换显隐。

**C. 兼容性**
- **0.7 协议**：WebSocket URL 支持 `?protocol=7`（也接受 `protocol=0.7` / `sevenup=1` / `tw7=1`），
  解析时置 `NETTYPE_TW7`，`CClient::Connect` 在解析地址后重新推导 sixup 标志并走 `Connect7`。
  实测日志 `client: using 0.7 (sixup) protocol` → 成功进入真实服务器。
- **多中继自动选优**：前端按 WebRTC 延迟排序并默认选中最低延迟后端。
- **WebRTC 降延迟**：中继新增 WebRTC echo 端点（`node-datachannel`），既用于测速，也为后续
  浏览器↔中继走 DataChannel 传输（绕过 TCP 队头阻塞）留出通道。

**已知限制（更新）**
- 游戏内服务器浏览器仍走 UDP 语义，浏览器里不可用；服务器选择在 Web Shell 中完成。
