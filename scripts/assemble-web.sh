#!/bin/bash
# 组装可部署站点：DDNet wasm 产物 + 前端 Shell + 资源清单(sha256，供前端本地缓存校验)
#
#   dist/web/DDNet.js, DDNet.wasm, DDNet.data   <- build/build-wasm.sh
#   web/*                                       <- 前端 Shell
#   -> dist/web/  (含 manifest.json)
set -euo pipefail

DEFAULT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${ROOT:-$DEFAULT_ROOT}"
DIST="${DIST:-$ROOT/dist/web}"
WEB="${WEB:-$ROOT/web}"

mkdir -p "$DIST"

echo "== copying frontend shell from $WEB"
for item in index.html style.css app.js src assets serve.mjs README.md; do
	if [ -e "$WEB/$item" ]; then
		rm -rf "${DIST:?}/$item"
		cp -a "$WEB/$item" "$DIST/$item"
		echo "   + $item"
	fi
done

if [ -d "$ROOT/docs-site" ]; then
	if [ -x "$ROOT/docs-site/node_modules/.bin/vitepress" ] || [ "${BUILD_WIKI:-0}" = "1" ]; then
		DIST="$DIST" VITEPRESS_BASE="${VITEPRESS_BASE:-/wiki/}" "$ROOT/scripts/build-wiki.sh"
	else
		echo "   ! wiki skipped (run: npm ci --prefix docs-site)"
	fi
fi

echo "== checking wasm artifacts in $DIST"
missing=0
for f in DDNet.js DDNet.wasm DDNet.data; do
	if [ -s "$DIST/$f" ]; then
		printf '   + %-12s %s\n' "$f" "$(du -h "$DIST/$f" | cut -f1)"
	else
		printf '   ! %-12s MISSING\n' "$f"
		missing=1
	fi
done

# 资源清单：前端据此做 sha256 校验 + Cache Storage 本地缓存。
if [ "$missing" -eq 0 ]; then
	VERSION="$({ sha256sum "$DIST/DDNet.wasm"; } | cut -c1-16)"
	{
		printf '{\n  "version": "%s",\n  "files": {\n' "$VERSION"
		first=1
		for f in DDNet.js DDNet.wasm DDNet.data; do
			sum=$(sha256sum "$DIST/$f" | cut -d' ' -f1)
			size=$(stat -c%s "$DIST/$f")
			[ "$first" -eq 1 ] || printf ',\n'
			first=0
			printf '    "%s": { "sha256": "%s", "size": %s }' "$f" "$sum" "$size"
		done
		printf '\n  }\n}\n'
	} > "$DIST/manifest.json"
	echo "   + manifest.json (version $VERSION)"
else
	echo "   ! manifest.json skipped (artifacts missing)"
fi

# 静态托管平台的响应头配置（Netlify/Cloudflare Pages 风格）
cat > "$DIST/_headers" <<'EOF'
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin

/DDNet.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

/DDNet.js
  Content-Type: text/javascript
  Cache-Control: public, max-age=31536000, immutable

/DDNet.data
  Content-Type: application/octet-stream
  Cache-Control: public, max-age=31536000, immutable

/manifest.json
  Cache-Control: no-cache
EOF
echo "   + _headers"

echo "== done: $DIST"
du -sh "$DIST"
