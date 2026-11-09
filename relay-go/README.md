# ddnet-relay-go — WSS → UDP relay for the DDNet web client

A Go 1.24 rewrite of the Node.js relay in `../relay`, with **pion/webrtc**
for a WebRTC DataChannel transport (preferred) and WebSocket as fallback.
It bridges the browser client to an unmodified DDNet/Teeworlds UDP server:

```
browser (WebRTC)                 relay (Go)                 game server
┌──────────────────┐  DC   ┌────────────────────┐  udp  ┌──────────────┐
│ DDNet wasm client│──────▶│ 1 DC message       │──────▶│ DDNet :8303  │
│ (WS fallback)    │◀──────│ = 1 UDP datagram   │◀──────│ (unchanged)  │
└──────────────────┘       │ pion/webrtc + UDP  │       └──────────────┘
                           └────────────────────┘
```

The wire contract, config JSON, environment variables, HTTP API, close codes and
error codes match the Node relay, so the existing frontend/wasm client works
unchanged. One binary, no native modules, no npm dependencies.

## Features

- **WebSocket endpoint** `/udp/<host>:<port>` (and `/udp?target=host:port`),
  one binary frame each way, per-session connected UDP socket, target pinned to
  the validated DNS answer, packets buffered while the socket is being set up,
  idle timeout, optional WS ping keepalive, hard frame-size guard, text frames
  dropped.
- **WebRTC endpoint** `POST /rtc/offer` (pion/webrtc, pure Go):
  * without `?target=`: latency probe; the data channel is echoed unchanged.
  * with `?target=host:port`: **game transport**; 1 data-channel message = 1
    UDP datagram, bidirectionally bridged to the target. SSRF policy applies.
  * non-trickle SDP answer, peer lifetime/idle timeout, per-IP offer rate
    limiting, `maxPeers`, `maxOfferBytes`, counters in `/api/stats.rtc`.
- **HTTP API**: `GET /healthz`, `/api/info`, `/api/stats`, `/api/servers`,
  CORS (`*` by default) and `OPTIONS` preflight, JSON errors `{error, code}`,
  `404`/`405`/`429`/`503` semantics.
- **Security**: relay tokens (constant-time compare from `?token=`,
  `Authorization: Bearer` or `x-relay-token`), Origin allowlist with `*`
  wildcards, SSRF protection (DNS resolved once, **all** answers classified,
  private/loopback/link-local/CGNAT/reserved blocked unless `allowPrivate` or an
  allowlist host/IP/CIDR entry exists), per-IP and global connection limits,
  per-session packet/byte token buckets, frame guard, backpressure drops.
- **Operations**: structured JSON logs on stdout, graceful `SIGTERM`/`SIGINT`
  shutdown (close code `1001 server_shutdown`), `/healthz` for container probes,
  static `CGO_ENABLED=0` binary, non-root alpine image (~14 MB) with
  `HEALTHCHECK`.

## Quick start

### Docker compose (recommended in this repo)

The whole project starts every service through compose:

```bash
cd /root/test/ddnet-web

# dev stack: relay (:8390) + web (:8392, https+wss :8443);
# /api/servers points at DDNet official Tutorial (no local game server)
docker compose -f compose.dev.yml up -d --build
curl -s http://127.0.0.1:8390/healthz

# production: relay + relay master (TLS/WSS via nginx, see deploy/nginx.conf)
RELAY_DOMAIN=relay.example.com SITE_DOMAIN=play.example.com docker compose up -d --build
```

### Prebuilt static binary (binary deployment)

`bin/ddnet-relay-linux-amd64` is a stripped `CGO_ENABLED=0` static binary (linux/amd64, ~5.7 MB),
sha256 `47e44eb6f4862946faead2fb75e59e0f20e62171262fd8dca08ce8fbfdc9da28`. Copy it to any Linux host and run:

```bash
RELAY_HOST=0.0.0.0 RELAY_PORT=8390 RELAY_ALLOWLIST=127.0.0.1/32 \
  ./bin/ddnet-relay-linux-amd64 --config relay.config.json
```

Rebuild it with the Docker toolchain if you change the source:

```bash
docker run --rm -v "$PWD":/src -w /src dockerproxy.net/library/golang:1.24-alpine \
  sh -c 'CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/ddnet-relay-linux-amd64 ./cmd/relay'
```

### Standalone image (optional, e.g. binary/image deployment)

```bash
docker build -t ddnet-relay-go:dev .

# DDNet official Tutorial server -> relay on :8390
docker run --rm -p 8390:8390 ddnet-relay-go:dev

curl -s http://127.0.0.1:8390/healthz
```

