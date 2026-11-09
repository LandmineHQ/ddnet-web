# DDNet -> WebAssembly (Emscripten) 构建流水线

在容器里复现上游 CI 的 DDNet Emscripten 构建，产出可直接部署的 web 客户端：

    /root/test/ddnet-web/dist/web/DDNet.js
    /root/test/ddnet-web/dist/web/DDNet.wasm
    /root/test/ddnet-web/dist/web/DDNet.data
    /root/test/ddnet-web/dist/web/index.html   (+ background.png)

对应上游 `.github/workflows/build.yml` 的 `build-emscripten` job。

## 0. 快速开始（TL;DR）

    # 一次性：给 docker CLI 一个可写配置目录（本机 /root 只读，见坑 #1）
    mkdir -p /root/test/.docker /root/test/.home
    export DOCKER_CONFIG=/root/test/.docker HOME=/root/test/.home

    cd /root/test/ddnet-web/build

    # 一次性：构建 CI 对齐镜像（emcc 4.0.22 + cmake 3.22.1 + rust 1.89.0）
    docker build --build-arg BASE_IMAGE=emscripten/emsdk:4.0.22 \
                 -t ddnet-wasm-builder:emsdk-4.0.22 -f Dockerfile .

    # 每次：构建（默认 Debug + ddnet-dev 补丁版，约 2 分 40 秒）
    ./build-wasm.sh

    # 先确认工具链都对（秒级，不编译）
    DRY_RUN=1 ./build-wasm.sh

    # 验证（起 server.py，检查 200 / MIME / COOP+COEP）
    ./verify-web.sh 8000 /root/test/ddnet-web/dist/web
    # 浏览器打开 http://127.0.0.1:8000/index.html

产物：`/root/test/ddnet-web/dist/web/{DDNet.js,DDNet.wasm,DDNet.data}`。

---

## 1. 目录结构

    /root/test/ddnet-web/
    ├── build/
    │   ├── Dockerfile          构建镜像（两种 base 都支持）
    │   ├── build-wasm.sh       一键构建脚本（幂等 / 可重入 / 可覆盖路径）
    │   ├── verify-web.sh       起 server.py 并校验 3 个产物 + COOP/COEP 头
    │   ├── README.md           本文件
    │   ├── wasm-build/         构建目录（CMake build tree，可随时删除重建）
    │   ├── cargo-home/         cargo registry 缓存（跨次构建复用）
    │   ├── logs/               每次构建的完整日志 + latest.log 软链
    │   ├── emsdk-official/     从官方镜像里抽出来的 SDK（可选，见路径 B）
    │   └── emsdk/              宿主上装的 emsdk（可选）
    ├── ddnet-dev/              补丁版源码（默认构建目标，git worktree）
    ├── ddnet/                  上游基线源码（BASELINE=1 时构建）
    └── dist/web/               产物

---

## 2. 前置条件（本机特有，务必先读）

| 事实 | 影响 / 对策 |
| --- | --- |
| 沙箱只写 `/root/test`，`/` 其余只读 | `docker build` 会失败，见坑 #1；`HOME`、`DOCKER_CONFIG` 都要指到 `/root/test` 下 |
| 宿主**不能** `apt-get`（`/var` 只读） | 所有装包动作都在容器里做 |
| `dockerd` 在宿主侧运行，我方在 bwrap 沙箱内 | **改不了 daemon 的 proxy**，只能用 daemon 能直连的镜像源 |
| 容器内**直连外网可用**（无需代理） | `deb.debian.org` 约 5.8 MB/s、`static.rust-lang.org` 约 9.7 MB/s、`storage.googleapis.com` 约 8 MB/s |
| 16 vCPU，26 GB 内存，215 GB 可用磁盘 | `-j16` 足够 |
| 官方 emsdk 镜像自带 `cmake 3.22.1`（= CI 版本）、`make`、`build-essential`、`curl`、`git`、`python3` | 官方镜像只缺 **Rust** |

---

## 3. 构建镜像（两条路径，选一条）

### 路径 A（推荐，与上游 CI 完全一致）

`emscripten/emsdk:4.0.22` + Rust 1.89.0，gcc 11 / cmake 3.22.1 / emcc 4.0.22 全部对齐 CI。

    export DOCKER_CONFIG=/root/test/.docker HOME=/root/test/.home   # 见坑 #1
    cd /root/test/ddnet-web/build
    docker build --build-arg BASE_IMAGE=emscripten/emsdk:4.0.22 \
                 -t ddnet-wasm-builder:emsdk-4.0.22 -f Dockerfile .

### 路径 B（无需官方镜像）

