package relay_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"ddnet-relay-go/internal/config"
	"ddnet-relay-go/internal/relay"
	"ddnet-relay-go/internal/wsproto"
)

func targetAddr(port int) string { return "127.0.0.1:" + strconv.Itoa(port) }

func TestUDPEchoRoundTrip(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, func(cfg *config.Config) {
		cfg.Auth.Tokens = []string{"secret"}
	}, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port))+"?token=secret", nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	defer client.close()

	client.expectEcho([]byte{0x01}, 2*time.Second)
	client.expectEcho([]byte{0xff, 0xff, 0xff, 0xff, 'g', 'i', 'e', '3', 0x00}, 2*time.Second)
	client.expectEcho(bytes.Repeat([]byte{0xab}, 1400), 2*time.Second)
}

func TestUDPTargetForms(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, nil, nil)
	client, status, body := dialWS(t, tr.wsBase+"/udp?target="+targetAddr(echo.port), nil)
	if client == nil {
		t.Fatalf("query target upgrade failed: %d %v", status, body)
	}
	client.expectEcho([]byte("query-form"), 2*time.Second)
	client.close()

	client, status, body = dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port))+"?protocol=7&sevenup=1&token=", nil)
	if client == nil {
		t.Fatalf("path target with unknown query failed: %d %v", status, body)
	}
	client.expectEcho([]byte("path-form"), 2*time.Second)
	client.close()
}