Then point a WebSocket client at:

```
ws://127.0.0.1:8390/udp/74.91.126.203:8300
```

> The image defaults to `RELAY_HOST=0.0.0.0 RELAY_PORT=8390` and runs as the
> unprivileged `relay` user (uid/gid 100/101). Sample configs are baked in at
> `/app/config/` (world-readable). If you bind-mount your own config, make it
> readable by uid 100 (`chmod a+r`) or the relay will exit with
> `Configuration error: ... permission denied`. For **wss://** terminate TLS in
> front of it (nginx) — the relay itself speaks plain HTTP/WS on
> purpose, so it stays small and easy to proxy.

### From source (Go 1.24, dependencies vendored)

```bash
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o relay ./cmd/relay
./relay --config relay.dev-lan.json          # dev config
./relay --print-config --config relay.config.json
```

## WebSocket endpoint

```
ws[s]://<relay>/udp/<host>:<port>[?token=...][&protocol=7]
ws[s]://<relay>/udp?target=<host>:<port>[&token=...]
```

- `protocol=7`, `sevenup=1`, `tw7=1` and any other unknown query parameter are
  **ignored** (never forwarded to the game server; the relay only forwards
  binary payload bytes).
- A target without a port defaults to `8303`. IPv6 targets use `[addr]:port`.
- 1 binary WebSocket frame = 1 UDP datagram, both directions, unchanged bytes.
- Text frames, empty frames and frames larger than `limits.maxFrameBytes`
  (default 2048) are dropped and counted; the connection survives. Frames above
  `limits.hardMaxFrameBytes` (default 65536) close the connection with `1011`.
- Close codes: `1000 client_closed`, `1001 idle_timeout` / `max_duration` /
  `server_shutdown`, `1011 target_unreachable` / `udp_error` / `ws_error`.
- `?token=` may be omitted when no tokens are configured (anonymous relay).

## HTTP API

All API responses are `application/json; charset=utf-8`, `Cache-Control:
no-store`, with CORS headers (`Access-Control-Allow-Origin: *` unless
`api.corsOrigins` is restricted). Malformed/unsupported requests return
`{"error": "...", "code": "..."}`.

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | Liveness: `{status:"ok", service:"ddnet-ws-relay", version, activeConnections, rtc:true, uptimeSec, time, address:{host,port}}` |
| GET | `/api/info` | `{name, version, protocol:"ws-udp-datagram/1", region, rtc:true, iceServers:[...], uptimeSec, activeConnections, time}` |
| GET | `/api/stats` | Aggregate counters + `limits` + `security` + effective `config` (tokens never exposed) + `rtc` snapshot. Disable with `api.statsEnabled=false`. |
| GET | `/api/servers` | `{servers:[{name,host,port,address,note?}], count, generatedAt}` from the `servers` config / `RELAY_SERVERS_FILE`. Disable with `api.serversEnabled=false`. |
| POST | `/rtc/offer` | SDP offer `{type:"offer", sdp}` → `{type:"answer", sdp}`. Add `?target=host:port` for the game data channel; without it the channel is echoed (latency probe). Auth/Origin/SSRF/limits apply. |
| OPTIONS | any API path | `204` + CORS + `Access-Control-Max-Age: 600`. |

`GET`-only endpoints answer `405` with `Allow: GET, HEAD, OPTIONS`. HEAD works
(headers + Content-Length, no body). Unknown paths return `404 not_found`.

## Relay master

The master is a second Go binary (`cmd/master`, image `Dockerfile.master`) that
keeps the list of active relay nodes:

```bash
# local
go run ./cmd/master --host 127.0.0.1 --port 8391
# docker
docker build -f Dockerfile.master -t ddnet-relay-master .
docker run --rm -p 8391:8391 ddnet-relay-master
```

Endpoints:

```text
POST /v1/register    {name,url,region,version,players,transports,webrtc}
POST /v1/unregister  {url}
GET  /v1/serverlist  {"count":N,"generatedAt":"...","servers":[...]}
GET  /healthz
GET  /api/stats
```

Registration is only accepted after the master performs a WebSocket handshake
against `<url>/ws` (the relay exposes `/ws` for exactly this). A failed probe
returns HTTP 502 and the node is not listed. The relay re-registers every 30 s;
already-verified nodes are not re-probed on heartbeat. Every 15 minutes
(`MASTER_PROBE_INTERVAL_MS`) the master probes all nodes and removes any that no
longer accept a WebSocket connection.

