# 使用 Docker Compose

## 生产 compose（GHCR）

[compose.yml](https://github.com/LandmineHQ/ddnet-web/blob/master/compose.yml) 只启动 relay 和 relay-master，镜像来自 GHCR：

```text
ghcr.io/landminehq/ddnet-web-relay:latest
ghcr.io/landminehq/ddnet-web-master:latest
```

不再本地构建镜像。先拉取，再启动：

```bash
RELAY_DOMAIN=play.example.com \
RELAY_PUBLIC_URL=wss://play.example.com \
MASTER_DOMAIN=master.landmine.top \
RELAY_ORIGINS=https://play.example.com \
RTC_PUBLIC_IP=203.0.113.10 \
docker compose -f compose.yml pull

docker compose -f compose.yml up -d
```

固定版本：

```bash
RELAY_IMAGE_TAG=v0.1.0 docker compose -f compose.yml pull
RELAY_IMAGE_TAG=v0.1.0 docker compose -f compose.yml up -d
```

## 端口

```text
127.0.0.1:8390   relay HTTP/WS（由 nginx 反代）
127.0.0.1:8391   relay-master HTTP（由 nginx 反代）
0.0.0.0:443/udp  relay WebRTC ICE
```

生产 nginx 占 TCP `443`。relay 和 master 只绑定回环，不直接暴露公网。

## 配置环境变量

| 变量 | 示例 | 说明 |
| --- | --- | --- |
| `RELAY_DOMAIN` | `play.example.com` | relay 对外域名 |
| `RELAY_PUBLIC_URL` | `wss://play.example.com` | 注册到 master 的公网 URL |
| `MASTER_DOMAIN` | `master.landmine.top` | master 域名 |
| `RELAY_ORIGINS` | `https://play.example.com` | 允许的浏览器 Origin |
| `RELAY_TOKENS` | `secret` | 设置后 relay 不注册 master |
| `RTC_PUBLIC_IP` | `203.0.113.10` | NAT 公网 IP |
| `RTC_ICE_SERVERS` | `stun:stun.example.org:3478` | 可选 STUN/TURN |
| `RELAY_IMAGE_TAG` | `latest` / `v0.1.0` | GHCR 镜像 tag |

## nginx 与静态站点

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/ddnet-web.conf
sudo nginx -t
sudo systemctl reload nginx
```

按实际域名、证书和 `dist/web` 路径修改配置。GitHub Pages / Release 的 `web-dist` 也可以解压到 nginx root。

## 验证

```bash
docker compose -f compose.yml ps
docker compose -f compose.yml logs -f relay
curl http://127.0.0.1:8390/healthz
curl http://127.0.0.1:8391/healthz
curl https://play.example.com/relay-master/v1/serverlist
```

## 开发栈

开发/测试使用 [compose.dev.yml](https://github.com/LandmineHQ/ddnet-web/blob/master/compose.dev.yml)：

```bash
./scripts/dev-up.sh
# 或
docker compose -f compose.dev.yml up -d --build
```

开发栈会构建本地 relay/master，并启动 HTTP/HTTPS 站点，适合联调和 E2E。
