#!/usr/bin/env bash
# 停止并移除 compose.dev.yml 启动的全部容器（项目 ddnet-web-dev）
#
#   ./scripts/dev-down.sh              # 停止（docker compose down）
#   ./scripts/dev-down.sh -v           # 同时删除匿名卷（compose down -v）
#   ./scripts/dev-down.sh --remove-orphans
#
# 直接等价于：docker compose -f compose.dev.yml down "$@"
# 只影响本项目（ddnet-web-dev），不会动宿主机上其它容器。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== docker compose -f compose.dev.yml down $*"
docker compose -f compose.dev.yml down "$@"

# 兼容旧版 docker run 容器（这些名字是旧 dev-up.sh 创建的）
for name in ddnet-relay-dev ddnet-e2e ddnet-web-http ddnet-web-https ddnet-wss; do
	if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
		docker rm -f "$name" >/dev/null 2>&1 && echo "已停止旧版容器 $name"
	fi
done
echo "（compose 项目 ddnet-web-dev 已停止；tests/tls 证书保留）"
