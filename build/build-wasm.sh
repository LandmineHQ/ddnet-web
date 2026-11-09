#!/usr/bin/env bash
#
# Reproducible DDNet -> WebAssembly (Emscripten) build.
#
# Idempotent / re-entrant:
#   * the builder image is only built when missing (FORCE_IMAGE_BUILD=1 rebuilds);
#   * CMake is re-configured in place, so an interrupted build resumes incrementally;
#   * the source tree is mounted READ-ONLY; everything generated lands in BUILD_DIR;
#   * the cargo registry is cached in CARGO_HOME_HOST across runs;
#   * the full build log is tee'd to LOG_DIR.
#
# The Emscripten SDK can come from either place:
#   1. an image that already contains the SDK (what this host uses, because the
#      official image could be fetched):
#        IMAGE=emscripten/emsdk:4.0.22 EMSDK_DIR= ./build-wasm.sh
#   2. a directory on the host, bind-mounted at the same absolute path:
#        EMSDK_DIR=/root/test/build/emsdk ./build-wasm.sh
#      (EMSDK_DIR is auto-detected when <root>/build/emsdk has upstream/emscripten)
#
# By default this builds the PATCHED worktree (<root>/ddnet-dev).
# Use BASELINE=1 to build the pristine upstream tree instead.
#
# Environment overrides:
#   BASELINE=1              build <root>/ddnet instead of <root>/ddnet-dev
#   SOURCE_DIR=...          explicit source tree (mounted read-only at /src)
#   BUILD_DIR=...           build tree (default <script>/wasm-build)
#   DIST_DIR=...            where DDNet.{js,wasm,data} are copied (default <root>/dist/web)
#   IMAGE=...               builder image
#   EMSDK_DIR=...           host SDK dir, mounted read-only at the same absolute path;
#                           empty string = rely on the SDK baked into IMAGE
#   BUILD_TYPE=...          Debug (default) | Release | RelWithDebInfo | MinSizeRel
#   JOBS=<n>                default: nproc
#   CCACHE=1                enable the compiler cache
#   PACKAGE=0               skip the package_default (tar.xz) step
#   CLEAN=1                 wipe BUILD_DIR before configuring
#   FORCE_IMAGE_BUILD=1     rebuild the builder image
#
# IMPORTANT: docker build needs a writable DOCKER_CONFIG on this host, because
# /root is read-only and buildx writes activity files there:
#   export DOCKER_CONFIG=/root/test/.docker HOME=/root/test/.home
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- snapshot user overrides BEFORE assigning any defaults -----------------
# (assigning to an inherited exported variable would rewrite the environment,
#  which makes a later `printenv` see the default instead of the user value)
declare -A OVERRIDE=()
for _v in BASELINE SOURCE_DIR BUILD_DIR DIST_DIR CARGO_HOME_HOST LOG_DIR IMAGE \
          BASE_IMAGE BUILD_TYPE JOBS CCACHE PACKAGE CLEAN FORCE_IMAGE_BUILD \
          DOCKERFILE EMSDK_DIR DRY_RUN; do
  if [ -n "${!_v+x}" ]; then OVERRIDE[$_v]="${!_v}"; fi
done

# ---- defaults ------------------------------------------------------------
DEV_SOURCE_DIR="$DEFAULT_ROOT/ddnet-dev"
BASELINE_SOURCE_DIR="$DEFAULT_ROOT/ddnet"
BUILD_DIR="$SCRIPT_DIR/wasm-build"
DIST_DIR="$DEFAULT_ROOT/dist/web"
CARGO_HOME_HOST="$SCRIPT_DIR/cargo-home"
LOG_DIR="$SCRIPT_DIR/logs"
IMAGE="ddnet-wasm-builder:emsdk-4.0.22"
BASE_IMAGE="emscripten/emsdk:4.0.22"
BUILD_TYPE="Debug"
JOBS="$(nproc)"
CCACHE="0"
PACKAGE="1"
CLEAN="0"
FORCE_IMAGE_BUILD="0"
BASELINE="0"
DRY_RUN="0"
DOCKERFILE="$SCRIPT_DIR/Dockerfile"

# Auto-detect a host SDK: prefer the SDK extracted from the official image
# (<root>/build/emsdk-official), then a locally installed emsdk
# (<root>/build/emsdk). Otherwise rely on the SDK baked into IMAGE.
EMSDK_AUTODETECT=""
for _cand in "$DEFAULT_ROOT/build/emsdk-official" "$DEFAULT_ROOT/build/emsdk" \
             "$SCRIPT_DIR/emsdk-official" "$SCRIPT_DIR/emsdk"; do
  if [ -d "$_cand/upstream/emscripten" ]; then EMSDK_AUTODETECT="$_cand"; break; fi