本地已有的 `node:24-bookworm-slim` + apt 装全套 + Rust，SDK 由运行时挂载提供。

    export DOCKER_CONFIG=/root/test/.docker HOME=/root/test/.home
    cd /root/test/ddnet-web/build
    docker build -t ddnet-wasm-builder:bookworm-slim -f Dockerfile .

> 路径 B 目前**过不了 DDNet 的 atomics 检查**（Debian 12 / gcc 12 的问题，详见坑 #5）。
> 它适合跑 `DRY_RUN` 探针，不建议作为正式构建基座。

### 获取官方镜像本体（daemon 拉不动时）

本机 docker registry 镜像源几乎全挂，唯一可用的是 `dockerproxy.net`，且它**单连接限速**：

    # daemon 只开约 2 个连接 => 约 140 KB/s（828 MB 要 45 分钟以上）
    docker pull dockerproxy.net/emscripten/emsdk:4.0.22
    docker tag  dockerproxy.net/emscripten/emsdk:4.0.22 emscripten/emsdk:4.0.22

实测 8 个并行 range 连接能到 **6.5 MB/s**（约 130 倍），但会触发 IP 限流，量力而行。
完整拉取实测约 **45 分钟**（828 MB 压缩后）。

---

## 4. 一键构建

    export DOCKER_CONFIG=/root/test/.docker HOME=/root/test/.home
    cd /root/test/ddnet-web/build

    # 默认：Debug 构建 ddnet-dev（补丁版），产物进 /root/test/ddnet-web/dist/web
    ./build-wasm.sh

    # 显式指定镜像（路径 A）
    IMAGE=ddnet-wasm-builder:emsdk-4.0.22 EMSDK_DIR= BUILD_TYPE=Debug JOBS=16 ./build-wasm.sh

    # 上游基线（无补丁）
    BASELINE=1 ./build-wasm.sh

    # Release（加 -flto，很慢）
    BUILD_TYPE=Release JOBS=16 ./build-wasm.sh

    # 秒级验证工具链（不编译）
    DRY_RUN=1 ./build-wasm.sh

脚本实际执行的命令（与 CI 逐字对齐，只是构建目录换成绝对路径）：

    cd /src
    emcmake cmake -H. -B /build -G "Unix Makefiles" \
      -DCMAKE_BUILD_TYPE=Debug \
      -DVIDEORECORDER=OFF -DVULKAN=OFF -DSERVER=OFF -DTOOLS=OFF \
      -DPREFER_BUNDLED_LIBS=ON
    cmake --build /build --target game-client -j16
    cmake --build /build --target package_default        # 产出 .tar.xz，可 PACKAGE=0 跳过

### 可覆盖的环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BASELINE` | `0` | `1` = 构建 `/root/test/ddnet-web/ddnet` 而不是 `ddnet-dev` |
| `SOURCE_DIR` | `<root>/ddnet-dev` | 源码目录，**只读**挂载到 `/src` |
| `BUILD_DIR` | `<script>/wasm-build` | 构建目录 |
| `DIST_DIR` | `<root>/dist/web` | 产物拷贝目标 |
| `IMAGE` | `emscripten/emsdk:4.0.22` | 构建镜像 |
| `EMSDK_DIR` | 自动探测 `build/emsdk-official` 再 `build/emsdk` | 空字符串 = 用镜像内置 SDK |
| `BUILD_TYPE` | `Debug` | `Debug` / `Release` / `RelWithDebInfo` / `MinSizeRel` |
| `JOBS` | `nproc` | 并行度 |
| `CCACHE` | `0` | `1` 启用 ccache |
| `PACKAGE` | `1` | `0` 跳过 `package_default` |
| `CLEAN` | `0` | `1` 先删构建目录 |
| `DRY_RUN` | `0` | `1` 只探测工具链不编译 |
| `FORCE_IMAGE_BUILD` | `0` | `1` 强制重建镜像 |

**幂等性**：中断后原样重跑即可，CMake 增量续编；源码只读挂载，所有生成物都在 `BUILD_DIR`；
cargo registry 缓存在 `cargo-home/`；每次构建的完整输出在 `logs/build-<type>-<时间戳>.log`，
`logs/latest.log` 永远指向最新一次。

---

## 5. 验证

    cd /root/test/ddnet-web/build
    ./verify-web.sh 8000 /root/test/ddnet-web/dist/web

或手工：

    cd /root/test/ddnet-web/dist/web
    python3 /root/test/ddnet-web/ddnet/other/emscripten/server.py 8000 &
    curl -sI http://127.0.0.1:8000/DDNet.js   | head -5
    curl -sI http://127.0.0.1:8000/DDNet.wasm | head -5
    curl -sI http://127.0.0.1:8000/DDNet.data | head -5

