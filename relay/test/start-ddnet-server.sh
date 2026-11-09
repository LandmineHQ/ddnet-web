#!/usr/bin/env bash
# Start a real DDNet server for the legacy Node relay e2e tests.
#
# Optional local server for the legacy Node relay tests. The default dev stack
# no longer runs a game server (relay /api/servers points at DDNet official
# Tutorial servers). This helper starts the optional compose test profile:
#
#   ./test/start-ddnet-server.sh
#   docker compose -f compose.test.yml --profile local-server up -d ddnet-server-local
#
# The Node relay is legacy (the production backend is the Go relay in ./relay-go),
# but this helper keeps its e2e tests runnable without ad-hoc `docker run`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

if [ -n "${DDNET_PORT:-}" ] && [ "${DDNET_PORT}" != "8313" ]; then
	echo "compose.test.yml publishes the optional DDNet server on 127.0.0.1:8313/udp;" >&2
	echo "DDNET_PORT=${DDNET_PORT} is not supported by the compose service." >&2
	exit 1
fi

if [ ! -x "$ROOT/relay/.cache/DDNet-20.2.1-linux_x86_64/DDNet-Server" ]; then
	echo "missing relay/.cache/DDNet-20.2.1-linux_x86_64/DDNet-Server" >&2
	echo "Download DDNet-20.2.1-linux_x86_64.tar.xz from https://ddnet.tw/downloads/ and extract it there." >&2
	exit 1
fi

echo "Starting optional DDNet server via docker compose (compose.test.yml: ddnet-server-local)"
docker compose -f compose.test.yml --profile local-server up -d ddnet-server-local

for _ in $(seq 1 60); do
	if docker compose -f compose.test.yml logs ddnet-server-local 2>&1 | grep -q "rcon password"; then
		echo "DDNet server ready: 127.0.0.1:8313/udp"
		exit 0
	fi
	sleep 0.5
done

echo "DDNet server failed to become ready; last logs:" >&2
docker compose -f compose.test.yml logs --tail 40 ddnet-server-local >&2
exit 1