done
EMSDK_DIR=""

SOURCE_DIR=""

for _v in "${!OVERRIDE[@]}"; do printf -v "$_v" "%s" "${OVERRIDE[$_v]}"; done

if [ "$BASELINE" = "1" ]; then
  [ -n "$SOURCE_DIR" ] || SOURCE_DIR="$BASELINE_SOURCE_DIR"
else
  [ -n "$SOURCE_DIR" ] || SOURCE_DIR="$DEV_SOURCE_DIR"
fi

log()  { printf "\033[1;34m[build-wasm]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[build-wasm]\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31m[build-wasm]\033[0m %s\n" "$*" >&2; exit 1; }

# ---- preflight -----------------------------------------------------------
command -v docker >/dev/null || die "docker not found"
[ -f "$SOURCE_DIR/CMakeLists.txt" ] || die "no CMakeLists.txt in SOURCE_DIR=$SOURCE_DIR"
[ -f "$SOURCE_DIR/Cargo.lock" ] || warn "no Cargo.lock in $SOURCE_DIR (cargo --locked may fail)"

# Resolve where the prebuilt webasm libraries really live. git worktrees keep
# ddnet-libs as an absolute symlink into the main checkout, and a stray
# <ddnet-libs>/ddnet-libs symlink has been observed as well; support all of:
#   <src>/ddnet-libs            real directory
#   <src>/ddnet-libs            symlink -> $LIBS_SRC
#   <src>/ddnet-libs/ddnet-libs symlink -> $LIBS_SRC
LIBS_SRC=""
for cand in "$SOURCE_DIR/ddnet-libs" "$SOURCE_DIR/ddnet-libs/ddnet-libs"; do
  if [ -L "$cand" ]; then
    LIBS_SRC="$(readlink -f "$cand")"
  elif [ -d "$cand/sdl/webasm/libwasm" ]; then
    LIBS_SRC="$cand"
  fi
  [ -n "$LIBS_SRC" ] && break
done
[ -n "$LIBS_SRC" ] || die "could not locate ddnet-libs (webasm/libwasm) under $SOURCE_DIR"
[ -f "$LIBS_SRC/sdl/webasm/libwasm/libSDL2.a" ] || die "ddnet-libs at $LIBS_SRC has no sdl/webasm/libwasm/libSDL2.a"

if [ -n "$EMSDK_DIR" ]; then
  [ -f "$EMSDK_DIR/emsdk_env.sh" ] || die "EMSDK_DIR=$EMSDK_DIR has no emsdk_env.sh"
  [ -d "$EMSDK_DIR/upstream/emscripten" ] || die "EMSDK_DIR=$EMSDK_DIR has no upstream/emscripten (run: emsdk install 4.0.22)"
fi

log "source : $SOURCE_DIR  (read-only at /src)"
log "libs   : $LIBS_SRC  (read-only at /src/ddnet-libs)"
log "build  : $BUILD_DIR"
log "dist   : $DIST_DIR"
log "image  : $IMAGE"
log "emsdk  : ${EMSDK_DIR:-<from image>}"
log "type   : $BUILD_TYPE  jobs: $JOBS  ccache: $CCACHE  package: $PACKAGE"

[ "$CLEAN" = "1" ] && { warn "CLEAN=1 -> removing $BUILD_DIR"; rm -rf "$BUILD_DIR"; }
mkdir -p "$BUILD_DIR" "$DIST_DIR" "$CARGO_HOME_HOST" "$LOG_DIR"
LOG_FILE="$LOG_DIR/build-$(echo "$BUILD_TYPE" | tr "[:upper:]" "[:lower:]")-$(date +%Y%m%d-%H%M%S).log"
ln -sfn "$LOG_FILE" "$LOG_DIR/latest.log"
log "log    : $LOG_FILE"

if [ -f "$BUILD_DIR/CMakeCache.txt" ]; then
  CACHED_SRC="$(sed -n "s/^CMAKE_HOME_DIRECTORY:INTERNAL=\(.*\)$/\1/p" "$BUILD_DIR/CMakeCache.txt")"
  if [ -n "$CACHED_SRC" ] && [ "$CACHED_SRC" != "/src" ]; then
    die "BUILD_DIR was configured for source \"$CACHED_SRC\" (expected /src). Use CLEAN=1 or another BUILD_DIR."
  fi
