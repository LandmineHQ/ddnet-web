# Multi-stage build for the Go WSS -> UDP relay.
#
# The builder/runtime images are parameterised because this sandbox can only
# reach the dockerproxy.net mirror (registry-1.docker.io is blocked). On a
# normal registry build with:
#   docker build \
#     --build-arg BUILDER_IMAGE=golang:1.24-alpine \
#     --build-arg RUNTIME_IMAGE=alpine:3.20 \
#     -t ddnet-relay-go:dev .
ARG BUILDER_IMAGE=dockerproxy.net/library/golang:1.24-alpine
ARG RUNTIME_IMAGE=dockerproxy.net/library/alpine:3.20

FROM ${BUILDER_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOOS=linux
COPY go.mod go.sum ./
COPY vendor ./vendor
COPY cmd ./cmd
COPY internal ./internal
# Dependencies are vendored (pion/webrtc) so the image build needs no network.
# -trimpath + -s -w: reproducible, small static binary (no libc).
RUN go build -mod=vendor -trimpath -ldflags="-s -w" -o /out/relay ./cmd/relay

FROM ${RUNTIME_IMAGE}
RUN addgroup -S relay && adduser -S -G relay -h /app relay
WORKDIR /app
COPY --from=build /out/relay /usr/local/bin/relay
COPY relay.config.json relay.dev-lan.json servers.example.json /app/config/
# The checkout may have a restrictive umask; make the samples readable by the
# unprivileged runtime user (id 100).
RUN chmod -R a+rX /app/config
# Listen on all interfaces inside the container by default; the compose/dev
# setup can override with RELAY_HOST / RELAY_PORT or --host/--port.
ENV RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8390
USER relay
EXPOSE 8390
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
	CMD wget -q -O /dev/null "http://127.0.0.1:${RELAY_PORT:-8390}/healthz" || exit 1
ENTRYPOINT ["/usr/local/bin/relay"]
