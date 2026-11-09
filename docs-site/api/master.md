# Relay Master API

master 维护 relay 节点列表。默认域名：

```text
https://master.landmine.top
```

同源部署也可以走 nginx 的 `/relay-master/`。

## POST /v1/register

relay 注册并声明自己的传输能力：

```json
{
  "name": "DDNet Relay",
  "url": "wss://play.example.com",
  "region": "EU",
  "version": "1.0.0",
  "players": 0,
  "transports": ["websocket", "webrtc"],
  "webrtc": {
    "enabled": true,
    "host": "play.example.com",
    "signalUrl": "https://play.example.com/rtc/offer",
    "udpPort": 443
  }
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | relay 的 `ws://` / `wss://` base |
| `name` | 建议 | 展示名称 |
| `region` | 否 | 地区标记 |
| `version` | 否 | relay 版本 |
| `players` | 否 | 当前玩家数，默认 0 |
| `transports` | 建议 | `websocket` / `webrtc` |
| `webrtc.enabled` | 否 | 是否启用 WebRTC |
| `webrtc.host` | WebRTC 启用时必填 | UDP 入口域名/IP |
| `webrtc.signalUrl` | WebRTC 启用时必填 | HTTP(S) `/rtc/offer` 地址 |
| `webrtc.udpPort` | WebRTC 启用时必填 | 固定共享 ICE UDP 端口，不能为 0 |

成功响应：

```json
{
  "ok": true,
  "url": "wss://play.example.com",
  "verified": true,
  "probed": true,
  "probeMs": 12,
  "intervalMs": 30000,
  "healthCheckMs": 900000,
  "count": 1
}
```

### 首次注册验证

master 会主动连接：

```text
<relay.url>/ws
```

使用 RFC 6455 握手：

- 成功：节点进入列表
- 失败：返回 `502`，节点不注册

之后 relay 每 30 秒心跳；已验证节点心跳不会重复探测。master 每 15 分钟复检所有节点，失败即移除。

## POST /v1/unregister

```json
{ "url": "wss://play.example.com" }
```

relay 退出时会尽力调用；也可以手动清理节点。

## GET /v1/serverlist

只返回已验证且 healthy 的节点：

```json
{
  "count": 1,
  "generatedAt": "2026-11-09T00:00:00Z",
  "servers": [
    {
      "name": "DDNet Relay",
      "url": "wss://play.example.com",
      "region": "EU",
      "version": "1.0.0",
      "players": 0,
      "transports": ["websocket", "webrtc"],
      "webrtc": {
        "enabled": true,
        "host": "play.example.com",
        "signalUrl": "https://play.example.com/rtc/offer",
        "udpPort": 443
      },
      "healthy": true
    }
  ]
}
```

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
| `MASTER_PROBE_TIMEOUT_MS` | `5000` | 单节点 WS 探测超时 |
| `MASTER_REGISTER_PER_MINUTE` | `30` | 单 IP 注册频率限制 |
| `MASTER_MAX_NODES` | `1000` | 最大节点数 |
| `MASTER_CORS_ORIGINS` | `*` | `/v1/serverlist` CORS |

注册表是内存态：master 重启后依赖 relay 心跳重新注册。
