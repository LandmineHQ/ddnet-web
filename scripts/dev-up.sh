#!/usr/bin/env bash
# 一键起本地演示环境（全部服务通过 docker compose 管理，项目名 ddnet-web-dev）
#
#   relay        ws://0.0.0.0:8390        Go 中继 + UDP 转发 + WebRTC + /api/*（compose.dev.yml）
#   relay-master http://0.0.0.0:8391      relay 节点注册中心：/v1/register、/v1/serverlist
#   web-http     http://0.0.0.0:8392      站点（本机访问用 localhost 即安全上下文）
#   web-https    https://0.0.0.0:8443     站点 + /api/* + wss 反代（局域网访问只需这一个端口）
#
# 不再启动本地 DDNet 服务器：中继 /api/servers 直接给出 DDNet 官方 Tutorial 服务器，
# 进游戏时通过中继 UDP 连到官方服务器。
#
#   ./scripts/dev-up.sh      启动 / 修复（docker compose up -d --build + 等待健康检查）
#   ./scripts/dev-down.sh    停止（docker compose down）
#
# 也可以直接用 compose：
#   docker compose -f compose.dev.yml up -d --build
#   docker compose -f compose.dev.yml ps / logs -f relay / down
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f compose.dev.yml)
WAIT_SECS="${DEV_UP_WAIT:-180}"

# 0) 兼容旧版 docker run / 旧 compose 服务：同名容器会占端口，发现就清理（只清理本项目旧容器名）
for name in ddnet-relay-dev ddnet-e2e ddnet-web-http ddnet-web-https ddnet-wss ddnet-web-dev-server; do
	if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
		echo "   清理旧版容器 $name（现在由 compose 管理，且不再需要本地游戏服务器）"
		docker rm -f "$name" >/dev/null 2>&1 || true
	fi
done

# 1) 自签证书（tests/tls 缺失时生成；compose 里 web-https 只读挂载该目录）
if [ ! -s "$ROOT/tests/tls/cert.pem" ] || [ ! -s "$ROOT/tests/tls/key.pem" ]; then
	mkdir -p "$ROOT/tests/tls"
	openssl req -x509 -newkey rsa:2048 -nodes -keyout "$ROOT/tests/tls/key.pem" \
		-out "$ROOT/tests/tls/cert.pem" -days 365 -subj '/CN=localhost' \
		-addext "subjectAltName=DNS:localhost,IP:127.0.0.1,$(hostname -I | awk '{print $1}')" >/dev/null 2>&1
	echo "   已生成自签证书 tests/tls/"
fi

# 2) 启动（build relay-go 镜像 + 全部服务）
echo "== docker compose -f compose.dev.yml config -q（先校验配置）"
"${COMPOSE[@]}" config -q
echo "== docker compose -f compose.dev.yml up -d --build"
"${COMPOSE[@]}" up -d --build

# 3) 等待健康检查（最多 DEV_UP_WAIT 秒）
echo "== 等待容器健康检查"
deadline=$((SECONDS + WAIT_SECS))
while :; do
	statuses=""
	all_ok=1
	for id in $("${COMPOSE[@]}" ps -aq); do
		name="$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')"
		st="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$id" 2>/dev/null || echo missing)"
		statuses+="$name=$st "
		case "$st" in
			healthy|running) ;;
			*) all_ok=0 ;;
		esac
	done
	[ -n "$statuses" ] || statuses="(还没有容器)"
	if [ "$all_ok" = "1" ]; then
		echo "   $statuses"
		break
	fi
	if [ "$SECONDS" -ge "$deadline" ]; then
		echo "   超时（${WAIT_SECS}s）：$statuses" >&2
		"${COMPOSE[@]}" ps >&2 || true
		"${COMPOSE[@]}" logs --tail 80 relay relay-master web-http web-https >&2 || true
		exit 1
	fi
	sleep 2
done

# 4) 状态摘要
IP="$(hostname -I | awk '{print $1}')"
TUTORIAL="74.91.126.203:8300"
echo
echo "==================== 状态 ===================="
"${COMPOSE[@]}" ps
echo
curl -s --max-time 3 http://127.0.0.1:8390/api/info | head -c 180; echo
curl -s --max-time 3 http://127.0.0.1:8390/api/servers | head -c 240; echo
curl -s -o /dev/null -w 'http  站点  http://127.0.0.1:8392/   -> %{http_code}\n' --max-time 3 http://127.0.0.1:8392/
curl -sk -o /dev/null -w 'https 站点  https://127.0.0.1:8443/  -> %{http_code}\n' --max-time 3 https://127.0.0.1:8443/
curl -sk -o /dev/null -w 'https API   /api/info            -> %{http_code}\n' --max-time 3 https://127.0.0.1:8443/api/info
curl -s --max-time 3 http://127.0.0.1:8391/v1/serverlist | head -c 240; echo
echo
echo "本机浏览器：   http://localhost:8392/"
echo "局域网/远端：  https://$IP:8443/   （自签证书，点继续前往；中继会自动出现\"同源中继\"）"
echo "relay master：  http://127.0.0.1:8391/v1/serverlist（relay 默认注册到这里）"
echo "游戏服务器：   DDNet 官方 Tutorial（/api/servers 列出 USA1/USA4/GER/Singapore）"
echo "一键直达：     https://$IP:8443/?connect=wss%3A%2F%2F$IP%3A8443%2Fudp%2F${TUTORIAL//:/%3A}&autostart=1"
echo "停止：         ./scripts/dev-down.sh"
echo "============================================="