The relay also declares its WebRTC transport:
`transports:["websocket","webrtc"]` and
`webrtc:{"enabled":true,"host":"relay.example.com","signalUrl":"https://relay.example.com/rtc/offer","udpPort":8390}`.
`host` is the public UDP entry hostname/IP (or `RTC_PUBLIC_IP` when set).
`udpPort` is a fixed shared ICE port; the master rejects WebRTC-enabled
registrations with `udpPort=0`, so clients never get per-user UDP ports.

Relay-side configuration (defaults shown):

```text
master.enabled=true
master.domain=master.landmine.top
master.scheme=https
master.advertiseUrl=<derived ws://127.0.0.1:<port> for local runs>
master.intervalMs=30000
master.timeoutMs=5000
master.skipWhenToken=true
```

CLI flags: `--master-domain`, `--master-scheme`, `--master-advertise-url`,
`--master-interval-ms`, `--master-timeout-ms`, `--no-master`.
Environment: `RELAY_MASTER_ENABLED`, `RELAY_MASTER_DOMAIN`,
`RELAY_MASTER_ADVERTISE_URL`, `RELAY_MASTER_INTERVAL_MS`,
`RELAY_MASTER_TIMEOUT_MS`, `RELAY_MASTER_SKIP_WHEN_TOKEN`.

A relay with a non-empty `auth.tokens` list does **not** register
(`skipWhenToken=true`). Also, a loopback advertise URL against a remote master is
skipped unless explicitly allowed, so local test relays don't pollute the public
list. Public deployments must set a public `wss://` advertise URL
(`RELAY_MASTER_ADVERTISE_URL` / `RELAY_PUBLIC_URL` in compose).

The registry is in-memory: a master restart loses entries until relay heartbeats
re-register them. Use a reverse proxy / gateway for stronger registration auth.

## Configuration

Precedence: **built-in defaults → JSON config file → `RELAY_*` environment →
CLI flags**. `--print-config` prints the effective configuration with token
values redacted.

```bash
./relay --config relay.config.json --host 0.0.0.0 --port 8390
./relay --print-config --config relay.dev-lan.json
```

JSON structure is identical to the Node relay (`../relay/relay.config.json`):
top-level `name, region, host, port, udpPath, logLevel, trustProxy`, then
`auth{tokens, originAllowlist, allowNoOrigin, tokenHeader}`,
`security{allowPrivate, allowlist, dnsTimeoutMs}`,
`limits{maxConnectionsPerIp, maxConnectionsTotal, maxFrameBytes,
hardMaxFrameBytes, maxPacketsPerSecond, packetBurst, maxBytesPerSecond,
byteBurst, idleTimeoutMs, maxConnectionMs, maxBufferedBytes, pingIntervalMs,
maxPendingPackets}`, `api{statsEnabled, serversEnabled, corsOrigins}`,
`rtc{enabled, maxPeers, maxLifetimeMs, maxOfferBytes, maxOffersPerIpPerMinute,
offerBurst, gatherTimeoutMs, iceServers, udpPort, publicIp}`, and `servers[...]`.

`servers` entries may be objects (`{name, host, port, note, ...extra}` — extra
keys are passed through to `/api/servers`) or `"host:port"` strings. A servers
file (`RELAY_SERVERS_FILE` or `--servers`) accepts `{"servers":[...]}` or a bare
array.

RTC defaults: enabled, 16 peers, 60 s probe lifetime, 256 KiB offer, 30 offers/min/IP
(burst 10), 5 s ICE gather, ephemeral ICE UDP port, no ICE servers.
For public deployments:

* set `rtc.udpPort` / `RTC_UDP_PORT` so ICE traffic uses one UDP port shared by all
  peers. The default follows the relay TCP port (`8390` dev, `443` in production
  compose, where nginx owns TCP 443 and the relay owns UDP 443); publish it and
  open it in the firewall;
* set `rtc.publicIp` / `RTC_PUBLIC_IP` when the relay is behind 1:1 NAT so the
  advertised host candidate is the public address;
* optionally add STUN/TURN via `rtc.iceServers` / `RTC_ICE_SERVERS`
  (e.g. `stun:stun.example.org:3478`); the browser receives the list from
  `/api/info.iceServers`.

Defaults: port `8390`, `udpPath /udp`, anonymous auth, no Origin restriction,
SSRF strict (no private targets), 8 conns/IP, 1000 conns total, 2048/65536 B
frames, 300 pkt/s burst 600, 256 KiB/s burst 512 KiB, idle 60 s, ping 20 s,
CORS `*`.

Environment variables (same names as the Node relay):

