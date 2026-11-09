#!/usr/bin/env bash
#
# Verify that the built web client is served correctly.
#
# Starts DDNet own test server (other/emscripten/server.py) on the dist directory
# and checks that the three artifacts are reachable with sensible MIME types and
# that the COOP/COEP headers required for SharedArrayBuffer (pthreads) are sent.
#
#   ./verify-web.sh [PORT] [DIST_DIR]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${1:-${PORT:-8000}}"
DIST_DIR="${2:-${DIST_DIR:-$ROOT/dist/web}}"
SERVER="${SERVER:-$ROOT/ddnet/other/emscripten/server.py}"

[ -d "$DIST_DIR" ] || { echo "no such dist dir: $DIST_DIR" >&2; exit 1; }
[ -f "$SERVER" ]   || { echo "no such server.py: $SERVER" >&2; exit 1; }

echo "== dist contents =="
ls -la "$DIST_DIR"

# server.py serves the CWD, so run it from the dist directory.
LOG="$(mktemp)"
( cd "$DIST_DIR" && exec python3 "$SERVER" "$PORT" ) >"$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

ready=0
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then ready=1; break; fi
  sleep 0.2
done
if [ "$ready" != "1" ]; then
  echo "server did not come up on port $PORT; log:" >&2
  cat "$LOG" >&2
  exit 1
fi

echo
echo "== HTTP checks (http://127.0.0.1:$PORT/) =="
FAIL=0
for f in DDNet.js DDNet.wasm DDNet.data index.html; do
  if [ ! -f "$DIST_DIR/$f" ]; then
    printf "  %-12s MISSING ON DISK\n" "$f"; FAIL=1; continue
  fi
  out=$(curl -s -L -o /dev/null --max-time 120 \
        -w "%{http_code} %{content_type} %{size_download}" \
        "http://127.0.0.1:$PORT/$f" || echo "000 - 0")
  code=${out%% *}; rest=${out#* }
  ctype=${rest%% *}; size=${rest#* }
  printf "  %-12s HTTP %s  %-26s %s bytes\n" "$f" "$code" "$ctype" "$size"
  [ "$code" = "200" ] || FAIL=1
done

echo
echo "== MIME expectations =="
check_mime() {
  local file=$1 want=$2
  local got
  got=$(curl -s -I --max-time 10 "http://127.0.0.1:$PORT/$file" | tr -d "\r" | sed -n "s/^[Cc]ontent-[Tt]ype: //p" | head -1)
  if [ "$got" = "$want" ]; then
    printf "  %-12s %-24s OK\n" "$file" "$got"
  else
    printf "  %-12s %-24s expected %s\n" "$file" "$got" "$want"; FAIL=1
  fi
}
check_mime DDNet.wasm "application/wasm"
check_mime DDNet.js   "text/javascript"

echo
echo "== COOP/COEP headers (required for SharedArrayBuffer/pthreads) =="
HDRS=$(curl -s -I --max-time 10 "http://127.0.0.1:$PORT/DDNet.js" | tr -d "\r")
echo "$HDRS" | grep -i "cross-origin" || { echo "  MISSING COOP/COEP" >&2; FAIL=1; }
echo "$HDRS" | grep -qi "^Cross-Origin-Opener-Policy: same-origin"  || { echo "  COOP not same-origin" >&2; FAIL=1; }
echo "$HDRS" | grep -qi "^Cross-Origin-Embedder-Policy: require-corp" || { echo "  COEP not require-corp" >&2; FAIL=1; }

echo
if [ "$FAIL" = "0" ]; then
  echo "RESULT: OK -- open http://127.0.0.1:$PORT/index.html"
else
  echo "RESULT: FAILED" >&2; exit 1
fi
