# DDNet WebAssembly (Emscripten) build environment.
#
# Two supported ways to provide the Emscripten SDK:
#
#   A) SDK from a mounted checkout (default, fast, no big image to pull):
#        FROM node:24-bookworm-slim, and EMSDK points at a directory that is
#        bind-mounted at run time, e.g. EMSDK=/root/test/build/emsdk.
#        build-wasm.sh passes -e EMSDK=... and -v "$EMSDK_DIR:$EMSDK_DIR:ro".
#
#   B) SDK baked into the base image (fully self-contained, used by upstream CI):
#        docker build --build-arg BASE_IMAGE=emscripten/emsdk:4.0.22 \
#                     -t ddnet-wasm-builder:emsdk-4.0.22 -f Dockerfile .
#        In that case EMSDK=/emsdk already comes from the base image and no
#        mount is needed.
#
# Why this file installs cmake itself instead of trusting the base image: a
# locally committed emsdk image may only contain the SDK, not the rest of the
# toolchain. Everything the DDNet wasm build needs is installed explicitly:
#   * cmake (Debian 12 -> 3.25.1, upstream CI pins 3.22.1) and make
#   * build-essential (host C/C++ toolchain)
#   * ninja-build -- optional; DDNet builds with "Unix Makefiles"
#     (ninja is broken for this project: gitlab.kitware.com/cmake/-/issues/16395)
#   * autoconf/automake/libtool/m4/pkg-config -- only needed to rebuild ddnet-libs
#   * xz-utils (package_default produces .tar.xz), zip/unzip, ccache, rsync, file
#   * python3 -- required by emsdk_env.sh / emcmake
#   * nodejs -- comes with the base image, handy for running the wasm output
#   * Rust 1.89.0 + wasm32-unknown-emscripten (DDNet builds Rust crates through
#     cargo/cxx; cmake/FindRust.cmake hard-fails without them, MSRV is 1.85.0)
#
# Build:
#   cd /root/test/build
#   docker build -t ddnet-wasm-builder:bookworm-slim -f Dockerfile .
# Behind a proxy add: --network host --build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=...

ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# Rust outside $HOME so it survives arbitrary --user / mount layouts.
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo
ENV PATH=/opt/cargo/bin:${PATH}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      cmake \
      make \
      build-essential \
      ninja-build \
      autoconf \
      automake \
      libtool \
      m4 \
      pkg-config \
      xz-utils \
      zip \
      unzip \
      wget \
      curl \
      git \
      python3 \
      ca-certificates \
      ccache \
      rsync \
      file \
 && rm -rf /var/lib/apt/lists/*

ARG RUST_VERSION=1.89.0
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain ${RUST_VERSION} \
 && rustup target add wasm32-unknown-emscripten \
 && rustc --version \
 && cargo --version \
 && rustc --print target-list | grep -x wasm32-unknown-emscripten

# Fail the image build (not a 40-minute DDNet build) if a tool is missing.
# emcc itself is only checked at run time, because in mode (A) the SDK is mounted.
RUN cmake --version | head -1 \
 && ninja --version \
 && python3 --version

WORKDIR /src