func TestHTTPEndpoints(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, func(cfg *config.Config) {
		cfg.Auth.Tokens = []string{"stats-secret"}
		cfg.Servers = []config.Server{{Name: "Local echo", Host: "127.0.0.1", Port: echo.port, Note: "test"}}
	}, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port))+"?token=stats-secret", nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	defer client.close()

	status, headers, health := getJSON(t, tr.httpBase+"/healthz")
	if status != http.StatusOK {
		t.Fatalf("/healthz status = %d", status)
	}
	if headers.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("/healthz CORS = %q", headers.Get("Access-Control-Allow-Origin"))
	}
	if health["status"] != "ok" || health["service"] != "ddnet-ws-relay" {
		t.Fatalf("/healthz body = %v", health)
	}
	if health["activeConnections"] != float64(1) {
		t.Fatalf("/healthz activeConnections = %v", health["activeConnections"])
	}
	if health["rtc"] != true {
		t.Fatalf("/healthz rtc = %v", health["rtc"])
	}
	address, ok := health["address"].(map[string]any)
	if !ok || address["port"] == nil {
		t.Fatalf("/healthz address = %v", health["address"])
	}

	status, _, info := getJSON(t, tr.httpBase+"/api/info")
	if status != http.StatusOK {
		t.Fatalf("/api/info status = %d", status)
	}
	if info["protocol"] != "ws-udp-datagram/1" || info["rtc"] != true || info["name"] != "Test Relay" {
		t.Fatalf("/api/info body = %v", info)
	}

	status, _, statsBody := getJSON(t, tr.httpBase+"/api/stats")
	if status != http.StatusOK {
		t.Fatalf("/api/stats status = %d", status)
	}
	if statsBody["activeConnections"] != float64(1) || statsBody["totalConnections"] != float64(1) {
		t.Fatalf("/api/stats counters = %v / %v", statsBody["activeConnections"], statsBody["totalConnections"])
	}
	limits, ok := statsBody["limits"].(map[string]any)
	if !ok || limits["maxFrameBytes"] != float64(2048) {
		t.Fatalf("/api/stats limits = %v", statsBody["limits"])
	}
	statsConfig, ok := statsBody["config"].(map[string]any)
	if !ok {
		t.Fatalf("/api/stats config missing: %v", statsBody)
	}
	authConfig, _ := statsConfig["auth"].(map[string]any)
	if authConfig["tokensConfigured"] != float64(1) {
		t.Fatalf("/api/stats config.auth = %v", authConfig)
	}
	if statsConfig["udpPath"] != "/udp" {
		t.Fatalf("/api/stats config.udpPath = %v", statsConfig["udpPath"])
	}
	serialized, _ := json.Marshal(statsBody)
	if strings.Contains(string(serialized), "stats-secret") {
		t.Fatal("/api/stats leaks token values")
	}
	targets, ok := statsBody["targets"].([]any)
	if !ok || len(targets) != 1 {
		t.Fatalf("/api/stats targets = %v", statsBody["targets"])
	}
	targetEntry, _ := targets[0].(map[string]any)
	if targetEntry["target"] != targetAddr(echo.port) {
		t.Fatalf("/api/stats target = %v", targetEntry)
	}

	status, _, servers := getJSON(t, tr.httpBase+"/api/servers")
	if status != http.StatusOK || servers["count"] != float64(1) {
		t.Fatalf("/api/servers = %d %v", status, servers)
	}
	serverList, _ := servers["servers"].([]any)
	firstServer, _ := serverList[0].(map[string]any)
	if firstServer["name"] != "Local echo" || firstServer["address"] != targetAddr(echo.port) {
		t.Fatalf("/api/servers entry = %v", firstServer)
	}
	if servers["generatedAt"] == "" {
		t.Fatal("/api/servers missing generatedAt")
	}

	status, _, missing := getJSON(t, tr.httpBase+"/nope")
	if status != http.StatusNotFound || missing["code"] != "not_found" {
		t.Fatalf("/nope = %d %v", status, missing)
	}

	// OPTIONS preflight.
	request, _ := http.NewRequest(http.MethodOptions, tr.httpBase+"/api/info", nil)
	request.Header.Set("Origin", "https://frontend.example")
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		t.Fatalf("OPTIONS: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("OPTIONS status = %d", response.StatusCode)
	}
	if response.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("OPTIONS CORS = %q", response.Header.Get("Access-Control-Allow-Origin"))
	}
	if response.Header.Get("Access-Control-Max-Age") != "600" {
		t.Fatalf("OPTIONS max-age = %q", response.Header.Get("Access-Control-Max-Age"))
	}
	if !strings.Contains(response.Header.Get("Access-Control-Allow-Methods"), "GET") {
		t.Fatalf("OPTIONS methods = %q", response.Header.Get("Access-Control-Allow-Methods"))
	}

	// POST to a GET-only API returns 405 with a JSON error.
	status, postHeaders, postBody := postJSON(t, tr.httpBase+"/api/info", nil, "{}")
	if status != http.StatusMethodNotAllowed || postBody["code"] != "method_not_allowed" {
		t.Fatalf("POST /api/info = %d %v", status, postBody)
	}
	if !strings.Contains(postHeaders.Get("Allow"), "GET") {
		t.Fatalf("POST /api/info Allow = %q", postHeaders.Get("Allow"))
	}

	// HEAD returns headers without a body.
	headRequest, _ := http.NewRequest(http.MethodHead, tr.httpBase+"/healthz", nil)
	headResponse, err := (&http.Client{Timeout: 5 * time.Second}).Do(headRequest)
	if err != nil {
		t.Fatalf("HEAD: %v", err)
	}
	headBody, _ := io.ReadAll(headResponse.Body)
	headResponse.Body.Close()
	if headResponse.StatusCode != http.StatusOK || len(headBody) != 0 {
		t.Fatalf("HEAD /healthz = %d body=%d", headResponse.StatusCode, len(headBody))
	}
	if headResponse.ContentLength <= 0 {
		t.Fatalf("HEAD /healthz Content-Length = %d", headResponse.ContentLength)
	}
}

