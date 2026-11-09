# Relay API

relay 默认监听 `8390`。生产由 nginx 终止 TLS：

```text
https://play.example.com/...  -> http://127.0.0.1:8390/...
wss://play.example.com/udp/... -> ws://127.0.0.1:8390/udp/...
```

## WebSocket 游戏隧道

```text
wss://relay.example.com/udp/<host>:<port>[?token=<token>&protocol=7&transport=ws]
```

- 每个 WebSocket 二进制帧 = 一个 UDP 数据报
- `protocol=7`（或 `protocol=0.7` / `sevenup=1` / `tw7=1`）使用 DDNet 0.7 sixup
- `?transport=ws` 强制 WebSocket，跳过 WebRTC 尝试
- `token` 是 relay 的访问 token；配置了 `RELAY_TOKENS` 时必填

示例：

```js
const ws = new WebSocket('wss://relay.example.com/udp/74.91.126.203:8300?protocol=7');
ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(new Uint8Array([/* DDNet packet */]));
ws.onmessage = (event) => {
  const packet = new Uint8Array(event.data);
  // 交给 DDNet netcode
};
```

目标地址受 SSRF 策略限制；私网/回环目标默认拒绝，可用 `ALLOW_PRIVATE` / `RELAY_ALLOWLIST` 放行。

## WebRTC 信令

```http
POST /rtc/offer
Content-Type: application/json
```

请求体：

```json
{
  "type": "offer",
  "sdp": "v=0\r\n...m=application...\r\n"
}
```

- 不带 `target`：DataChannel 延迟回显
- 带 `?target=host:port`：把 DataChannel 消息桥接到该 UDP 目标

响应：

```json
{
  "type": "answer",
  "sdp": "v=0\r\n..."
}
```

限制：

- `RTC_ENABLED=false` 时返回 `503`
- SDP 必须包含 `v=0` 和 `m=application`
- offer 大小受 `RTC_MAX_OFFER_BYTES` 限制
- 每个 IP 的 offer 频率受限

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 存活检查 |
| `GET` | `/api/info` | relay 名称、协议、RTC、ICE、连接数 |
| `GET` | `/api/servers` | 推荐服务器列表 |
| `GET` | `/api/stats` | 会话、目标、流量、RTC 统计 |
| `POST` | `/rtc/offer` | WebRTC 信令 |
| `WS` | `/udp/<host>:<port>` | 游戏数据隧道 |
| `WS` | `/ws` | master 健康探测升级端点 |

`/api/info` 示例：

```json
{
  "name": "DDNet Relay",
  "version": "1.0.0",
  "protocol": "ws-udp-datagram/1",
  "region": "EU",
  "rtc": true,
  "iceServers": [],
  "activeConnections": 0,
  "uptimeSec": 120
}
```

## 鉴权 / Origin

- `RELAY_TOKENS` 非空时，WebSocket 和信令请求要求 token
- `RELAY_ORIGINS` 限制浏览器 Origin
- `RELAY_ALLOW_NO_ORIGIN=false` 时拒绝没有 Origin 的客户端
- 反向代理后开启 `RELAY_TRUST_PROXY=true`，否则 X-Forwarded-For 不可信

## 健康端点行为

`/ws` 只接受 WebSocket 升级，升级成功后立即关闭连接。master 使用它验证 relay 可达性；普通客户端不需要调用。
