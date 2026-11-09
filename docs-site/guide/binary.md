# 使用二进制文件

## 下载

从 GitHub Release 下载 linux/amd64 产物：

```text
relay-linux-amd64
relay-master-linux-amd64
ddnet-web-dist.tar.gz
```

给可执行权限：

```bash
chmod +x relay-linux-amd64 relay-master-linux-amd64
```

## 直接运行

relay：

```bash
RELAY_HOST=0.0.0.0 \
RELAY_PORT=8390 \
RELAY_TOKENS='replace-with-a-strong-token' \
RELAY_ORIGINS='https://play.example.com' \
RELAY_ALLOW_NO_ORIGIN=false \
RTC_UDP_PORT=443 \
RTC_PUBLIC_IP='203.0.113.10' \
RELAY_MASTER_DOMAIN='https://master.landmine.top' \
RELAY_MASTER_ADVERTISE_URL='wss://play.example.com' \
./relay-linux-amd64
```

master：

```bash
MASTER_HOST=0.0.0.0 \
MASTER_PORT=8391 \
MASTER_CORS_ORIGINS='https://play.example.com' \
./relay-master-linux-amd64
```

> 不设置 `RELAY_TOKENS` 时 relay 才会注册到 master。

## systemd 示例

`/etc/systemd/system/ddnet-relay.service`：

```ini
[Unit]
Description=DDNet Web Relay
After=network-online.target
Wants=network-online.target

[Service]
User=ddnet
Group=ddnet
WorkingDirectory=/opt/ddnet-web
EnvironmentFile=/etc/ddnet-web/relay.env
ExecStart=/opt/ddnet-web/relay-linux-amd64
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/ddnet-relay-master.service`：

```ini
[Unit]
Description=DDNet Web Relay Master
After=network-online.target
Wants=network-online.target

[Service]
User=ddnet
Group=ddnet
WorkingDirectory=/opt/ddnet-web
EnvironmentFile=/etc/ddnet-web/master.env
ExecStart=/opt/ddnet-web/relay-master-linux-amd64
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ddnet-relay ddnet-relay-master
sudo systemctl status ddnet-relay --no-pager
```

## 端口与防火墙

```text
TCP 8390  relay HTTP/WS（本机/内网，nginx 反代）
TCP 8391  master HTTP（本机/内网，nginx 反代）
UDP 443   relay WebRTC ICE
TCP 443   nginx HTTPS/WSS
```

如果不用 nginx，可以直接把 relay 暴露成 `ws://host:8390`，但生产 HTTPS 页面必须使用 `wss://`。

## TLS / nginx

TLS 由 nginx 终止；relay 自身只讲明文 HTTP/WS。参考：

- [deploy/nginx.conf](https://github.com/LandmineHQ/ddnet-web/blob/master/deploy/nginx.conf)
- [deploy/README.md](https://github.com/LandmineHQ/ddnet-web/blob/master/deploy/README.md)

## 更新二进制

```bash
sudo systemctl stop ddnet-relay ddnet-relay-master
# 替换 /opt/ddnet-web/relay-linux-amd64 与 relay-master-linux-amd64
sudo systemctl start ddnet-relay ddnet-relay-master
curl http://127.0.0.1:8390/healthz
curl http://127.0.0.1:8391/healthz
```