fi

# ---- image ---------------------------------------------------------------
if [ "$FORCE_IMAGE_BUILD" = "1" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "building builder image $IMAGE (base $BASE_IMAGE) from $DOCKERFILE"
  docker build --build-arg "BASE_IMAGE=$BASE_IMAGE" -t "$IMAGE" -f "$DOCKERFILE" "$SCRIPT_DIR" 2>&1 | tee -a "$LOG_FILE"
else
  log "builder image $IMAGE already present"
fi

# Decide where the SDK comes from. If the user did not say, prefer the SDK baked
# into the image (that is what upstream CI uses); only fall back to a host SDK
# directory when the image does not contain one.
if [ -z "${OVERRIDE[EMSDK_DIR]+set}" ]; then
  if docker run --rm --entrypoint sh "$IMAGE" -c "test -x /emsdk/upstream/emscripten/emcc" >/dev/null 2>&1; then
    EMSDK_DIR=""
    log "SDK source: built into $IMAGE (/emsdk)"
  elif [ -n "$EMSDK_AUTODETECT" ]; then
    EMSDK_DIR="$EMSDK_AUTODETECT"
    log "SDK source: host directory $EMSDK_DIR (image has no SDK)"
  else
    die "image $IMAGE has no /emsdk and no host SDK was found; pass EMSDK_DIR=..."
  fi
fi

# ---- container -----------------------------------------------------------
ARGS=(
  --rm
  -v "$SOURCE_DIR:/src:ro"
  -v "$LIBS_SRC:/src/ddnet-libs:ro"
  -v "$BUILD_DIR:/build"
  -v "$CARGO_HOME_HOST:/cargo"
  -v "$DIST_DIR:/dist"
  -e "BUILD_TYPE=$BUILD_TYPE"
  -e "JOBS=$JOBS"
  -e "CCACHE=$CCACHE"
  -e "PACKAGE=$PACKAGE"
  -e "CARGO_HOME=/cargo"
  -e "CARGO_NET_RETRY=10"
  -e "CARGO_HTTP_MULTIPLEXING=false"
  -e "HOME=/root"
  -w /build
)
if [ -n "$EMSDK_DIR" ]; then
  ARGS+=(-v "$EMSDK_DIR:$EMSDK_DIR:ro" -e "EMSDK=$EMSDK_DIR")
fi

# ---- dry run: prove the container sees the whole toolchain, build nothing --
if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1 -> probing the container toolchain instead of building"
  docker run "${ARGS[@]}" "$IMAGE" bash -c '
    set -euo pipefail
    if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true; fi
    echo "EMSDK       = ${EMSDK:-<unset>}"
    echo "emcc        = $(emcc --version 2>/dev/null | head -1 || echo MISSING)"
    echo "em++        = $(command -v em++ || echo MISSING)"
    echo "cmake       = $(cmake --version 2>/dev/null | head -1 || echo MISSING)"
    echo "make        = $(command -v make || echo MISSING)"
    echo "ninja       = $(command -v ninja || echo absent-ok)"
    echo "rustc       = $(rustc --version 2>/dev/null || echo MISSING)"
    echo "wasm-target = $(rustc --print target-list 2>/dev/null | grep -x wasm32-unknown-emscripten || echo MISSING)"
    echo "python3     = $(python3 --version 2>/dev/null || echo MISSING)"
    echo "Cargo.lock  = $([ -f /src/Cargo.lock ] && echo ok || echo MISSING)"
    echo "ddnet-libs  = $(ls /src/ddnet-libs | tr "\n" " ")"
    echo "libSDL2.a   = $([ -f /src/ddnet-libs/sdl/webasm/libwasm/libSDL2.a ] && echo ok || echo MISSING)"
  '
  exit $?
fi

read -r -d "" INNER <<'INNER_EOF' || true
set -euo pipefail

if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  # shellcheck disable=SC1091
  source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true
fi
[ -n "${EMSDK:-}" ] || { echo "EMSDK is not set" >&2; exit 1; }
command -v emcc >/dev/null || { echo "emcc not on PATH (EMSDK=$EMSDK)" >&2; exit 1; }

echo "[inner] EMCC   : $(emcc --version | head -1)"
echo "[inner] cmake  : $(cmake --version | head -1)"
echo "[inner] rustc  : $(rustc --version)"
echo "[inner] node   : $(node --version 2>/dev/null || echo n/a)"
echo "[inner] EMSDK  : $EMSDK"
echo "[inner] date   : $(date -u)"
echo "[inner] libs   : $(ls /src/ddnet-libs)"

if [ "${CCACHE}" = "1" ]; then
  ccache --set-config=max_size=10G >/dev/null 2>&1 || true
  echo "[inner] ccache : $(ccache --version | head -1)"
fi

# Mirrors upstream CI (.github/workflows/build.yml, build-emscripten): cmake is
# invoked with -H. from INSIDE the source directory. This matters: DDNet passes
# the bundled libraries as relative HINTS such as "ddnet-libs/png/webasm/libwasm",
# and those are resolved against the working directory -- running cmake from the
# build directory instead makes every bundled library look missing
# ("You must install libpng/Freetype/Ogg/Opus/Opusfile ...").
# "Unix Makefiles" is required, see gitlab.kitware.com/cmake/cmake/-/issues/16395
CC_ARGS=()
if [ "${CCACHE}" = "1" ]; then
  CC_ARGS=(-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
fi

cd /src
emcmake cmake -H. -B /build -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE="${BUILD_TYPE}" \
  -DVIDEORECORDER=OFF \
  -DVULKAN=OFF \
  -DSERVER=OFF \
  -DTOOLS=OFF \
  -DPREFER_BUNDLED_LIBS=ON \
  "${CC_ARGS[@]}"

cd /build

cmake --build /build --target game-client -j "${JOBS}"

if [ "${PACKAGE}" = "1" ]; then
  cmake --build /build --target package_default -j "${JOBS}"
fi

echo "[inner] artifacts in /build:"
ls -la /build/*.js /build/*.wasm /build/*.data 2>/dev/null || true
INNER_EOF

START=$(date +%s)
log "starting container (full log -> $LOG_FILE)"
set +e
docker run "${ARGS[@]}" "$IMAGE" bash -c "$INNER" 2>&1 | tee -a "$LOG_FILE"
RC=${PIPESTATUS[0]}
set -e
ELAPSED=$(( $(date +%s) - START ))
log "container exited rc=$RC after $((ELAPSED/60))m$((ELAPSED%60))s"

if [ "$RC" != "0" ]; then
  warn "BUILD FAILED (rc=$RC) -- full log: $LOG_FILE"
  tail -40 "$LOG_FILE" >&2
  exit "$RC"
fi

# ---- collect dist --------------------------------------------------------
missing=0
for f in DDNet.js DDNet.wasm DDNet.data; do
  if [ -f "$BUILD_DIR/$f" ]; then
    cp -f "$BUILD_DIR/$f" "$DIST_DIR/$f"
  else
    warn "missing build artifact: $BUILD_DIR/$f"; missing=1
  fi
done
# index.html: upstream ships its own page, but a deployable dist/web may already
# contain the project frontend shell (scripts/assemble-web.sh). Never clobber it;
# keep the Emscripten page available next to it instead.
if [ -f "$BUILD_DIR/index.html" ]; then
  if [ -f "$DIST_DIR/index.html" ] && ! cmp -s "$BUILD_DIR/index.html" "$DIST_DIR/index.html"; then
    log "keeping existing $DIST_DIR/index.html; writing Emscripten page as index-emscripten.html"
    cp -f "$BUILD_DIR/index.html" "$DIST_DIR/index-emscripten.html"
  else
    cp -f "$BUILD_DIR/index.html" "$DIST_DIR/index.html"
  fi
fi
for f in background.png; do
  [ -f "$BUILD_DIR/$f" ] && [ ! -f "$DIST_DIR/$f" ] && cp -f "$BUILD_DIR/$f" "$DIST_DIR/$f"
done
[ "$missing" = "1" ] && die "build did not produce all artifacts"

log "artifacts in $DIST_DIR:"
( cd "$DIST_DIR" && ls -la DDNet.js DDNet.wasm DDNet.data )

cat <<EOF

Build complete in $((ELAPSED/60))m$((ELAPSED%60))s ($BUILD_TYPE)
  source: $SOURCE_DIR
  log   : $LOG_FILE

Serve locally (COOP/COEP headers are required for SharedArrayBuffer/pthreads):
  cd $DIST_DIR && python3 $SOURCE_DIR/other/emscripten/server.py 8000
  # then open http://127.0.0.1:8000/index.html

EOF