```
RELAY_CONFIG RELAY_NAME RELAY_REGION RELAY_HOST RELAY_PORT RELAY_UDP_PATH
RELAY_LOG_LEVEL RELAY_TRUST_PROXY
RELAY_TOKENS RELAY_TOKEN RELAY_ORIGINS RELAY_ORIGIN_ALLOWLIST
RELAY_ALLOW_NO_ORIGIN ALLOW_PRIVATE RELAY_ALLOWLIST RELAY_DNS_TIMEOUT_MS
MAX_CONNS_PER_IP MAX_CONNECTIONS_TOTAL MAX_FRAME_BYTES HARD_MAX_FRAME_BYTES
MAX_PACKETS_PER_SEC PACKET_BURST MAX_BYTES_PER_SEC BYTE_BURST IDLE_TIMEOUT_MS
MAX_CONNECTION_MS MAX_BUFFERED_BYTES PING_INTERVAL_MS MAX_PENDING_PACKETS
RELAY_API_CORS RTC_ENABLED RTC_MAX_PEERS RTC_MAX_LIFETIME_MS
RTC_MAX_OFFER_BYTES RTC_MAX_OFFERS_PER_IP_PER_MINUTE RTC_OFFER_BURST
RTC_GATHER_TIMEOUT_MS RTC_ICE_SERVERS RELAY_SERVERS_FILE
```

CLI flags: `-c/--config`, `--host`, `--port`, `--log-level`, `--token`
(repeatable), `--allow-private`, `--allowlist` (repeatable), `--servers`,
`--print-config`, `--version`, `-h/--help`.

## Security model

- **Tokens**: configured list; empty list = anonymous (logged as a warning).
  Comparison hashes both values and uses `crypto/subtle`, evaluating every
  configured token without early exit.
- **Origin**: exact match or `*` wildcard patterns (`https://*.example.com`);
  empty allowlist = open; missing Origin allowed only when
  `auth.allowNoOrigin=true` (default).
- **SSRF**: literal IPs are classified directly; hostnames are resolved once
  (bounded by `security.dnsTimeoutMs`). Every answer is classified and any
  private/reserved answer rejects the target (DNS-rebinding defence). The
  validated IP is pinned; the hostname is never resolved twice. Categories:
  `unspecified, loopback, private, link_local, cgnat, broadcast, multicast,
  reserved, ipv4_mapped`. Operators can permit targets with `ALLOW_PRIVATE=1`
  or allowlist entries (hostname, IP, or CIDR).
- **Limits**: per-IP concurrent connections, global concurrent connections,
  per-session packet and byte token buckets (control frames never spend the
  budget), frame guard (`maxFrameBytes`) and hard frame limit
  (`hardMaxFrameBytes`), WS write backpressure (`maxBufferedBytes`).
- **Proxy**: `RELAY_TRUST_PROXY=1` makes `X-Forwarded-For` (first hop) the
  client IP for limits/logging.

## Logging and operations

Structured JSON lines on stdout (`ts`, `level`, `event`, plus fields):

```json
{"ts":"2026-11-08T07:30:19.745Z","level":"info","event":"connection_open","connId":"c-1a2b3c4d","target":"127.0.0.1:8313","clientIp":"127.0.0.1","family":4,"address":"127.0.0.1","port":8313,"origin":""}
```

Levels: `debug|info|warn|error|silent`. `SIGTERM`/`SIGINT` trigger a graceful
shutdown: stop accepting, close sessions with `1001 server_shutdown`, wait ≤1.5 s,
force-close stragglers, log `shutdown_complete`.

## Docker / compose contract

| Item | Value |
|---|---|
| Build context | `./relay-go` |
| Image | `ddnet-relay-go:dev` |
| Runtime base | `alpine:3.20` (busybox `wget` + `sh`) |
| Binary | `/usr/local/bin/relay` (static, non-root user `relay`) |
| Port | `8390` (`EXPOSE`, listens `0.0.0.0` via `RELAY_HOST`) |
| Healthcheck | `wget -q -O /dev/null "http://127.0.0.1:${RELAY_PORT:-8390}/healthz"` |
| Sample configs | `/app/config/{relay.config.json,relay.dev-lan.json,servers.example.json}` |

The base images default to the `dockerproxy.net` mirror because this sandbox
cannot reach `registry-1.docker.io`; both are `ARG`s, so on a normal registry
build with:

```bash
docker build \
  --build-arg BUILDER_IMAGE=golang:1.24-alpine \
  --build-arg RUNTIME_IMAGE=alpine:3.20 \
  -t ddnet-relay-go:dev .
```

## Tests

