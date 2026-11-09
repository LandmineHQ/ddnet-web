# Relay Master API

master 维护 relay 节点列表。默认域名：

```text
https://master.landmine.top
```

同源部署也可以走 nginx 的 `/relay-master/`。

## POST /v1/register

注册体的 `transports` 是**数组**，每项声明一种连接方式和自己的参数：

```json
{
  "name": "DDNet Relay",
  "region": "EU",
  "version": "1.0.0",
  "players": 0,
  "transports": [
    {
      "type": "websocket",
      "url": "wss://play.example.com"
    },
    {
      "type": "webrtc",
      "signalUrl": "https://play.example.com/rtc/offer",
      "host": "play.example.com",
      "udpPort": 443,
      "origin": "https://play.example.com"
    }
  ]
}
```

### transport 字段

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `type` | 全部 | `websocket` 或 `webrtc` |
| `url` | `websocket` | relay 的 `ws://` / `wss://` base |
| `signalUrl` | `webrtc` | `/rtc/offer` 信令地址，`http(s)://` |
| `host` | `webrtc` | 浏览器 ICE 使用的域名/IP |
| `udpPort` | `webrtc` | 固定共享 ICE UDP 端口，不能为 0 |
| `origin` | `webrtc` | 可选；master 探测时发送的 Origin |

至少一项；可以只注册 `webrtc`，也可以只注册 `websocket`，或两者都注册。

> 这是 break change：旧的顶层 `url`、`transports: ["websocket","webrtc"]` 和 `webrtc:{...}` 不再接受。

## 验证规则

master 对数组中的每一项独立探测：

### WebSocket

```text
<url>/ws
```

执行 RFC 6455 握手；失败则该项不进入列表。

### WebRTC

master 使用 pion 创建真实 DataChannel，向 `signalUrl` POST offer，设置 answer，等待 DataChannel/peer 连接成功。失败则该项不进入列表。

- 至少一项成功：节点进入 `/v1/serverlist`
- 部分成功：只返回成功的 transport
- 全部失败：HTTP `502`，节点不注册

之后每 30 秒心跳；已验证且未变化的 transport 不重复探测。每 15 分钟逐项复检，某项失败只移除该项，全部失败移除节点。

成功响应示例：

```json
{
  "ok": true,
  "key": "websocket:wss://play.example.com",
  "transports": [
    { "type": "websocket", "url": "wss://play.example.com" }
  ],
  "verified": true,
  "probed": true,
  "probeMs": 12,
  "intervalMs": 30000,
  "healthCheckMs": 900000,
  "count": 1
}
```

## POST /v1/unregister

使用与注册相同的 transports 数组定位节点：

```json
{
  "transports": [
    { "type": "websocket", "url": "wss://play.example.com" }
  ]
}
```

relay 退出时会尽力调用。

## GET /v1/serverlist

只返回至少有一项已验证且 healthy 的节点；`transports` 只包含验证成功的项：

```json
{
  "count": 1,
  "generatedAt": "2026-11-09T00:00:00Z",
  "servers": [
    {
      "name": "DDNet Relay",
      "region": "EU",
      "version": "1.0.0",
      "transports": [
        {
          "type": "webrtc",
          "signalUrl": "https://play.example.com/rtc/offer",
          "host": "play.example.com",
          "udpPort": 443
        }
      ],
      "healthy": true
    }
  ]
}
```

WebRTC-only 节点没有顶层 `url`；前端会根据 `signalUrl` 推导连接 base。

默认 CORS 为 `*`，可用 `MASTER_CORS_ORIGINS` 限制。

## 其他端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | master 健康检查 |
| `GET` | `/api/stats` | 节点数、探测配置 |
| `POST` | `/v1/register` | 注册 / 心跳 |
| `POST` | `/v1/unregister` | 移除节点 |
| `GET` | `/v1/serverlist` | 节点列表 |

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MASTER_HOST` / `MASTER_PORT` | `0.0.0.0` / `8391` | HTTP 监听 |
| `MASTER_PROBE_INTERVAL_MS` | `900000` | 存活检查间隔（15 分钟） |
| `MASTER_PROBE_TIMEOUT_MS` | `5000` | 单项 transport 探测超时 |
| `MASTER_REGISTER_PER_MINUTE` | `30` | 单 IP 注册频率限制 |
| `MASTER_MAX_NODES` | `1000` | 最大节点数 |
| `MASTER_CORS_ORIGINS` | `*` | `/v1/serverlist` CORS |

注册表是内存态：master 重启后依赖 relay 心跳重新注册。
