# DDNet WSS → UDP 中继（relay）

浏览器里的 DDNet WebAssembly 客户端没有 UDP 能力。本服务在浏览器和任意原生 DDNet
服务器之间做一层极简中继：

```
浏览器 (WASM 客户端)
  │  wss://relay.example.com/udp/<target-host>:<target-port>?token=...
  │  每个 WebSocket 二进制消息 = 1 个 UDP 数据报
  ▼
Node.js relay（本项目）
  │  每个 WS 连接 ↔ 一个 connected dgram UDP socket
  │  1 frame = 1 datagram，双向透明转发，不理解 DDNet 协议
  ▼
原生 DDNet 服务器（0.6 / 0.7 均可，无需任何改动）
```

因为中继不解析 DDNet 协议，服务器端的 security token、0.6/0.7 协议差异、
connless/serverbrowse 包全部原样透传；中继只是一个"带鉴权与限流的 UDP 端口"。

## 特性

- Node.js ESM，运行依赖 [`ws`](https://github.com/websockets/ws) 与
  [`node-datachannel`](https://github.com/murat-dogan/node-datachannel)（WebRTC），无构建步骤。
- URL 目标解析：`/udp/host:port`、`/udp?target=host:port`，支持 IPv6（`[::1]:8303`）。
- SSRF 防护：默认拒绝私网/回环/链路本地/多播/保留地址；DNS 校验**全部**解析结果并把
  校验后的 IP 钉死给 dgram（防 DNS rebinding）；支持 `ALLOW_PRIVATE` 与 host/IP/CIDR 白名单。
- 鉴权：token 列表（环境变量或 JSON）、`?token=` / `Authorization: Bearer` /
  `x-relay-token`；Origin 白名单。
- 限流：每 IP 并发连接数、每连接 packets/s + bytes/s、帧大小（>2048B 丢弃并计数）、
  空闲超时（默认 60s）、最长连接时长、总连接数。
- WebRTC 延迟探测：`POST /rtc/offer` 用 `node-datachannel` 完成 offer/answer，
  数据通道消息原样回显（文本/二进制），浏览器可用它测各中继 RTT；有并发 peer 数、
  存活时长、offer 体积、单 IP 请求限流和超时保护。
- 元信息：`GET /api/info`（name/region/protocol/rtc/uptime/activeConnections）。
- 可观测：每行一个 JSON 的结构化日志（连接 id、目标、字节数、时长、关闭原因）、
  `GET /healthz`、`GET /api/stats`、`GET /api/servers`。
- 健壮性：目标不可达、DNS 失败、UDP 错误都只关闭当前会话，不崩溃；优雅关闭；
  TCP_NODELAY；连接建立前的包短暂排队。
- 测试：`node --test`（URL/SSRF/鉴权/限流/帧大小/配置单测 + UDP echo 集成 +
  WebRTC offer/answer/回显/并发），以及真实 DDNet 服务器的端到端脚本（可选完整 0.6
  握手：connect → connectaccept → accept → info → 服务器开始发地图数据）。

## 快速开始

要求：Node.js ≥ 20（开发/验证用 v24）。

```bash
cd relay
npm install                      # ws + node-datachannel
npm test                         # 100 个测试（单测 + UDP echo + WebRTC）
npm start -- --config relay.config.json
# 或：node bin/relay.mjs --config relay.config.json
```

启动后：

```bash
curl http://127.0.0.1:8390/healthz
curl http://127.0.0.1:8390/api/info
curl http://127.0.0.1:8390/api/stats
curl http://127.0.0.1:8390/api/servers
# 客户端连接（echo 服务器 / 真实服务器自由替换）：
#   ws://127.0.0.1:8390/udp/127.0.0.1:8313
# WebRTC 延迟探测（对运行中的 relay）：
npm run test:rtc -- --relay http://127.0.0.1:8390
```

`relay.config.json` 是本地开发配置：端口 8390，**未配置 token**（仅监听 127.0.0.1，
并且 SSRF 白名单只放行 `127.0.0.1/32`、`::1/128`）。生产部署务必配置 token、TLS 和
Origin 白名单，见"安全建议"。

### 当前联调环境（relay + 真实 DDNet，复现命令）

本机约定端口：relay `0.0.0.0:8390`（使用 `relay.dev-lan.json`：token 为空、白名单仅
`127.0.0.1/::1`、`name="DDNet Relay (dev)"`、`region="local"`、RTC 开启）、DDNet 服务器
`127.0.0.1:8313/udp`、前端静态站点 `127.0.0.1:8392`（web-dev 负责）。浏览器 E2E 使用：

```
ws://127.0.0.1:8390/udp/127.0.0.1:8313
http://127.0.0.1:8390/api/info
POST http://127.0.0.1:8390/rtc/offer
```

当前 8390 由 Docker host-network 容器 **`ddnet-relay-dev`** 运行（挂载 `/root/test/relay`，
使用 `node:24-bookworm-slim`），这样 WebRTC host candidate 使用宿主网卡，浏览器可直达。
复现/重启：

```bash
# 当前运行方式（host network；改代码后需 remove + run 重启）
docker rm -f ddnet-relay-dev
docker run -d --name ddnet-relay-dev --restart unless-stopped --network host \
  -v /root/test/relay:/app:ro -w /app node:24-bookworm-slim \
  node bin/relay.mjs --config relay.dev-lan.json

# 或者不用 Docker（仅本机 UDP 中继调试；WebRTC 也走本机回环，见备注）
cd /root/test/relay && npm start -- --config relay.dev-lan.json
```

```bash
# 真实 DDNet 服务器（官方 20.2.1 二进制跑在 Docker，UDP 8313 -> 宿主）
cd /root/test/relay
bash test/start-ddnet-server.sh
# 首次会下载官方包到 relay/.cache/（已缓存时秒起）；容器名 ddnet-e2e

# 协议级端到端 + WebRTC 验证
cd /root/test/relay
npm run test:e2e
npm run test:rtc -- --relay http://127.0.0.1:8390 --concurrency 16
```

> 说明：`relay.dev-lan.json` 故意未开 token、Origin 列表为空（接受任意浏览器 Origin），
> 监听 `0.0.0.0:8390` 仅供本机/局域网联调；公网部署请参考"安全建议"配置 token 与 TLS。

## 协议

### 连接 URL

```
ws(s)://<relay-host>[:port]/udp/<target-host>:<target-port>[?token=<token>]
ws(s)://<relay-host>[:port]/udp?target=<target-host>:<target-port>[&token=<token>]
```

- `target-host` 可以是域名、IPv4 或带方括号的 IPv6（如 `[2001:db8::1]:8303`）。
- 省略端口时默认 **8303**（DDNet 默认端口）。
- `?target=` 与路径目标同时出现时必须一致，否则返回 400 `target_conflict`。
- token 也可以放在请求头：`Authorization: Bearer <token>` 或 `x-relay-token: <token>`。
  浏览器原生 `WebSocket` 无法设置自定义请求头，浏览器场景请用 `?token=`。
- 目前中继本身只提供明文 `ws://`/HTTP，**生产环境必须由 Caddy/Nginx 终止 TLS**，
  对外暴露 `wss://`。

### 数据帧

- **每个二进制 WebSocket 消息 = 1 个 UDP 数据报**，payload 原样转发，双向对称。
- 中继不做分片/合包/压缩，不修改任何字节；DDNet 包上限 1400B（`NET_MAX_PACKETSIZE`），
  中继默认帧上限 2048B（可配置），超过即丢弃并计入 `droppedFrames`。
- 文本消息不属于数据协议，直接忽略并计数（`text_frame`）。没有 hello/handshake 控制帧。
- 客户端必须设置 `binaryType = 'arraybuffer'`，并把收到的每个二进制消息作为 1 个
  数据报交给虚拟网卡。
- 每个 WebSocket 连接对应一个独立的 UDP socket 和独立的源端口/五元组，因此：
  - 同一目标可以同时开多条连接（DDNet `cl_dummy`、同时 ping 多台服务器都没问题）；
  - 服务器看到的源地址是该 UDP socket 的地址，回包按 connected socket 五元组原路返回。

浏览器侧示意：

```js
const ws = new WebSocket(`wss://relay.example.com/udp/${targetHost}:${targetPort}?token=${token}`);
ws.binaryType = 'arraybuffer';
ws.onmessage = (event) => {
  const datagram = new Uint8Array(event.data); // 1 frame = 1 UDP datagram
  // 交给 wasm 的 WebSocket 接收队列
};
// 发送：每帧一个 Uint8Array
ws.send(datagramBytes);
```

### 关闭码

| 关闭码 | 原因 | 说明 |
| --- | --- | --- |
| 1000 | `client_closed` | 客户端正常关闭 |
| 1001 | `idle_timeout` | 超过 `idleTimeoutMs` 无任何数据（默认 60s） |
| 1001 | `max_duration` | 超过 `maxConnectionMs`（默认 0 = 不限制） |
| 1001 | `server_shutdown` | 中继优雅关闭 |
| 1011 | `target_unreachable` / `udp_error` | 目标端口不可达或 UDP socket 出错 |
| 1009 | — | 帧超过 `hardMaxFrameBytes`（ws 库强制断开） |

HTTP Upgrade 阶段的失败会在握手前返回明确的 JSON 错误（见"错误码"表）并关闭连接；
WebSocket 建连成功后才会出现上述关闭码。

### 限流与 DDNet 客户端流量特征

- DDNet 客户端约每 16ms 发 1 个包（≈60pps/连接）；按 1400B/包计算约 84KB/s。
- 默认 `maxPacketsPerSecond=300` / `packetBurst=600`、`maxBytesPerSecond=262144` /
  `byteBurst=524288`，单连接峰值（60pps / 84KB/s）有 4~5 倍余量，不会误杀；DDNet 的
  输入/keepalive 抖动、短时突发也在 burst 内。
- pps/bps 只统计 **客户端 → 中继** 的二进制数据帧；**服务器 → 客户端** 的回包不经过这层
  限流（回包只受 `maxBufferedBytes` 背压保护影响）。
- WS ping/pong 保活走 WebSocket 控制帧，不进入数据帧路径，**不消耗** pps/bps 配额；
  集成测试里用 1pps/2burst 的极小预算验证过 ping/pong 后仍可正常发包。
- 空闲超时只在中继双向都没有数据时计时；DDNet 连接每秒都有包，正常游戏不会触发 60s
  `idle_timeout`。
- 服务器列表/地图下载是服务器→客户端大流量（远大于 60pps），不受入向 pps 限制。

## 配置

配置优先级：**默认值 < JSON 文件 < 环境变量 < 命令行参数**。

```bash
node bin/relay.mjs --config relay.config.json
```

### 完整 JSON 示例

```json
{
  "name": "DDNet Relay",
  "region": "eu-west",
  "host": "127.0.0.1",
  "port": 8390,
  "udpPath": "/udp",
  "logLevel": "info",
  "trustProxy": false,
  "auth": {
    "tokens": ["change-me"],
    "originAllowlist": ["https://ddnet.example.com", "http://localhost:5173"],
    "allowNoOrigin": true,
    "tokenHeader": "x-relay-token"
  },
  "security": {
    "allowPrivate": false,
    "allowlist": ["127.0.0.1/32", "192.168.1.0/24", "my-lan-server.local"],
    "dnsTimeoutMs": 5000
  },
  "limits": {
    "maxConnectionsPerIp": 8,
    "maxConnectionsTotal": 1000,
    "maxFrameBytes": 2048,
    "hardMaxFrameBytes": 65536,
    "maxPacketsPerSecond": 300,
    "packetBurst": 600,
    "maxBytesPerSecond": 262144,
    "byteBurst": 524288,
    "idleTimeoutMs": 60000,
    "maxConnectionMs": 0,
    "maxBufferedBytes": 524288,
    "pingIntervalMs": 20000,
    "maxPendingPackets": 256
  },
  "api": {
    "statsEnabled": true,
    "serversEnabled": true,
    "corsOrigins": ["*"]
  },
  "rtc": {
    "enabled": true,
    "maxPeers": 16,
    "maxLifetimeMs": 60000,
    "maxOfferBytes": 262144,
    "maxOffersPerIpPerMinute": 30,
    "offerBurst": 10,
    "gatherTimeoutMs": 5000,
    "iceServers": []
  },
  "servers": [
    { "name": "DDNet GER", "host": "ger1.ddnet.org", "port": 8303, "note": "示例，请替换" }
  ]
}
```

### 配置项

| JSON 键 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `name` | `RELAY_NAME` | `DDNet Relay` | 中继显示名（`/api/info`，前端卡片） |
| `region` | `RELAY_REGION` | `""` | 区域标签（`/api/info`，前端卡片） |
| `host` | `RELAY_HOST` | `127.0.0.1` | 监听地址；容器内用 `0.0.0.0` |
| `port` | `RELAY_PORT` | `8390` | HTTP + WS 共用端口 |
| `udpPath` | `RELAY_UDP_PATH` | `/udp` | WebSocket 路径前缀 |
| `logLevel` | `RELAY_LOG_LEVEL` | `info` | `debug/info/warn/error/silent` |
| `trustProxy` | `RELAY_TRUST_PROXY` | `false` | 仅反代后面用；开启后信任 `X-Forwarded-For` 的第一个地址 |
| `auth.tokens` | `RELAY_TOKENS`（或 `RELAY_TOKEN`） | `[]` | 逗号分隔或 JSON 数组；为空表示匿名可用（启动时 warn） |
| `auth.originAllowlist` | `RELAY_ORIGINS` | `[]` | 允许的浏览器 Origin；空数组 = 不限制（启动时 warn）；支持 `*` 与 `https://*.example.com` |
| `auth.allowNoOrigin` | `RELAY_ALLOW_NO_ORIGIN` | `true` | 是否允许没有 Origin 头的非浏览器客户端 |
| `auth.tokenHeader` | — | `x-relay-token` | 自定义 token 请求头名 |
| `security.allowPrivate` | `ALLOW_PRIVATE` | `false` | `true` = 允许私网/回环/链路本地目标（危险，仅供内网） |
| `security.allowlist` | `RELAY_ALLOWLIST` | `[]` | 放行的 host / IP / CIDR，逗号分隔 |
| `security.dnsTimeoutMs` | `RELAY_DNS_TIMEOUT_MS` | `5000` | DNS 解析超时 |
| `limits.maxConnectionsPerIp` | `MAX_CONNS_PER_IP` | `8` | 单 IP 并发 WS 连接数 |
| `limits.maxConnectionsTotal` | `MAX_CONNECTIONS_TOTAL` | `1000` | 全局并发连接数 |
| `limits.maxFrameBytes` | `MAX_FRAME_BYTES` | `2048` | 单帧上限，超过丢弃并计数 |
| `limits.hardMaxFrameBytes` | `HARD_MAX_FRAME_BYTES` | `65536` | ws 库硬上限，超过直接 1009 断开 |
| `limits.maxPacketsPerSecond` | `MAX_PACKETS_PER_SEC` | `300` | 每连接入向包速率（含 burst） |
| `limits.packetBurst` | `PACKET_BURST` | `600` | 包令牌桶容量 |
| `limits.maxBytesPerSecond` | `MAX_BYTES_PER_SEC` | `262144` | 每连接入向字节速率 |
| `limits.byteBurst` | `BYTE_BURST` | `524288` | 字节令牌桶容量 |
| `limits.idleTimeoutMs` | `IDLE_TIMEOUT_MS` | `60000` | 空闲超时；0 = 关闭 |
| `limits.maxConnectionMs` | `MAX_CONNECTION_MS` | `0` | 最长连接时长；0 = 不限制 |
| `limits.maxBufferedBytes` | `MAX_BUFFERED_BYTES` | `524288` | WS 发送缓冲超过此值时丢弃 UDP 回包（背压保护） |
| `limits.pingIntervalMs` | `PING_INTERVAL_MS` | `20000` | WS ping 间隔；0 = 关闭 |
| `limits.maxPendingPackets` | — | `256` | UDP connect 完成前的排队包上限 |
| `api.statsEnabled` | — | `true` | 是否暴露 `/api/stats` |
| `api.serversEnabled` | — | `true` | 是否暴露 `/api/servers` |
| `api.corsOrigins` | `RELAY_API_CORS` | `["*"]` | API/WebRTC 的 CORS 允许来源 |
| `rtc.enabled` | `RTC_ENABLED` | `true` | 是否启用 `POST /rtc/offer` |
| `rtc.maxPeers` | `RTC_MAX_PEERS` | `16` | 全局并发 PeerConnection 上限 |
| `rtc.maxLifetimeMs` | `RTC_MAX_LIFETIME_MS` | `60000` | 单个 WebRTC peer 最长存活时间 |
| `rtc.maxOfferBytes` | `RTC_MAX_OFFER_BYTES` | `262144` | POST body（offer）体积上限 |
| `rtc.maxOffersPerIpPerMinute` | `RTC_MAX_OFFERS_PER_IP_PER_MINUTE` | `30` | 单 IP 的 offer 请求速率 |
| `rtc.offerBurst` | `RTC_OFFER_BURST` | `10` | 单 IP offer 令牌桶容量 |
| `rtc.gatherTimeoutMs` | `RTC_GATHER_TIMEOUT_MS` | `5000` | 等待 answer/ICE candidate 的超时 |
| `rtc.iceServers` | `RTC_ICE_SERVERS` | `[]` | STUN/TURN URL 列表（逗号分隔），公网 NAT 后面需要 STUN |
| `servers` | `RELAY_SERVERS_FILE` | `[]` | 推荐服务器列表（见下） |

命令行参数覆盖上述配置：

```bash
node bin/relay.mjs --config relay.config.json --host 0.0.0.0 --port 8390 \
  --token 'prod-token-1' --log-level warn --allow-private
```

排查配置时打印**当前生效的完整 key 配置**（token 只显示数量，绝不打明文）：

```bash
node bin/relay.mjs --config relay.config.json --print-config
# 同样的内容也会出现在 GET /api/stats 的 "config" 字段
```

完整参数见 `node bin/relay.mjs --help`。

### 推荐服务器列表（/api/servers）

运营者在配置文件（或 `RELAY_SERVERS_FILE` 指向的 JSON）里维护，供前端"服务器列表"展示。
支持字符串或对象：

```json
{
  "servers": [
    { "name": "DDNet GER", "host": "ger1.ddnet.org", "port": 8303, "note": "Germany" },
    "ddnet.tw:8303"
  ]
}
```

加载后会规范化并补全 `address` 字段：

```json
{
  "servers": [
    { "name": "DDNet GER", "host": "ger1.ddnet.org", "port": 8303,
      "note": "Germany", "address": "ger1.ddnet.org:8303" }
  ],
  "count": 1,
  "generatedAt": "2026-11-07T15:27:40.811Z"
}
```

> 注意：`/api/servers` 只是展示列表，不参与 SSRF 判断；客户端实际连接时仍会按
> `/udp/<host>:<port>` 规则解析并做 SSRF 校验。

## HTTP API

| 方法/路径 | 说明 |
| --- | --- |
| `GET /healthz` | 健康检查：`{status:"ok", version, activeConnections, rtc, uptimeSec, time}` |
| `GET /api/info` | 前端元信息：`{name, version, protocol:"ws-udp-datagram/1", region, rtc, uptimeSec, activeConnections}` |
| `GET /api/stats` | 聚合统计：活跃/总连接、双向包/字节、丢弃原因、关闭原因、目标分布（前 50）、生效配置（`config`）与 WebRTC 统计（`rtc`） |
| `GET /api/servers` | 运营者维护的推荐服务器列表（结构保持 `{servers:[{name,host,port,address,note?}],count}`） |
| `POST /rtc/offer` | WebRTC 延迟探测：提交 offer，返回 answer；数据通道消息原样回显 |
| `OPTIONS /api/*`、`OPTIONS /rtc/offer` | CORS 预检（允许 POST 与 `x-relay-token` 头） |

> 配置了 `auth.tokens` 时，WebSocket（`/udp/*`）与 `POST /rtc/offer` 需要 token；
> `/healthz` 与 `/api/*` 保持公开，方便前端测活和展示。如果元信息/统计也要保护，
> 请在反代层限制 `/api/*`，或关闭 `statsEnabled`。

`/api/stats` 主要字段：

```json
{
  "activeConnections": 2,
  "totalConnections": 17,
  "bytesToTarget": 123456,
  "bytesFromTarget": 987654,
  "packetsToTarget": 1234,
  "packetsFromTarget": 5678,
  "droppedFrames": 3,
  "dropsByReason": { "frame_too_large": 1, "packet_rate": 2 },
  "closeReasons": { "client_closed": 15, "idle_timeout": 2 },
  "targets": [
    { "target": "127.0.0.1:8313", "connections": 1, "activeConnections": 1,
      "packetsToTarget": 1, "packetsFromTarget": 1,
      "bytesToTarget": 15, "bytesFromTarget": 107 }
  ],
  "config": {
    "name": "DDNet Relay",
    "region": "eu-west",
    "host": "127.0.0.1",
    "port": 8390,
    "udpPath": "/udp",
    "auth": { "tokensConfigured": 1, "originAllowlist": ["https://ddnet.example.com"], "allowNoOrigin": true },
    "security": { "allowPrivate": false, "allowlist": ["127.0.0.1/32"], "dnsTimeoutMs": 5000 },
    "limits": { "maxFrameBytes": 2048, "maxPacketsPerSecond": 300, "packetBurst": 600, "idleTimeoutMs": 60000 },
    "rtc": { "enabled": true, "maxPeers": 16, "maxLifetimeMs": 60000, "iceServers": [] }
  },
  "rtc": { "enabled": true, "available": true, "activePeers": 1, "maxPeers": 16, "totalOffers": 3, "answersCreated": 3, "messagesEchoed": 7 }
}
```

> `config` 是排查便利功能，会暴露白名单/限流等非敏感配置；如不希望公开，可关闭
> `statsEnabled` 或在反代层限制 `/api/stats`。token 只会以 `tokensConfigured` 数量出现。

### GET /api/info

前端卡片展示用，无 token 也可访问（公开后端）：

```json
{
  "name": "DDNet Relay",
  "version": "1.0.0",
  "protocol": "ws-udp-datagram/1",
  "region": "eu-west",
  "rtc": true,
  "uptimeSec": 3600,
  "activeConnections": 2,
  "time": "2026-11-08T01:20:00.000Z"
}
```

`rtc` 表示 WebRTC 端点当前是否可用（依赖 `node-datachannel` 成功加载；加载失败时
UDP 中继仍正常，`/rtc/offer` 返回 503 `rtc_unavailable`）。

### POST /rtc/offer（WebRTC 延迟探测）

浏览器建立一个只含 data channel 的 `RTCPeerConnection`，把 offer POST 给中继；
中继用 `node-datachannel` 建对端、设置 remote description、生成 answer（非 trickle，
answer SDP 自带 host/STUN candidate）；之后 data channel 的每条消息原样回显，
可用于测 RTT。

请求：

```json
{ "type": "offer", "sdp": "v=0\r\n..." }
```

响应：

```json
{ "type": "answer", "sdp": "v=0\r\n..." }
```

限制与行为：

- 并发 PeerConnection ≤ `rtc.maxPeers`（默认 16），超出返回 503 `rtc_busy`；
- 单 peer 存活 ≤ `rtc.maxLifetimeMs`（默认 60s），到时自动关闭；
- body 上限 `rtc.maxOfferBytes`（默认 256KB），超出 413 `offer_too_large`；
- 单 IP offer 速率受 `rtc.maxOffersPerIpPerMinute` / `rtc.offerBurst` 限制（429 `rtc_rate_limited`）；
- data channel 文本消息回文本，二进制消息（ArrayBuffer/Uint8Array）回二进制，字节不变；
- `tokens` 非空时，`/rtc/offer` 支持 `?token=`、`x-relay-token`、`Authorization: Bearer`；
- `OPTIONS` 预检返回 CORS 头（与 `/api/*` 一致，允许 `content-type` 与 `x-relay-token`）；
- 失败都会返回明确 JSON 错误码（见下表），不会导致进程崩溃。

浏览器示例（非 trickle：等 ICE gathering complete 再 POST）：

```js
const pc = new RTCPeerConnection({ iceServers: [] });
const dc = pc.createDataChannel('latency');
pc.addEventListener('datachannel', (event) => {
  event.channel.onmessage = (message) => { /* 收到 echo */ };
});
await pc.setLocalDescription(await pc.createOffer());
await new Promise((resolve) => {
  if (pc.iceGatheringState === 'complete') resolve();
  else pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState === 'complete') resolve();
  });
});
const response = await fetch('/rtc/offer', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }),
});
const answer = await response.json();
await pc.setRemoteDescription(answer);
dc.onopen = () => {
  const sentAt = performance.now();
  dc.send(String(sentAt)); // 中继原样回显
  dc.onmessage = (message) => console.log('RTT', performance.now() - Number(message.data));
};
```

命令行验证（会打印 5 次 RTT，并可选并发 16）：

```bash
cd relay
npm run test:rtc -- --relay http://127.0.0.1:8390 --count 5 --concurrency 16
```

#### 部署注意事项（WebRTC）

- 中继只做 signaling（HTTP POST）与一个 libdatachannel peer；媒体/数据走 WebRTC 的
  UDP ICE 通道，不经过 Caddy。Caddy 反代只需放行 `/rtc/offer` 的 HTTPS 请求。
- 浏览器和中继要能互相直达：中继有公网 IP 时 host candidate 可用；在 NAT 后面时，
  给中继配置 `rtc.iceServers`（例如 `["stun:stun.l.google.com:19302"]`）以收集 srflx
  candidate。**不提供 TURN**，对称 NAT/严格防火墙下可能无法建连。
- Docker 默认 bridge 网络下 host candidate 是容器内网 IP，浏览器不可达；需要
  `--network host` 或端口映射 + STUN/公网 IP。生产建议直接在公网主机上运行或用
  host network。
- 浏览器侧如果只做 RTT 探测，数据量很小；中继的 peer 数量、存活时间和 IP 限流
  就是主要资源保护。

## HTTP / WebRTC 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `bad_target` / `bad_port` / `target_conflict` | 目标格式不合法 |
| 400 | `bad_path` | 不是 `/udp/...` 路径 |
| 400 | `invalid_offer` | WebRTC offer 不是合法 JSON/SDP |
| 401 | `unauthorized` | token 缺失或错误（WS 与 `/rtc/offer`） |
| 403 | `origin_denied` | Origin 不在白名单 |
| 403 | `target_not_allowed` | SSRF 拒绝（私网/回环/链路本地等） |
| 404 | `not_found` | 未知 HTTP 路径 |
| 405 | `method_not_allowed` | HTTP 方法不匹配 |
| 408 | `request_timeout` | 读取 `/rtc/offer` body 超时 |
| 413 | `offer_too_large` | offer body 超过 `rtc.maxOfferBytes` |
| 429 | `too_many_connections` / `rtc_rate_limited` | 单 IP 并发连接或 offer 速率超限 |
| 502 | `dns_failed` | 域名解析失败/超时 |
| 503 | `server_busy` | 全站 UDP 并发连接超限 |
| 503 | `rtc_disabled` / `rtc_unavailable` / `rtc_busy` | WebRTC 关闭 / 原生模块不可用 / peer 数已满 |
| 504 | `rtc_gather_timeout` / `rtc_answer_failed` | ICE candidate 或 answer 生成超时/失败 |

错误响应是 JSON，例如：

```json
{ "error": "Target 127.0.0.1 resolves to a blocked loopback address (127.0.0.1); set ALLOW_PRIVATE=true or add an allowlist entry to permit it", "code": "target_not_allowed" }
```

## 日志

每行一个 JSON 对象，便于 Loki/ELK 采集。典型事件：

```json
{"ts":"2026-11-07T15:27:14.973Z","level":"info","event":"connection_open","connId":"c-4481df19","target":"127.0.0.1:8313","clientIp":"127.0.0.1","family":4,"address":"127.0.0.1","port":8313}
{"ts":"...","level":"info","event":"connection_closed","connId":"c-4481df19","target":"127.0.0.1:8313","clientIp":"127.0.0.1","reason":"client_closed","durationMs":7,"bytesToTarget":15,"bytesFromTarget":107,"packetsToTarget":1,"packetsFromTarget":1,"dropped":{}}
```

日志不会输出 token 明文；高频丢弃（帧超限、限流、背压）做 5 秒一次的采样告警，避免日志洪泛。

## 测试

### 单元 + UDP echo 集成

```bash
cd relay
npm test
```

覆盖：

- URL 解析：path/query、IPv6、默认端口、非法端口/主机、token 提取；
- SSRF：全部私有/回环/链路本地/多播/保留段、IPv4-mapped IPv6、白名单 host/IP/CIDR、
  DNS 全应答校验、rebinding、DNS 失败；
- 鉴权：无 token、错误 token、多 token、Bearer/x-relay-token、Origin 精确/通配/缺失；
- 限流与帧大小：令牌桶、每 IP 连接数、>2048B 丢弃并计数；
- 配置：默认值、JSON + env + CLI 优先级、非法值 fail-fast、name/region/rtc、
  `--print-config` 不泄漏 token；
- UDP echo 集成：随机端口 echo 服务 + 真实 ws 客户端，验证 1/14/1400 字节往返完全一致，
  以及鉴权/SSRF/Origin/帧超限/包限流/空闲超时/每 IP 上限/目标不可达/优雅关闭；
- DDNet 真实流量特征：60pps 客户端流不被限流；WS ping/pong 不消耗 pps 配额；
- **WebRTC**（`test/rtc-echo.test.mjs`，真实 `node-datachannel`）：
  offer/answer、文本/二进制 data channel 回显、5 次 RTT、`/api/info`、CORS、
  query/header token、disabled/busy/too-large/invalid/rate-limit 错误、
  `maxLifetimeMs` 自动关闭、**16 并发 peer + 16 data channel 全量回显不崩**、
  `node-datachannel` 加载失败时降级为 `rtc_unavailable`。

### WebRTC 探测脚本（对运行中的 relay）

`test/rtc-probe.mjs` 不依赖测试框架，模拟浏览器对已启动的 relay 做 offer/answer +
data channel RTT 测量，并可选并发开 N 个 peer：

```bash
cd relay
npm run test:rtc -- --relay http://127.0.0.1:8390 --count 5 --concurrency 16
```

成功输出示例：

```
relay : http://127.0.0.1:8390
info  : name="DDNet Relay" region="eu-west" protocol=ws-udp-datagram/1 rtc=true
RTT ms: 0.51, 0.31, 0.28, 0.34, 0.31
RTT avg: 0.35 ms
concurrency: 16 peers + data channels echo OK
health: status=ok activeConnections=0 rtc=true
PASS
```

### 真实 DDNet 服务器端到端

需要 Docker（或本机可运行官方 DDNet-Server 二进制）。脚本会在 127.0.0.1:8313
启动官方 DDNet 20.2.1 服务器（UDP 8313 映射到宿主）：

```bash
cd /root/test/relay
bash test/start-ddnet-server.sh                 # 终端 B：首次下载官方包到 relay/.cache/，之后直接复用
npm start -- --config relay.config.json         # 终端 A：中继 127.0.0.1:8390
npm run test:e2e                                # 终端 C：ws -> relay -> UDP -> 真实服务器
```

当前工作区已缓存并启动：relay 在 `127.0.0.1:8390`，DDNet 在 `127.0.0.1:8313/udp`
（容器 `ddnet-e2e`）。重启见"当前联调环境"。

`test/e2e-ddnet.mjs` 模拟浏览器客户端：通过 ws 连接 relay，发送 DDNet 0.6 的
connless info 请求（`10×0xff + "gie3" + token`，15 字节），打印真实服务器的 `inf3`
响应（版本、服务器名、地图、字节数）。成功输出示例：

```
[0.019s] WebSocket : open
[0.020s] sent      : 15 bytes DDNet 0.6 info request (10x 0xff + "gie3" + token)
[0.021s] received  : 107 bytes
[0.021s] tag       : inf3
[0.021s] version   : 0.6, 20.2.1 176fc2f9ab85ace703c
[0.021s] server    : WS Relay E2E [0/128]
[0.021s] map       : Tutorial
[0.021s] stats     : packetsToTarget=1 packetsFromTarget=1 bytesToTarget=15 bytesFromTarget=107
[0.025s] PASS      : relay -> UDP -> real DDNet server round trip verified
```

脚本参数：`--relay ws://127.0.0.1:8390`、`--target 127.0.0.1:8313`、`--token`、
`--timeout 5000`、`--verbose`、`--handshake`。如果 8313 被占用可设置 `DDNET_PORT`
并同步修改 `relay.config.json` 的 servers/allowlist。

加 `--handshake` 会额外跑一遍完整 0.6 连接握手（用同一条 WS/UDP 会话）：

```bash
npm run test:e2e:handshake
```

输出会多出：

```
handshake : -> CONNECT (TKEN + unknown token)
handshake : <- CONNECTACCEPT, securityToken=0x5afd0334
handshake : -> ACCEPT (with security token)
handshake : -> NETMSG_INFO 33 bytes (vital chunk, net version 0.6)
handshake : <- server data packet 143 bytes, 4 chunks
handshake : server accepted the connection and started sending map/game data
PASS      : full DDNet 0.6 handshake verified (CONNECT/CONNECTACCEPT/ACCEPT/NETMSG_INFO, map data received)
```

这证明中继不仅转发单发 connless info，也能透明承载带 security token、多包往返、
服务器开始下发地图数据的有状态 0.6 连接（即浏览器 wasm 客户端连接流程的网络层）。

没有 Docker 时也可以直接运行官方二进制：

```bash
tar -xJf DDNet-20.2.1-linux_x86_64.tar.xz
./DDNet-20.2.1-linux_x86_64/DDNet-Server "sv_port 8313" "sv_register 0" "sv_name WS Relay E2E"
```

## 安全建议

1. **必须 TLS**：浏览器页面通常是 HTTPS，混合内容会阻止 `ws://`；用 Caddy/Nginx
   终止 TLS，对外只暴露 `wss://`。
2. **配置 token**：公网中继不配 token = 任何人可借你的服务器向任意公网 UDP 目标发包
   （UDP 反射/滥用风险）。`RELAY_TOKENS` 支持多 token 轮换；token 用常量时间比较。
   浏览器 WebSocket 只能把 token 放 query，注意反代访问日志可能记录 URL，建议：
   关闭 query 日志、使用短有效期 token、或由网关做额外鉴权。
3. **Origin 白名单**：配置前端站点 Origin，防止任意网页借用用户浏览器连接你的中继。
   非浏览器客户端没有 Origin，可保留 `allowNoOrigin: true` 给 CLI/服务端使用。
4. **保持 `ALLOW_PRIVATE=false`**：默认拒绝 loopback/私网/链路本地/多播/保留段，
   防止 SSRF 打内网服务（如云元数据 169.254.169.254）。确实需要连局域网服务器时，
   用 `allowlist` 精确放行单个 host/IP/CIDR，而不是全局 `ALLOW_PRIVATE`。
5. **DNS rebinding**：中继只解析一次域名，校验所有 A/AAAA 应答后把 IP 直接传给
   connected dgram socket；之后不再按域名解析。
6. **限流与容量**：按业务调低 `maxPacketsPerSecond` / `maxBytesPerSecond` /
   `maxConnectionsPerIp` / `maxConnectionsTotal`；每个连接一个 UDP socket，受
   文件描述符和临时端口限制，1000 并发约需 1000 个 fd，记得抬高 `ulimit -n`。
7. **API 暴露面**：`/api/stats` 会暴露目标分布，公网部署可设 `statsEnabled: false`
   或在反代层限制；`corsOrigins` 建议收紧。
8. **反代后面才开 `trustProxy`**：否则 X-Forwarded-For 可伪造，绕过每 IP 限流。
9. **监控告警**：关注 `authFailures`、`targetRejections`、`droppedFrames`、
   `activeConnections`、进程 fd/内存；异常增长通常意味着扫描或滥用。
10. **WebRTC 资源控制**：`rtc.maxPeers`（默认 16）、`rtc.maxLifetimeMs`（60s）、
    `rtc.maxOfferBytes`（256KB）和单 IP offer 限流共同限制 libdatachannel 的
    内存/CPU/UDP 端口消耗；公网建议保持较小 `maxPeers`，并按前端数量调
    `maxOffersPerIpPerMinute`。**不提供 TURN**，不要把它当通用代理。

## 部署

### Caddy 反代（推荐，自动 HTTPS + WebSocket）

```caddyfile
relay.example.com {
    encode zstd gzip

    # 中继的 WS/HTTP 全部走同一个后端端口
    reverse_proxy 127.0.0.1:8390

    # 可选：只允许前端站点跨域调用 API
    # @api path /api/*
    # header @api Access-Control-Allow-Origin https://ddnet.example.com

    # 可选：限制单 IP 连接数/速率（Caddy 需相应插件），或在前置 LB/WAF 做
}
```

Caddy 自动处理 WebSocket Upgrade 和 `ws` ↔ `wss`，无需额外配置；客户端使用
`wss://relay.example.com/udp/host:port` 即可。若前面还有 CDN/WAF，确认其允许
WebSocket 且空闲超时 > 中继 `pingIntervalMs`。

`POST /rtc/offer` 是普通 HTTPS 请求（不是 WebSocket），同样经 `reverse_proxy` 转发；
WebRTC 的 ICE 数据通道是浏览器与中继之间的 UDP，不经过 Caddy。中继需要公网可达的
IP（host candidate）或配置 STUN，详见"部署注意事项（WebRTC）"。

### systemd

```ini
# /etc/systemd/system/ddnet-relay.service
[Unit]
Description=DDNet WSS-to-UDP relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ddnet-relay
WorkingDirectory=/opt/ddnet-relay
Environment=NODE_ENV=production
Environment=RELAY_CONFIG=/etc/ddnet-relay/config.json
Environment=RELAY_TOKENS=change-me
Environment=ALLOW_PRIVATE=false
ExecStart=/usr/bin/node bin/relay.mjs
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

### Docker（可选）

```dockerfile
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY bin ./bin
COPY relay.config.json ./
EXPOSE 8390
USER node
CMD ["node", "bin/relay.mjs"]
```

```yaml
# docker-compose.yml
services:
  relay:
    build: ./relay
    environment:
      RELAY_HOST: 0.0.0.0
      RELAY_PORT: 8390
      RELAY_TOKENS: change-me
      RELAY_ORIGINS: https://ddnet.example.com
      ALLOW_PRIVATE: "false"
      RELAY_API_CORS: https://ddnet.example.com
    expose: ["8390"]
    restart: unless-stopped
    ulimits:
      nofile: 65536
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on: [relay]
volumes:
  caddy_data:
```

容器内必须监听 `0.0.0.0`（`RELAY_HOST=0.0.0.0`），且不要把 8390 直接发布到公网。
镜像会通过 `npm ci` 自动安装 `node-datachannel` 预编译二进制；WebRTC 需要中继有
公网可达的 UDP candidate，Docker 默认 bridge 网络下建议使用 `network_mode: host`
或给 relay 配置 STUN（`RTC_ICE_SERVERS=stun:...`），否则浏览器可能连不上 data channel。

### 与 DDNet WASM 客户端集成

wasm 侧的 WebSocket 传输只需做三件事：

1. 把 `wss://...` 目标注册为一条虚拟连接（DDNet 的 `NETTYPE_WEBSOCKET_IPV4` 已预留）；
2. 发送时每个 UDP datagram 调用一次 `ws.send(ArrayBuffer)`；
3. 接收时 `binaryType='arraybuffer'`，把每个 `message` 当作一个 datagram 入队。

中继不理解 DDNet 协议，客户端仍需真实服务器地址：`wss://relay/udp/ger1.ddnet.org:8303`。

## 目录结构

```
relay/
├── bin/relay.mjs           # CLI 入口（--config/--token/--allow-private/...）
├── src/
│   ├── server.mjs          # HTTP + WS 升级、鉴权、SSRF、连接管理、API、优雅关闭
│   ├── relay-session.mjs   # 单个 WS ↔ UDP socket 的数据面、限流/帧大小/空闲/背压
│   ├── ssrf.mjs            # IP 分类、CIDR/host 白名单、DNS 解析与钉 IP
│   ├── url.mjs             # 目标/ token / Origin 解析
│   ├── auth.mjs            # 常量时间 token 比较、Origin 白名单
│   ├── ratelimit.mjs       # 令牌桶、每 IP 计数、帧上限
│   ├── config.mjs          # 默认配置、文件/env/CLI 合并与校验
│   ├── stats.mjs           # 聚合统计
│   ├── log.mjs             # JSON 结构化日志
│   └── errors.mjs          # 错误码
├── test/                   # *.test.mjs（node --test）+ e2e-ddnet.mjs + start-ddnet-server.sh
├── relay.config.json       # 本地开发配置
└── README.md
```

## 已知限制 / 后续可优化

- 每个连接一个 UDP socket：极高并发时临时端口/fd 压力大，后续可按目标做 socket 池
  或使用 `SO_REUSEPORT` 多 worker（当前默认上限 1000，足够单机小规模）。
- 不做 TLS 终止（交给 Caddy/Nginx），不实现 HTTP/2/3；WebSocket over HTTP/1.1 足够。
- 不解析 DDNet 协议，因此无法做游戏层过滤（例如按服务器地址白名单以外的高级策略）；
  如需更严格管控，可在 `security.allowlist`/网关层限制目标。
- WebRTC 只支持 host/srflx candidate，**不提供 TURN**；对称 NAT/严格防火墙下
  延迟探测可能失败（浏览器会拿到不到中继的 candidate）。需要覆盖所有网络时，
  应在中继前部署 TURN（本服务不实现）。
- 文本控制帧未实现（数据面只用二进制帧）；如前端需要 hello/ping 可在后续版本加，
  注意不要影响 wasm 客户端的二进制处理。
- 未内置 Prometheus /metrics；可用 `/api/stats` 轮询或后续加 exporter。