func TestTokenAuthentication(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, func(cfg *config.Config) { cfg.Auth.Tokens = []string{"s3cret"} }, nil)
	target := targetAddr(echo.port)

	if _, status, body := dialWS(t, wsURL(tr.wsBase, target), nil); status != http.StatusUnauthorized || body["code"] != "unauthorized" {
		t.Fatalf("missing token = %d %v", status, body)
	}
	if _, status, _ := dialWS(t, wsURL(tr.wsBase, target)+"?token=wrong", nil); status != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d", status)
	}

	headers := http.Header{}
	headers.Set("Authorization", "Bearer s3cret")
	client, status, body := dialWS(t, wsURL(tr.wsBase, target), headers)
	if client == nil {
		t.Fatalf("bearer token upgrade failed: %d %v", status, body)
	}
	client.expectEcho([]byte("hello"), 2*time.Second)
	client.close()

	client, status, body = dialWS(t, wsURL(tr.wsBase, target)+"?token=s3cret", nil)
	if client == nil {
		t.Fatalf("query token upgrade failed: %d %v", status, body)
	}
	client.close()

	// The custom token header must work as well.
	headers = http.Header{}
	headers.Set("x-relay-token", "s3cret")
	client, status, body = dialWS(t, wsURL(tr.wsBase, target), headers)
	if client == nil {
		t.Fatalf("x-relay-token upgrade failed: %d %v", status, body)
	}
	client.close()
}

func TestOriginAllowlist(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, func(cfg *config.Config) {
		cfg.Auth.OriginAllowlist = []string{"https://relay.example.com"}
	}, nil)
	target := wsURL(tr.wsBase, targetAddr(echo.port))

	headers := http.Header{}
	headers.Set("Origin", "https://evil.example.com")
	_, status, body := dialWS(t, target, headers)
	if status != http.StatusForbidden || body["code"] != "origin_denied" {
		t.Fatalf("unknown origin = %d %v", status, body)
	}

	allowed := http.Header{}
	allowed.Set("Origin", "https://relay.example.com")
	client, status, body := dialWS(t, target, allowed)
	if client == nil {
		t.Fatalf("allowed origin rejected: %d %v", status, body)
	}
	client.close()

	// Missing Origin is allowed by default.
	client, status, body = dialWS(t, target, nil)
	if client == nil {
		t.Fatalf("missing origin rejected: %d %v", status, body)
	}
	client.close()

	// ...but not when allowNoOrigin=false.
	strict := startRelay(t, func(cfg *config.Config) {
		cfg.Auth.OriginAllowlist = []string{"https://relay.example.com"}
		cfg.Auth.AllowNoOrigin = false
	}, nil)
	_, status, body = dialWS(t, wsURL(strict.wsBase, targetAddr(echo.port)), nil)
	if status != http.StatusForbidden || body["code"] != "origin_denied" {
		t.Fatalf("missing origin with allowNoOrigin=false = %d %v", status, body)
	}
}

func TestSSRFProtection(t *testing.T) {
	echo := startEcho(t)
	target := targetAddr(echo.port)

	blocked := startRelay(t, func(cfg *config.Config) {
		cfg.Security.AllowPrivate = false
		cfg.Security.Allowlist = nil
	}, nil)
	_, status, body := dialWS(t, wsURL(blocked.wsBase, target), nil)
	if status != http.StatusForbidden || body["code"] != "target_not_allowed" {
		t.Fatalf("loopback target = %d %v", status, body)
	}
	if message, _ := body["error"].(string); !strings.Contains(message, "loopback") {
		t.Fatalf("error message misses category: %v", body["error"])
	}

	allowed := startRelay(t, func(cfg *config.Config) {
		cfg.Security.Allowlist = []string{"127.0.0.1/32"}
	}, nil)
	client, status, body := dialWS(t, wsURL(allowed.wsBase, target), nil)
	if client == nil {
		t.Fatalf("allowlisted loopback rejected: %d %v", status, body)
	}
	client.expectEcho([]byte("allowed"), 2*time.Second)
	client.close()

	// DNS answer pointing at a metadata service is blocked.
	rebinding := startRelay(t, func(cfg *config.Config) {
		cfg.Security.AllowPrivate = false
		cfg.Security.Allowlist = nil
	}, func(ctx context.Context, host string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("169.254.169.254")}, nil
	})
	_, status, body = dialWS(t, wsURL(rebinding.wsBase, "metadata.example.com:80"), nil)
	if status != http.StatusForbidden || body["code"] != "target_not_allowed" {
		t.Fatalf("metadata DNS target = %d %v", status, body)
	}
}

