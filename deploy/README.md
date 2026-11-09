# 生产部署：nginx + relay + relay master

本仓库的生产 compose **不包含 Caddy**，也不在应用里做 TLS 终止：

- relay 只监听 `127.0.0.1:8390` 的 HTTP/WS（与 dev 默认端口一致）
- relay master 只监听 `127.0.0.1:8391` 的 HTTP（与 dev 默认端口一致）
- WebRTC ICE 固定 `443/udp`（与 nginx 的 TCP 443 同号不同协议）
- 静态站点由 nginx 直接 root 到 `dist/web`
- HTTPS/WSS 证书、HTTP/2、限流/WAF 全部由生产 nginx 负责

## 1. 启动 compose

```bash
RELAY_DOMAIN=play.example.com \
RELAY_PUBLIC_URL=wss://play.example.com \
MASTER_DOMAIN=master.landmine.top \
RELAY_ORIGINS=https://play.example.com \
RELAY_TOKENS='<relay-token>' \
RTC_PUBLIC_IP=<公网IP> \
docker compose -f compose.yml pull && docker compose -f compose.yml up -d
```

- `RELAY_ORIGINS` 必须包含站点 Origin；nginx 会透传浏览器 `Origin`
- `RELAY_TOKENS` 设置后 relay **不会注册到 master**；若希望出现在 master 节点列表，请留空并依赖其它访问控制
- relay 的 `RELAY_MASTER_ADVERTISE_URL` 必须是公网 `wss://` 地址
- 防火墙放行 **TCP 443**（nginx）和 **UDP 443**（relay WebRTC）
- NAT 后设置 `RTC_PUBLIC_IP`，或用 `RTC_ICE_SERVERS` 配 STUN/TURN

## 2. 安装 nginx 配置

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/ddnet-web.conf
sudo nginx -t && sudo systemctl reload nginx
```

按实际情况修改：

- `play.example.com` / `master.landmine.top`
- Let's Encrypt 证书路径
- `root /srv/ddnet-web;` 指向 `dist/web`
- nginx 与 Docker 的 `127.0.0.1:8390/8391` 在同一台机器；如果是远程 nginx，把 compose 的 `127.0.0.1:` 绑定改成内网地址或走私网

## 3. 验证

```bash
curl -I https://play.example.com/                    # 静态站点 + COOP/COEP
curl https://play.example.com/relay-master/v1/serverlist
curl https://master.landmine.top/v1/serverlist
curl -k -i https://play.example.com/healthz          # 仅测试时用 -k
```

浏览器页面和 wss 使用 nginx 的同一张有效证书；自签证书只建议内网测试，且必须让客户端信任证书或在浏览器接受例外。