要点：**必须**用 `server.py`（或任何带下列响应头的静态服务），否则 pthreads 起不来：

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

浏览器打开 `http://127.0.0.1:8000/index.html`。

部署时 `scripts/assemble-web.sh` 会把 `web/` 前端 shell 覆盖进 `dist/web/` 并生成 `_headers`，
**注意它必须在 build-wasm.sh 之后跑**（否则会被 emscripten 自带的 index.html 覆盖回去）。

---

## 6. 耗时与产物体积（本机实测）

| 阶段 | 耗时 |
| --- | --- |
| `docker pull` 官方镜像（828 MB，走 dockerproxy.net） | 约 45 min |
| 构建派生镜像 `ddnet-wasm-builder:emsdk-4.0.22`（官方 base + apt + rustup） | 约 3 min |
| 构建镜像 `ddnet-wasm-builder:bookworm-slim`（node:24-slim + apt + rustup） | 35 s |
| `configure` | 约 25 s |
| Debug `game-client`（约 900 个 C++ 文件，`-O1`）编译 + 链接 + 打包 | **2 min 38 s**（12 并行） |
| Release `game-client`（`-O3 -flto`）编译 + 链接 + 打包 | **2 min 9 s**（8 并行） |

| 产物 | Debug | Release |
| --- | --- | --- |
| `DDNet.js` | 761,155 B（743 KB） | 376,051 B（367 KB） |
| `DDNet.wasm` | 69,580,358 B（66.4 MB） | **8,871,846 B（8.5 MB）** |
| `DDNet.data` | 54,150,365 B（51.6 MB） | 54,150,365 B（51.6 MB） |

> Release 的 `-O3 -flto` **并没有想象中慢**：全量构建 2 min 9 s，`DDNet.wasm` 从 66.4 MB
> 降到 **8.5 MB**（约 7.8 倍），是真正可部署的产物。Debug 只建议在需要断言/SAFE_HEAP
> 定位内存与逻辑问题时使用。

---

## 7. 踩过的坑（按遇到顺序）

### 坑 #1 — `docker build` 报只读文件系统

    ERROR: failed to update builder last activity time:
    open /root/.docker/buildx/activity/.tmp-default...: read-only file system

buildx 要写自己的活动文件，而 `/root` 只读。**解法**：给 docker CLI 一个可写配置目录

    mkdir -p /root/test/.docker /root/test/.home
    export DOCKER_CONFIG=/root/test/.docker HOME=/root/test/.home

`docker pull/run/images` 不受影响，只有 buildx 受影响。

### 坑 #2 — 所有 docker registry 镜像源都不可用

`/etc/docker/daemon.json` 里配的 `docker.1panel.live` 直接超时，`registry-1.docker.io`
从 daemon 侧连不上（连 `hello-world` 都拉不下来）。逐个探测结果：

| 源 | 结果 |
| --- | --- |
| `registry-1.docker.io` | 超时（daemon 与宿主 curl 均不可达；经 socks5 代理可达，但 daemon 用不上） |
| `docker.1panel.live`（已配置） | 000 超时 / 经代理 403 only support mainland China |
| `docker.m.daocloud.io` | 401 可达，但**明确拒绝 emscripten/emsdk**（不在白名单） |
| `docker.1ms.run` | 401 可达（需 token） |
| `docker.xuanyuan.me` | 403 限流 |
| `docker.nju.edu.cn` / `mirror.ccs.tencentyun.com` | 403 |
| **`dockerproxy.net`** | **200，可用** |
| `hub.rat.dev` / `docker.hlmirror.com` | 302 跳转 |

**关键发现**：dockerproxy.net 是**单连接限速**而不是总带宽限速 —— daemon（约 2 连接）只有
140 KB/s，而 8 个并行 range 连接实测 6.5 MB/s。时间紧时可以用分块并行下载 +
手工组装 docker-archive + `docker load` 的方式绕开 daemon 的并发限制。

### 坑 #3 — emsdk 在宿主解包失败（chown 被禁）

    tar: Cannot change ownership to uid 1000: Operation not permitted

沙箱禁止 `chown`，所以 `./emsdk install` 在宿主上装不进去。**解法**：在容器里以 root 解包，
或者干脆把官方镜像里的 `/emsdk` 整个拷出来（`docker cp`），运行时按**同一绝对路径**只读挂载。

### 坑 #4 — `ddnet-libs` 只有 `.a` 不够，还要 `include/`

sparse checkout 只拉 `*/webasm` 会漏掉头文件，configure 阶段报：

    CMake Error at CMakeLists.txt:769: You must install libpng to compile DDNet
    ... Freetype / Ogg / Opus / Opusfile 同理