func TestFrameSizeLimit(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, nil, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	defer client.close()

	// Oversized frame is dropped, the connection survives.
	client.send(bytes.Repeat([]byte{0x11}, 3000))
	client.expectEcho(bytes.Repeat([]byte{0x22}, 64), 2*time.Second)
	client.expectEcho(bytes.Repeat([]byte{0x33}, 2048), 2*time.Second)

	snapshot := tr.stats.Snapshot()
	if snapshot.DroppedFrames < 1 {
		t.Fatalf("droppedFrames = %d", snapshot.DroppedFrames)
	}
	if snapshot.DropsByReason["frame_too_large"] < 1 {
		t.Fatalf("frame_too_large drop missing: %v", snapshot.DropsByReason)
	}
}

func TestHardFrameLimit(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, nil, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	_ = client.ws.WriteMessage(wsproto.OpBinary, bytes.Repeat([]byte{0x44}, 70000))
	code, reason, err := client.waitClose(3 * time.Second)
	if err != nil {
		t.Fatalf("waiting for close: %v", err)
	}
	if code != 1011 || reason != "ws_error" {
		t.Fatalf("hard-limit close = %d %q", code, reason)
	}
	if tr.stats.Snapshot().DropsByReason["frame_hard_limit"] < 1 {
		t.Fatalf("frame_hard_limit drop missing: %v", tr.stats.Snapshot().DropsByReason)
	}
}

func TestPacketRateLimit(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, func(cfg *config.Config) {
		cfg.Limits.MaxPacketsPerSecond = 2
		cfg.Limits.PacketBurst = 2
	}, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	defer client.close()

	for i := 0; i < 10; i++ {
		client.send([]byte{byte(i)})
	}
	received := 0
	for {
		if _, err := client.readBinary(250 * time.Millisecond); err != nil {
			break
		}
		received++
	}
	if received > 4 {
		t.Fatalf("expected at most 4 echoed packets, got %d", received)
	}
	if tr.stats.Snapshot().DropsByReason["packet_rate"] < 6 {
		t.Fatalf("packet_rate drops = %v", tr.stats.Snapshot().DropsByReason)
	}
}

func TestSustainedClientRateNotLimited(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, nil, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	defer client.close()

	const total = 60
	started := time.Now()
	for i := 0; i < total; i++ {
		client.send(bytes.Repeat([]byte{byte(i)}, 64))
		// ~62.5 packets/s, i.e. DDNet's per-tick client send rate.
		elapsed := time.Since(started)
		slot := time.Duration(i+1)*16*time.Millisecond - elapsed
		if slot > 0 {
			time.Sleep(slot)
		}
	}
	received := 0
	deadline := time.Now().Add(3 * time.Second)
	for received < total && time.Now().Before(deadline) {
		if _, err := client.readBinary(500 * time.Millisecond); err != nil {
			break
		}
		received++
	}
	if received != total {
		t.Fatalf("expected %d echoes, got %d", total, received)
	}
	snapshot := tr.stats.Snapshot()
	if snapshot.PacketsToTarget != total || snapshot.PacketsFromTarget != total {
		t.Fatalf("packet counters = %d -> %d", snapshot.PacketsToTarget, snapshot.PacketsFromTarget)
	}
	if snapshot.DropsByReason["packet_rate"] != 0 || snapshot.DropsByReason["byte_rate"] != 0 {
		t.Fatalf("unexpected rate drops: %v", snapshot.DropsByReason)
	}
}

func TestPingPongDoesNotSpendRateBudget(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, func(cfg *config.Config) {
		cfg.Limits.MaxPacketsPerSecond = 1
		cfg.Limits.PacketBurst = 2
		cfg.Limits.PingIntervalMs = 100
		cfg.Limits.IdleTimeoutMs = 0
	}, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	defer client.close()

	client.expectEcho([]byte("a"), 2*time.Second)
	client.expectEcho([]byte("b"), 2*time.Second)
	time.Sleep(1500 * time.Millisecond)
	client.expectEcho([]byte("c"), 2*time.Second)
	if drops := tr.stats.Snapshot().DropsByReason["packet_rate"]; drops != 0 {
		t.Fatalf("ping/pong consumed packet budget: %v", tr.stats.Snapshot().DropsByReason)
	}
}

