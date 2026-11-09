#!/bin/bash
# Build the VitePress wiki into dist/web/wiki (or DIST/wiki).
set -euo pipefail

DEFAULT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${ROOT:-$DEFAULT_ROOT}"
DIST="${DIST:-$ROOT/dist/web}"
DOCS="$ROOT/docs-site"
BASE="${VITEPRESS_BASE:-/wiki/}"

case "$BASE" in
	/*) ;;
	*) BASE="/$BASE" ;;
esac
[[ "$BASE" == */ ]] || BASE="$BASE/"

if [ ! -x "$DOCS/node_modules/.bin/vitepress" ]; then
	echo "== installing wiki dependencies"
	npm ci --prefix "$DOCS"
fi

echo "== building wiki (base=$BASE)"
VITEPRESS_BASE="$BASE" npm run docs:build --prefix "$DOCS"

rm -rf "${DIST:?}/wiki"
mkdir -p "$DIST/wiki"
cp -a "$DOCS/.vitepress/dist/." "$DIST/wiki/"
echo "== wiki -> $DIST/wiki"
du -sh "$DIST/wiki"