CMake 用的是 `PREFER_BUNDLED_LIBS=ON` 的 **HINTS**（找不到就回落到系统库，所以报“未安装”）：
- 库：`ddnet-libs/<lib>/webasm/libwasm/*.a`
- 头：`ddnet-libs/<lib>/include` 与 `ddnet-libs/<lib>/include/webasm`

必须把 `freetype/include`、`png/include`、`opus/include`、`sdl/include`、`sqlite3/include`、
`wavpack/include`、`zlib/include` 全部拉全（完整约 19 MB）。

### 坑 #5 — Debian 12 / gcc 12 过不了 atomics 检查

    -- Performing Test HAVE_ATOMICS_WITHOUT_LIB - Failed
    -- Looking for __atomic_load_8 in atomic - not found
    CMake Error at cmake/CheckAtomic.cmake:47 (message):
      Host compiler appears to require libatomic, but cannot find it.

`CheckAtomic.cmake` 在 `HAVE_ATOMICS_WITHOUT_LIB` 失败后会 `check_library_exists(atomic ...)`，
而此时的编译器是 **emcc**（交叉编译到 wasm），emsdk sysroot 里没有 libatomic，必然 not found。

- Ubuntu 22.04 / gcc 11（官方 emsdk 镜像）：`HAVE_ATOMICS_WITHOUT_LIB - Success`
- Debian 12 / gcc 12（`node:24-bookworm-slim`）：失败

**所以正式构建请用官方镜像做 base**（路径 A）。

### 坑 #6 — `git worktree` 里的 `ddnet-libs` 是软链

`ddnet-dev` 是 `ddnet` 的 worktree，其 `ddnet-libs` 是指向 `/root/test/ddnet-web/ddnet/ddnet-libs`
的**绝对路径软链**；挂载源码到 `/src` 后它会变成断链。`build-wasm.sh` 已做通用处理：
检测 `SOURCE_DIR/ddnet-libs`（以及历史遗留的 `SOURCE_DIR/ddnet-libs/ddnet-libs`）是否为软链，
解析出真实路径后**按 `/src/ddnet-libs` 额外只读挂载**，容器内即可正常解析。

### 坑 #7 — `set -u` 下空数组展开会多传一个空参数

    set -euo pipefail; A=(); set -- x "${A[@]:-}" y   # => argc=3，中间多一个空串

docker 会因此报 `invalid reference format`。**解法**：直接写 `"${A[@]}"`
（bash 4.4+ 在 `set -u` 下对空数组是安全的）。

### 坑 #8 — 别用 ninja

上游明确说这个工程 ninja 有问题（gitlab.kitware.com/cmake/cmake/-/issues/16395），
CI 用 `-G "Unix Makefiles"`。**官方 emsdk 镜像里本来也没有 ninja**，正好一致。

### 坑 #9 — Debug 用 `-O1`，Release 用 `-O3 -flto`

见 `cmake/toolchains/Emscripten.toolchain`：
- Debug：`-g -O1` + `-s ASSERTIONS=2 -s SAFE_HEAP=1 ...`（慢，但断言信息清楚，调联网很有用）
- Release：`-O3` + **`-flto`**（编译/链接时间显著变长）

Debug 里 `-O1` 是**必需的**，否则 `wasm validation error: too many locals`。

---

## 8. 可复现性说明

- 版本全部钉死：`emscripten/emsdk:4.0.22`、`rust 1.89.0`、`cmake 3.22.1`（官方镜像自带），
  与 `.github/workflows/build.yml` 一致。
- 源码以**只读**方式挂载，构建过程不会污染源码树。
- `ddnet-libs` 的 commit 与 `ddnet` 子模块记录一致（`c0e6703fbcdbe03df2f26875427ec3951ce4ec21`）。
- 所有路径都可用环境变量覆盖，同一脚本可构建基线 / 补丁版 / 不同 build type。
- `DRY_RUN=1` 可以秒级确认工具链与库挂载是否正确，不必跑完整构建。

## 9. 已知限制

- WASM 客户端**不支持原生 socket**，联网依赖浏览器 WebSocket（见 `websockets_emscripten.cpp`）。
  工具链里 `PROXY_TO_PTHREAD` 被注释掉，`-lwebsocket.js` / `PROXY_POSIX_SOCKETS` 也未启用。
- 浏览器的 `SharedArrayBuffer` 要求 COOP/COEP 头，静态托管必须配上（见 `_headers`）。
- 本机 docker registry 源不可靠，重新拉镜像可能需要重复坑 #2 的探测流程。