func TestIdleTimeout(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, func(cfg *config.Config) {
		cfg.Limits.IdleTimeoutMs = 200
		cfg.Limits.PingIntervalMs = 0
	}, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	code, reason, err := client.waitClose(3 * time.Second)
	if err != nil {
		t.Fatalf("waiting for idle close: %v", err)
	}
	if code != 1001 || reason != "idle_timeout" {
		t.Fatalf("idle close = %d %q", code, reason)
	}
	if tr.stats.Snapshot().CloseReasons["idle_timeout"] != 1 {
		t.Fatalf("close reasons = %v", tr.stats.Snapshot().CloseReasons)
	}
}

func TestPerIPConnectionLimit(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, func(cfg *config.Config) {
		cfg.Limits.MaxConnectionsPerIP = 1
		cfg.Limits.MaxConnectionsTotal = 10
	}, nil)
	url := wsURL(tr.wsBase, targetAddr(echo.port))
	first, status, body := dialWS(t, url, nil)
	if first == nil {
		t.Fatalf("first connection failed: %d %v", status, body)
	}
	_, status, body = dialWS(t, url, nil)
	if status != http.StatusTooManyRequests || body["code"] != "too_many_connections" {
		t.Fatalf("second connection = %d %v", status, body)
	}
	first.close()

	var third *wsClient
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		candidate, status, body := dialWS(t, url, nil)
		if candidate != nil {
			third = candidate
			break
		}
		if status != http.StatusTooManyRequests {
			t.Fatalf("reconnect failed unexpectedly: %d %v", status, body)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if third == nil {
		t.Fatal("could not reconnect after releasing the IP slot")
	}
	third.close()
}

func TestUnreachableTargetClosesWith1011(t *testing.T) {
	echo := startEcho(t)
	port := echo.port
	echo.close()
	tr := startRelay(t, nil, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = client.ws.WriteMessage(wsproto.OpBinary, []byte("ping"))
			}
		}
	}()
	code, reason, err := client.waitClose(4 * time.Second)
	if err != nil {
		t.Fatalf("waiting for close: %v", err)
	}
	if code != 1011 || reason != "target_unreachable" {
		t.Fatalf("unreachable close = %d %q", code, reason)
	}
	if tr.stats.Snapshot().CloseReasons["target_unreachable"] != 1 {
		t.Fatalf("close reasons = %v", tr.stats.Snapshot().CloseReasons)
	}
	// The relay keeps serving HTTP afterwards.
	status, _, health := getJSON(t, tr.httpBase+"/healthz")
	if status != http.StatusOK || health["status"] != "ok" {
		t.Fatalf("relay unhealthy after unreachable target: %d %v", status, health)
	}
}

func TestGracefulShutdown(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, nil, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	client.expectEcho([]byte("before-shutdown"), 2*time.Second)

	if err := tr.srv.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	code, reason, err := client.waitClose(2 * time.Second)
	if err != nil {
		t.Fatalf("waiting for shutdown close: %v", err)
	}
	if code != 1001 || reason != "server_shutdown" {
		t.Fatalf("shutdown close = %d %q", code, reason)
	}
	if tr.srv.SessionsCount() != 0 {
		t.Fatalf("sessions remain after shutdown: %d", tr.srv.SessionsCount())
	}
	if err := tr.srv.Shutdown(context.Background()); err != nil {
		t.Fatalf("second Shutdown should be a no-op: %v", err)
	}
}