```bash
# Unit + integration suite (64 cases) inside the toolchain image:
docker run --rm -v "$PWD":/src -w /src \
  dockerproxy.net/library/golang:1.24-alpine \
  sh -c 'gofmt -l . && go vet ./... && go test ./...'
```

Coverage: URL/target parsing, token + Origin auth, SSRF classification/policy/
DNS rebinding, token buckets and per-IP limits, frame codec + RFC 6455 handshake,
config file/env/flag precedence and validation, stats, and an integration suite
that starts the relay and a UDP echo server to exercise byte-identical echo
(1/14/1400 B), HTTP API/CORS/405/HEAD, tokens, Origin, SSRF, frame limits, packet
rate limits (including a sustained ~60 pkt/s client), ping/pong budget, idle
timeout, per-IP limits, unreachable targets, text/empty frame drops and graceful
shutdown.

Real-server end-to-end (Node `ws` client from `../relay`). By default it targets
the DDNet official Tutorial server; for a deterministic local server use the
optional compose profile `local-server` and `RELAY_TARGET=127.0.0.1:8313`.

```bash
# Go relay on 127.0.0.1:8390, target DDNet official Tutorial
./relay --host 127.0.0.1 --port 8390

cd ../relay
RELAY_URL=ws://127.0.0.1:8390 RELAY_TARGET=127.0.0.1:8315 node test/e2e-ddnet.mjs
RELAY_URL=ws://127.0.0.1:8390 RELAY_TARGET=127.0.0.1:8315 node test/e2e-ddnet.mjs --handshake
```

Expected: `inf3` server info (`tag: inf3`, map name), and for `--handshake` a
full 0.6 `CONNECT → CONNECTACCEPT → ACCEPT → NETMSG_INFO` flow followed by server
map data.

## Differences vs. the Node relay / known limitations

1. **WebRTC is pure Go (pion/webrtc)**, so the binary grows to ~11 MB (still a
   single static `CGO_ENABLED=0` executable) and dependencies are vendored.
   ICE uses host candidates by default: localhost/LAN works out of the box.
   For public deployments configure STUN/TURN in `rtc.iceServers` /
   `RTC_ICE_SERVERS`; the frontend receives the same list via `/api/info`
   (`iceServers`) and passes it to `RTCPeerConnection` (game transport and
   latency probe). No TURN server is bundled.
   The game data channel is created with `ordered:false, maxRetransmits:0`
   (UDP-like); DDNet's netcode tolerates loss/duplication. The browser tries
   WebRTC first and automatically falls back to WebSocket if ICE/signaling does
   not complete within ~6 s (or if the relay reports `rtc:false`).
   Set `?transport=ws` on the connection URL to force WebSocket for debugging.
2. **No `permessage-deflate`.** Compression is not negotiated; clients that ask
   for it fall back to uncompressed frames (the wasm client doesn't use it).
3. IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) are normalised to IPv4 before
   classification, so they are blocked as `loopback`/`private` rather than the
   Node relay's `ipv4_mapped` category (same security outcome).
4. Token list handling: any non-empty string is a token (Node parity). The
   config loader trims entries, so whitespace-only tokens configured via JSON/env
   are discarded there.
5. No TLS/HTTP2 in the relay itself — put it behind a reverse proxy for `wss://`.
   `/healthz` and the WebSocket upgrade are plain HTTP/1.1.
6. `maxConnectionsTotal` is enforced against live sessions (same as Node), not a
   lifetime counter; `/api/stats.totalConnections` remains a lifetime counter.

## Layout

```
cmd/relay/main.go          relay flags, config load, signals, master heartbeat
cmd/master/main.go         relay master: registry, WS probe, 15m health check
internal/config            defaults, JSON+env+flag merge, validation, servers
internal/urlparse          /udp/... target parsing, token/origin extraction
internal/auth              constant-time tokens, Origin allowlist
internal/ssrf              address classification, allowlist, pinned DNS resolve
internal/ratelimit         token buckets, per-IP limiter, frame guard
internal/wsproto           RFC 6455 handshake, frame codec, ping/pong/close
internal/relay             HTTP API, upgrade path, /ws health probe, WS↔UDP sessions
internal/master            relay registry, /v1 API, WS probe, health checker
internal/relaymaster       relay-side registration/heartbeat client
internal/stats             aggregate counters for /api/stats
internal/logx              structured JSON line logger
relay.config.json          sample config (loopback DDNet on 127.0.0.1:8313)
relay.dev-lan.json         LAN dev config (0.0.0.0, 16 conns/IP)
servers.example.json       recommended-servers example
```
