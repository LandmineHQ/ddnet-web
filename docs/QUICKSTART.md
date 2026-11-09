# 现在就能试：DDNet Web 客户端

## 〇、docker compose 一键起停（推荐）

所有常驻服务、测试、wasm 构建都走 `docker compose`（不再手写 `docker run`）：

```bash
cd /root/test/ddnet-web

# 开发/演示栈（项目名 ddnet-web-dev，端口 8390/8391/8392/8443；不启动本地游戏服务器）
docker compose -f compose.dev.yml up -d --build   # 或 ./scripts/dev-up.sh（会等健康检查并打印状态）
docker compose -f compose.dev.yml ps
docker compose -f compose.dev.yml logs -f relay
docker compose -f compose.dev.yml down            # 或 ./scripts/dev-down.sh

# 测试（一次性服务，restart: "no"；e2e-* 需先起上面的 dev 栈）
docker compose -f compose.test.yml --profile test run --rm relay-unit   # Go 中继 go vet + go test
docker compose -f compose.test.yml --profile test run --rm e2e-relay    # ws 中继 -> UDP 真实 DDNet 0.6 握手
docker compose -f compose.test.yml --profile test run --rm e2e-web      # 浏览器全流程 + 游戏内加入 + 移动端（截图在 tests/out/）
docker compose -f compose.test.yml --profile fallback run --rm e2e-rtc-fallback # WebRTC 不可用时回退 WS
docker compose -f compose.test.yml --profile slow run --rm e2e-reconnect # 断开等后端空闲超时后重连同一服务器

# WASM 构建（一次性；等价于 build/build-wasm.sh 的 compose 版）
docker compose -f build/compose.yml run --rm wasm-build
BUILD_TYPE=Release docker compose -f build/compose.yml run --rm wasm-build

# 生产部署（Go 中继 + relay master，TLS/WSS 由 nginx 终止）
RELAY_DOMAIN=play.example.com RELAY_PUBLIC_URL=wss://play.example.com MASTER_DOMAIN=master.landmine.top \
  docker compose -f compose.yml up -d --build
# TLS/WSS/静态站点由生产 nginx 负责，见 deploy/nginx.conf
```

> Docker Hub 直连不可用时用镜像 `dockerproxy.net`（例如
> `GO_IMAGE=dockerproxy.net/library/golang:1.24-alpine docker compose -f compose.test.yml ...`）。

## 一、启动

```bash
cd /root/test/ddnet-web && ./scripts/dev-up.sh     # = docker compose -f compose.dev.yml up -d --build + 等健康检查
./scripts/dev-down.sh                    # = docker compose -f compose.dev.yml down
```

| compose 服务 | 端口 | 说明 |
|---|---|---|
| `relay` | 8390 | Go 中继：ws + UDP 转发 + `/api/*`（`relay-go/`；自动注册到 master） |
| `relay-master` | 8391 | relay 节点注册中心：`/v1/register`、`/v1/serverlist` |
| `web-http` | 8392 | 站点（HTTP，本机 `localhost` 访问即可） |
| `web-https` | 8443 | 站点 + `/api/*` + **同端口 wss 反代**（局域网只需这一个端口） |

relay master：页面默认请求同源 `/relay-master/v1/serverlist`（relay 自动注册；直连调试 http://127.0.0.1:8391/v1/serverlist）。
游戏服务器：默认是 DDNet 官方 Tutorial（`/api/servers` 列 USA1/USA4/GER/Singapore），中继直接 UDP 连过去，
本机不需要（也不再启动）本地服务器。

## 二、浏览器打开

### 本机
```
http://localhost:8392/
```
中继会自动出现（`ws://127.0.0.1:8390`）。

### 局域网 / 另一台机器（只需一个端口）
```
https://192.168.31.31:8443/
```
- 自签证书会警告：点「高级 → 继续前往」；
- 页面与中继**同源**，中继列表会自动出现「同源中继（本机）」——不用再手填地址，也不会混合内容拦截。

### 一键直达（跳过选择直接进游戏）
```
https://192.168.31.31:8443/?connect=wss%3A%2F%2F192.168.31.31%3A8443%2Fudp%2F74.91.126.203%3A8300&autostart=1
```

## 三、界面流程

1. **首次打开**：提示下载客户端资源（`DDNet.wasm` 8.5 MB + `DDNet.data` 51.6 MB）→ 确认后右下角悬浮双进度条 → sha256 校验后写入浏览器缓存，之后不再提示。
2. **选择后端**：卡片按 WebRTC 实测延迟升序；**自定义后端可编辑 / 删除**；点「添加自定义后端」随时新增。
3. **载入**：资源未就绪时中央载入页（可关闭，后台继续下载）。
4. **服务器列表**：直接读取 DDNet 官方 master 的**全部服务器**（约 1400 台），支持搜索、协议/类型/地区筛选、
   隐藏满员/密码房、按玩家数/名称/地区排序、分页；master 不可达时回退到后端推荐列表；连不上显示错误面板。
5. **进入游戏**：首次自动聚光灯引导指向"后端连接信息"面板；**Ctrl + 反引号键**（`~` 键）切换显隐。
6. **游戏内服务器浏览器**：DDNet 菜单里可以浏览 master 列表；点击加入会自动经后端节点中转（0.6/0.7 都支持）。
7. **传输方式**：游戏流量优先走 **WebRTC DataChannel**（延迟最低），失败自动回退 WebSocket；
   游戏内 HUD「传输」行会显示实际方式。公网后端建议配 `RTC_ICE_SERVERS`（STUN/TURN）。
7. **手机 / 平板**：页面自动识别触屏设备，显示触屏操作指南与全屏按钮，并启用 DDNet 内置触屏控件
   （`cl_touch_controls 1`、`cl_back_button 1`）；建议横屏。桌面/非触控设备不会显示触控控件（Windows 触控显示器/触屏笔记本也按桌面处理）；
按 ESC 打开游戏菜单时只显示 DDNet 自己的光标，点击画布恢复鼠标捕获。
游戏内聊天/控制台支持中文输入法与 Ctrl+V/C/X 剪贴板。

右上角可切换**亮色/深色主题**（默认亮色）。

## 四、连自己的 / 0.7 服务器

- 中继需能 UDP 到达目标：内网目标要把 `security.allowPrivate` 设为 `true` 或加 `allowlist`；
- 服务器列表来自中继 `/api/servers`，也可在服务器页手动输入 `host:port`；
- **0.7**：服务器页右上角切到 0.7，连接 URL 自动带 `?protocol=7`，HUD 显示"协议 0.7"。

## 五、常见问题

| 现象 | 解决 |
|---|---|
| 打不开页面 | `./scripts/dev-up.sh` 看 4 个容器是否都在；`docker ps`。局域网用 **8443**（https），不是 8444 |
| 页面白屏/SharedArrayBuffer 报错 | 用了 `http://非localhost`，改 https 或 localhost |
| 中继列表里延迟是"—" | WebRTC 被浏览器策略拦（无网络/无证书）；会自动回退 HTTP 测速并标注 |
| 连不上后端 | 看错误面板里的请求地址与原因；确认中继容器在跑 |
| 想换服务器 | 退出游戏回 Shell 重选（wasm 运行时不能同页重启） |