func TestTextAndEmptyFramesAreDropped(t *testing.T) {
	echo := startEcho(t)
	tr := startRelay(t, nil, nil)
	client, status, body := dialWS(t, wsURL(tr.wsBase, targetAddr(echo.port)), nil)
	if client == nil {
		t.Fatalf("upgrade failed: %d %v", status, body)
	}
	defer client.close()

	client.sendText([]byte("hello"))
	client.send([]byte{})
	client.expectEcho([]byte("after-drops"), 2*time.Second)

	drops := tr.stats.Snapshot().DropsByReason
	if drops["text_frame"] < 1 || drops["empty_frame"] < 1 {
		t.Fatalf("drops = %v", drops)
	}
}

func TestRTCOfferValidationAndAuth(t *testing.T) {
	tr := startRelay(t, nil, nil)
	// A syntactically invalid SDP reaches WebRTC and is rejected as invalid_offer.
	status, headers, body := postJSON(t, tr.httpBase+"/rtc/offer", http.Header{"Content-Type": []string{"application/json"}}, `{"type":"offer","sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"}`)
	if status != http.StatusBadRequest || body["code"] != "invalid_offer" {
		t.Fatalf("/rtc/offer = %d %v", status, body)
	}
	if headers.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("/rtc/offer CORS = %q", headers.Get("Access-Control-Allow-Origin"))
	}

	disabled := startRelay(t, func(cfg *config.Config) { cfg.RTC.Enabled = false }, nil)
	status, _, body = postJSON(t, disabled.httpBase+"/rtc/offer", nil, "{}")
	if status != http.StatusServiceUnavailable || body["code"] != "rtc_disabled" {
		t.Fatalf("disabled /rtc/offer = %d %v", status, body)
	}

	secured := startRelay(t, func(cfg *config.Config) {
		cfg.Auth.Tokens = []string{"rtc-secret"}
		cfg.Auth.OriginAllowlist = []string{"https://allowed.example"}
	}, nil)
	status, _, body = postJSON(t, secured.httpBase+"/rtc/offer", nil, "{}")
	if status != http.StatusUnauthorized || body["code"] != "unauthorized" {
		t.Fatalf("unauthenticated /rtc/offer = %d %v", status, body)
	}
	headers = http.Header{}
	headers.Set("Origin", "https://evil.example")
	status, _, body = postJSON(t, secured.httpBase+"/rtc/offer", headers, "{}")
	if status != http.StatusForbidden || body["code"] != "origin_denied" {
		t.Fatalf("bad-origin /rtc/offer = %d %v", status, body)
	}
	headers.Set("Origin", "https://allowed.example")
	headers.Set("Authorization", "Bearer rtc-secret")
	status, _, body = postJSON(t, secured.httpBase+"/rtc/offer", headers, "{}")
	if status != http.StatusBadRequest || body["code"] != "invalid_offer" {
		t.Fatalf("authenticated /rtc/offer = %d %v", status, body)
	}
}

func TestAPIDisabled(t *testing.T) {
	tr := startRelay(t, func(cfg *config.Config) {
		cfg.API.StatsEnabled = false
		cfg.API.ServersEnabled = false
	}, nil)
	for _, path := range []string{"/api/stats", "/api/servers"} {
		status, _, body := getJSON(t, tr.httpBase+path)
		if status != http.StatusNotFound || body["code"] != "not_found" {
			t.Fatalf("%s = %d %v", path, status, body)
		}
	}
}

func TestGetClientIPTrustProxy(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "[::ffff:127.0.0.1]:54321"
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	if got := relay.GetClientIP(request, false); got != "127.0.0.1" {
		t.Fatalf("trustProxy=false = %q", got)
	}
	if got := relay.GetClientIP(request, true); got != "203.0.113.9" {
		t.Fatalf("trustProxy=true = %q", got)
	}

	garbage := httptest.NewRequest(http.MethodGet, "/", nil)
	garbage.RemoteAddr = "127.0.0.1:1234"
	garbage.Header.Set("X-Forwarded-For", "garbage")
	if got := relay.GetClientIP(garbage, true); got != "127.0.0.1" {
		t.Fatalf("garbage XFF = %q", got)
	}
}
