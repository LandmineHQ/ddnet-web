#!/usr/bin/env bash
# 在 ddnet-wasm-builder 镜像内执行的 WASM 构建（由 build/compose.yml 的 wasm-build 服务调用）。
#
# 这是 build/build-wasm.sh 内层构建逻辑的 compose 版（同样的镜像、同样的挂载/环境变量），
# 让「全部 Docker 构建/启动」都可以走 compose：
#
#   docker compose -f build/compose.yml run --rm wasm-build
#   BUILD_TYPE=Release docker compose -f build/compose.yml run --rm wasm-build
#
# 宿主侧的 build/build-wasm.sh 仍然可用（它会自己 docker build/run），两者产物一致：
#   /build/DDNet.{js,wasm,data} -> /dist（宿主 dist/web）
#
# 容器内路径约定（与 build/build-wasm.sh 一致）：
#   /src         源码（默认 ddnet-dev，只读）
#   /src/ddnet-libs 预编译库（只读）
#   /build       构建目录（宿主 build/wasm-build，可增量）
#   /cargo       cargo 缓存（宿主 build/cargo-home）
#   /dist        产物目录（宿主 dist/web）
#   /logs        构建日志（宿主 build/logs）
set -euo pipefail

BUILD_TYPE="${BUILD_TYPE:-Debug}"
JOBS="${JOBS:-$(nproc)}"
CCACHE="${CCACHE:-0}"
PACKAGE="${PACKAGE:-1}"
CLEAN="${CLEAN:-0}"
BUILD_DIR="${BUILD_DIR:-/build}"
DIST_DIR="${DIST_DIR:-/dist}"
LOG_DIR="${LOG_DIR:-/logs}"

log() { printf '\033[1;34m[compose-wasm]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[compose-wasm]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[compose-wasm]\033[0m %s\n' "$*" >&2; exit 1; }

if [ -f /emsdk/emsdk_env.sh ]; then
  # shellcheck disable=SC1091
  source /emsdk/emsdk_env.sh >/dev/null 2>&1 || true
fi
[ -n "${EMSDK:-}" ] || export EMSDK=/emsdk
command -v emcc >/dev/null || die "emcc not on PATH (EMSDK=$EMSDK)"
[ -f /src/CMakeLists.txt ] || die "no /src/CMakeLists.txt (check the DDNET_SOURCE mount)"
[ -d /src/ddnet-libs ] || die "no /src/ddnet-libs (check the DDNET_LIBS mount)"

mkdir -p "$BUILD_DIR" "$DIST_DIR" "$CARGO_HOME" "$LOG_DIR"
LOG_FILE="$LOG_DIR/compose-$(echo "$BUILD_TYPE" | tr '[:upper:]' '[:lower:]')-$(date -u +%Y%m%d-%H%M%S).log"
# 相对软链：容器内 /logs 映射到宿主 build/logs，绝对容器路径在宿主上会断
ln -sfn "$(basename "$LOG_FILE")" "$LOG_DIR/latest.log"
exec > >(tee -a "$LOG_FILE") 2>&1

log "emcc   : $(emcc --version | head -1)"
log "cmake  : $(cmake --version | head -1)"
log "rustc  : $(rustc --version)"
log "type   : $BUILD_TYPE  jobs: $JOBS  ccache: $CCACHE  package: $PACKAGE"
log "build  : $BUILD_DIR"
log "dist   : $DIST_DIR"
log "log    : $LOG_FILE"

if [ "$CLEAN" = "1" ]; then
  warn "CLEAN=1 -> removing contents of $BUILD_DIR"
  find "$BUILD_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
fi

if [ -f "$BUILD_DIR/CMakeCache.txt" ]; then
  CACHED_SRC="$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=\(.*\)$/\1/p' "$BUILD_DIR/CMakeCache.txt")"
  if [ -n "$CACHED_SRC" ] && [ "$CACHED_SRC" != "/src" ]; then
    die "BUILD_DIR was configured for source \"$CACHED_SRC\" (expected /src). Use CLEAN=1 or another BUILD_DIR."
  fi
fi

CC_ARGS=()
if [ "$CCACHE" = "1" ]; then
  ccache --set-config=max_size=10G >/dev/null 2>&1 || true
  CC_ARGS=(-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
fi

# 与 build-wasm.sh / 上游 CI 一致：必须在源码目录里用 -H. 调 cmake（ddnet-libs 是相对 HINT）
cd /src
emcmake cmake -H. -B "$BUILD_DIR" -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -DVIDEORECORDER=OFF \
  -DVULKAN=OFF \
  -DSERVER=OFF \
  -DTOOLS=OFF \
  -DPREFER_BUNDLED_LIBS=ON \
  "${CC_ARGS[@]}"

cmake --build "$BUILD_DIR" --target game-client -j "$JOBS"
if [ "$PACKAGE" = "1" ]; then
  cmake --build "$BUILD_DIR" --target package_default -j "$JOBS"
fi

log "artifacts in $BUILD_DIR:"
ls -la "$BUILD_DIR"/*.js "$BUILD_DIR"/*.wasm "$BUILD_DIR"/*.data 2>/dev/null || true

# ---- 收集产物（与 build-wasm.sh 相同：index.html 不覆盖项目前端） ----
missing=0
for f in DDNet.js DDNet.wasm DDNet.data; do
  if [ -f "$BUILD_DIR/$f" ]; then
    cp -f "$BUILD_DIR/$f" "$DIST_DIR/$f"
  else
    warn "missing build artifact: $BUILD_DIR/$f"
    missing=1
  fi
done
if [ -f "$BUILD_DIR/index.html" ]; then
  if [ -f "$DIST_DIR/index.html" ] && ! cmp -s "$BUILD_DIR/index.html" "$DIST_DIR/index.html"; then
    log "keeping existing $DIST_DIR/index.html; writing Emscripten page as index-emscripten.html"
    cp -f "$BUILD_DIR/index.html" "$DIST_DIR/index-emscripten.html"
  else
    cp -f "$BUILD_DIR/index.html" "$DIST_DIR/index.html"
  fi
fi
if [ -f "$BUILD_DIR/background.png" ] && [ ! -f "$DIST_DIR/background.png" ]; then
  cp -f "$BUILD_DIR/background.png" "$DIST_DIR/background.png"
fi
[ "$missing" = "1" ] && die "build did not produce all artifacts"

log "artifacts in $DIST_DIR:"
( cd "$DIST_DIR" && ls -la DDNet.js DDNet.wasm DDNet.data )
log "done ($BUILD_TYPE)"
