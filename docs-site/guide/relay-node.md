# 搭建 relay 节点

relay 是浏览器和原版 DDNet 服务器之间的桥：

```text
浏览器 ── WebRTC DataChannel / WebSocket ──> relay ── UDP ──> DDNet 服务器
```

relay 只监听明文 HTTP/WS；生产环境的 HTTPS/WSS 由 nginx 终止。

## 要求

- Linux `amd64`（Alpine 兼容）
- 能出站访问目标 DDNet 服务器的 UDP 端口
- 防火墙放行 relay 的 HTTP/WS 端口，以及 WebRTC 的固定 UDP 端口
- 生产环境需要一个域名和 nginx 证书

## 方式一：Docker Compose（推荐）

参见 [使用 Docker Compose](/guide/compose)。生产 compose 直接拉取 GHCR 镜像：

```text
ghcr.io/landminehq/ddnet-web-relay:latest
ghcr.io/landminehq/ddnet-web-master:latest
```

## 方式二：二进制

参见 [使用二进制文件](/guide/binary)。

## 从源码构建

```bash
cd relay-go

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -mod=vendor -trimpath -ldflags="-s -w" \
  -o relay ./cmd/relay

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -mod=vendor -trimpath -ldflags="-s -w" \
  -o relay-master ./cmd/master
```

两个产物都是静态二进制，可直接复制到 Alpine 容器。

## 启动 relay

最小启动：

```bash
RELAY_HOST=0.0.0.0 \
RELAY_PORT=8390 \
RELAY_ALLOW_NO_ORIGIN=true \
./relay
```

生产环境应配置 token、Origin 和公网广告地址：

```bash
RELAY_HOST=0.0.0.0 \
RELAY_PORT=8390 \
RELAY_TOKENS='replace-with-a-strong-token' \
RELAY_ORIGINS='https://play.example.com' \
RELAY_ALLOW_NO_ORIGIN=false \
ALLOW_PRIVATE=false \
RTC_ENABLED=true \
RTC_UDP_PORT=443 \
RTC_PUBLIC_IP='203.0.113.10' \
RELAY_MASTER_DOMAIN='https://master.landmine.top' \
RELAY_MASTER_ADVERTISE_URL='wss://play.example.com' \
./relay
```

## 常用配置

| 变量 | 说明 |
| --- | --- |
| `RELAY_HOST` / `RELAY_PORT` | HTTP/WS 监听，默认容器内 `0.0.0.0:8390` |
| `RELAY_TOKENS` | 客户端 token 列表；**设置后 relay 不注册到 master** |
| `RELAY_ORIGINS` | 允许的浏览器 Origin，生产必填 |
| `RELAY_ALLOW_NO_ORIGIN` | 是否允许无 Origin 的客户端；生产建议 `false` |
| `ALLOW_PRIVATE` | 是否允许 relay 连接私网 UDP 目标，默认关闭 |
| `RELAY_ALLOWLIST` | 额外允许的 host/IP/CIDR |
| `RTC_ENABLED` | 是否启用 WebRTC |
| `RTC_UDP_PORT` | 固定共享 ICE UDP 端口；`0` 表示跟随 relay TCP 端口 |
| `RTC_PUBLIC_IP` | NAT/1:1 映射后的公网 IP |
| `RTC_ICE_SERVERS` | 可选 STUN/TURN URL 列表 |
| `RELAY_MASTER_DOMAIN` | master 地址，默认 `https://master.landmine.top` |
| `RELAY_MASTER_ADVERTISE_URL` | 向 master 注册的公网 relay URL |
| `RELAY_MASTER_INTERVAL_MS` | 注册/心跳间隔，默认 `30000` |

## WebRTC 与固定端口

所有 WebRTC peer 共用同一个 `ice.UDPMuxDefault` 固定 UDP 端口，不会按用户分配端口。

开发环境可以让 TCP 和 UDP 都监听 `8390`：

```text
RELAY_PORT=8390
RTC_UDP_PORT=8390
```

生产环境通常让 nginx 占 TCP `443`，relay 占 UDP `443`：

```text
RELAY_PORT=8390
RTC_UDP_PORT=443
```

公网防火墙需要同时放行 TCP 443 和 UDP 443。NAT 后设置 `RTC_PUBLIC_IP`。

## 注册到 master

默认会注册到：

```text
https://master.landmine.top/v1/register
```

master 会在首次注册时主动访问：

```text
<relay公网URL>/ws
```

握手成功后节点才进入 `/v1/serverlist`。之后每 15 分钟复检，失败节点移除。

如果 relay 设置了 `RELAY_TOKENS`，按约定它不会注册到公共 master；同时会尝试移除之前注册过的同 URL 节点。

## 健康检查

```bash
curl http://127.0.0.1:8390/healthz
curl http://127.0.0.1:8391/healthz
```

## 反向代理

Go relay 不做 TLS。生产使用 [deploy/nginx.conf](https://github.com/LandmineHQ/ddnet-web/blob/master/deploy/nginx.conf) 或等价配置：

- `/udp/`、`/ws`、`/healthz`、`/api/`、`/rtc/` → relay `127.0.0.1:8390`
- `/relay-master/` → master `127.0.0.1:8391`
- 静态站点 → `dist/web`
- WebRTC UDP → relay 的固定 UDP 端口
