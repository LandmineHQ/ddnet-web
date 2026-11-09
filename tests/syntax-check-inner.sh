#!/bin/bash
# Runs inside the ddcheck container (no docker CLI needed there).
# Syntax-check the Emscripten-only sources with g++ before doing a real wasm build.
set -u
ROOT="${ROOT:-/w}"
SRC="${ROOT}/ddnet-dev"
STUB="${ROOT}/tests/stub"
FAILED=0
# ddnet-libs is an absolute symlink into the main checkout; translate the host
# path to the compose mount point (usually /w) so includes resolve inside docker.
LIBS="$(readlink -f "${SRC}/ddnet-libs" 2>/dev/null || true)"
case "${LIBS}" in
	/root/test/*) LIBS="${ROOT}/${LIBS#/root/test/}" ;;
esac
if [ ! -d "${LIBS}/sdl/include/webasm" ] && [ -d "${ROOT}/ddnet/ddnet-libs/sdl/include/webasm" ]; then
	LIBS="${ROOT}/ddnet/ddnet-libs"
fi

check() {
	local file="$1"; shift
	echo "=== syntax check: ${file} $*"
	# generated/protocol*.h live in the CMake build tree, not in the source tree.
	if ! g++ -std=c++20 -fsyntax-only -Wall -Wextra -Wno-unused-parameter \
		-DCONF_PLATFORM_EMSCRIPTEN=1 -I"${SRC}/src" -I"${STUB}" \
		-I"${ROOT}/build/wasm-build-release/src" -I"${ROOT}/build/wasm-build/src" \
		-I"${SRC}/src/rust-bridge" -I"${LIBS}/sdl/include/webasm" \
		"$@" "${SRC}/${file}"; then
		FAILED=1
	fi
}

check src/engine/shared/websockets_emscripten.cpp
check src/base/net.cpp
check src/engine/client/client.cpp

if [ "${FAILED}" -ne 0 ]; then
	echo "SYNTAX CHECK FAILED"
	exit 1
fi
echo "SYNTAX CHECK OK"
