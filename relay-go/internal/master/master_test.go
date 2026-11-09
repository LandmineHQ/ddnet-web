package master

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func testWSRelay(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws" {
			http.NotFound(w, r)
			return
		}
		key := r.Header.Get("Sec-WebSocket-Key")
		if key == "" {
			http.Error(w, "missing key", http.StatusBadRequest)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("hijacker unavailable")
		}
		conn, buffered, err := hijacker.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		defer conn.Close()
		sum := sha1.Sum([]byte(key + websocketGUID))
		accept := base64.StdEncoding.EncodeToString(sum[:])
		fmt.Fprintf(buffered, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
		_ = buffered.Flush()
	}))
	t.Cleanup(server.Close)
	return server, "ws" + strings.TrimPrefix(server.URL, "http")
}

func testRTCRelay(t *testing.T) string {
	t.Helper()
	var mu sync.Mutex
	var peers []*webrtc.PeerConnection
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rtc/offer" {
			http.NotFound(w, r)
			return
		}
		var req struct {
			Type string `json:"type"`
			SDP  string `json:"sdp"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SDP == "" {
			http.Error(w, "bad offer", http.StatusBadRequest)
			return
		}
		pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		pc.OnDataChannel(func(dc *webrtc.DataChannel) {
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				_ = dc.Send(msg.Data)
			})
		})
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: req.SDP}); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		answer, err := pc.CreateAnswer(nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		gather := webrtc.GatheringCompletePromise(pc)
		if err := pc.SetLocalDescription(answer); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		<-gather
		mu.Lock()
		peers = append(peers, pc)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"type": "answer", "sdp": pc.LocalDescription().SDP})
	}))
	t.Cleanup(func() {
		server.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, pc := range peers {
			_ = pc.Close()
		}
	})
	return server.URL + "/rtc/offer"
}

func skipWebRTCIntegration(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("real ICE loopback is not reliable on hosted runners; run go test without -short")
	}
}

func TestProbeWebRTC(t *testing.T) {
	skipWebRTCIntegration(t)
	signalURL := testRTCRelay(t)
	transport := Transport{Type: "webrtc", SignalURL: signalURL, Host: "relay.example.com", UDPPort: 443}
	if err := ProbeWebRTC(context.Background(), transport, 5*time.Second); err != nil {
		t.Fatalf("probe WebRTC: %v", err)
	}
}

func TestNormalizeURL(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"ws://127.0.0.1:8390/", "ws://127.0.0.1:8390", true},
		{"wss://relay.example.com/base/", "wss://relay.example.com/base", true},
		{"http://relay.example.com", "", false},
		{"ws://relay.example.com?token=x", "", false},
		{"ws://user:pass@relay.example.com", "", false},
	}
	for _, tc := range cases {
		got, err := NormalizeURL(tc.in)
		if tc.ok && (err != nil || got != tc.want) {
			t.Errorf("NormalizeURL(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
		}
		if !tc.ok && err == nil {
			t.Errorf("NormalizeURL(%q) expected error", tc.in)
		}
	}
}

func TestProbeWebSocket(t *testing.T) {
	_, relay := testWSRelay(t)
	if err := ProbeWebSocket(context.Background(), relay, 2*time.Second); err != nil {
		t.Fatalf("probe healthy relay: %v", err)
	}
	if err := ProbeWebSocket(context.Background(), "ws://127.0.0.1:1", 300*time.Millisecond); err == nil {
		t.Fatal("probe unreachable relay unexpectedly succeeded")
	}
}

func TestRegistry(t *testing.T) {
	registry := NewRegistry(2)
	wsTransport := Transport{Type: "websocket", URL: "ws://127.0.0.1:8390"}
	keyA, err := NodeKey([]Transport{wsTransport})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Register(Node{Name: "A", Transports: []Transport{wsTransport}}); err != nil {
		t.Fatal(err)
	}
	if len(registry.List()) != 0 {
		t.Fatal("unverified node must not be listed")
	}
	registry.MarkTransportVerified(keyA, wsTransport, time.Now())
	if len(registry.List()) != 1 {
		t.Fatal("verified node missing")
	}
	wsB := Transport{Type: "websocket", URL: "ws://127.0.0.1:8391"}
	if _, err := registry.Register(Node{Name: "B", Transports: []Transport{wsB}}); err != nil {
		t.Fatal(err)
	}
	wsC := Transport{Type: "websocket", URL: "ws://127.0.0.1:8392"}
	if _, err := registry.Register(Node{Name: "C", Transports: []Transport{wsC}}); err == nil {
		t.Fatal("expected registry full error")
	}
	keyB, _ := NodeKey([]Transport{wsB})
	registry.MarkChecked(keyB, time.Now(), false)
	if len(registry.List()) != 1 {
		t.Fatal("unhealthy node must not be listed")
	}
}

func TestHTTPRegisterProbeAndHealth(t *testing.T) {
	wsServer, relayURL := testWSRelay(t)
	registry := NewRegistry(10)
	handler, err := NewHandler(Options{
		Registry:          registry,
		ProbeTimeout:      2 * time.Second,
		ProbeInterval:     50 * time.Millisecond,
		HeartbeatInterval: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	post := func(path string, payload any) (*http.Response, map[string]any) {
		body, _ := json.Marshal(payload)
		response, err := http.Post(server.URL+path, "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var decoded map[string]any
		_ = json.NewDecoder(response.Body).Decode(&decoded)
		return response, decoded
	}

	response, decoded := post("/v1/register", map[string]any{
		"name": "relay",
		"transports": []map[string]any{
			{"type": "websocket", "url": relayURL},
			{"type": "webrtc", "signalUrl": "http://127.0.0.1:1/rtc/offer", "host": "relay.example.com", "udpPort": 3478},
		},
	})
	if response.StatusCode != http.StatusOK || decoded["verified"] != true {
		t.Fatalf("register failed: status=%d body=%v", response.StatusCode, decoded)
	}
	response, decoded = post("/v1/register", map[string]any{
		"name": "relay", "transports": []map[string]any{{"type": "websocket", "url": "ws://127.0.0.1:1"}},
	})
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("unreachable register status=%d body=%v", response.StatusCode, decoded)
	}
	response, decoded = post("/v1/register", map[string]any{
		"name": "bad", "transports": []map[string]any{{"type": "websocket", "url": "http://example.com"}},
	})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid url status=%d body=%v", response.StatusCode, decoded)
	}
	response, decoded = post("/v1/register", map[string]any{
		"name":       "ephemeral-rtc",
		"transports": []map[string]any{{"type": "webrtc", "signalUrl": "https://relay.example.com/rtc/offer", "host": "relay.example.com", "udpPort": 0}},
	})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("ephemeral webrtc port status=%d body=%v", response.StatusCode, decoded)
	}
	response, decoded = post("/v1/register", map[string]any{
		"name":       "no-rtc-host",
		"transports": []map[string]any{{"type": "webrtc", "signalUrl": "https://relay.example.com/rtc/offer", "udpPort": 3478}},
	})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing webrtc host status=%d body=%v", response.StatusCode, decoded)
	}

	listResponse, err := http.Get(server.URL + "/v1/serverlist")
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Count   int    `json:"count"`
		Servers []Node `json:"servers"`
	}
	_ = json.NewDecoder(listResponse.Body).Decode(&list)
	listResponse.Body.Close()
	if list.Count != 1 || len(list.Servers[0].Transports) != 1 || list.Servers[0].Transports[0].URL != relayURL {
		t.Fatalf("serverlist = %+v", list)
	}

	// Existing verified nodes are not re-probed on heartbeat.
	wsServer.Close()
	response, decoded = post("/v1/register", map[string]any{
		"name": "relay2", "transports": []map[string]any{{"type": "websocket", "url": relayURL}},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("re-register should not probe: status=%d body=%v", response.StatusCode, decoded)
	}

	// Periodic health check removes the now-dead relay.
	checked, removed := CheckAll(context.Background(), registry, 300*time.Millisecond, 2, nil)
	if checked != 1 || removed != 1 {
		t.Fatalf("CheckAll checked=%d removed=%d", checked, removed)
	}
	if registry.Count() != 0 {
		t.Fatal("dead relay still registered")
	}
}

func TestHTTPRegisterWebRTCOnly(t *testing.T) {
	skipWebRTCIntegration(t)
	signalURL := testRTCRelay(t)
	registry := NewRegistry(10)
	handler, err := NewHandler(Options{Registry: registry, ProbeTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	body, _ := json.Marshal(map[string]any{
		"name": "rtc-only",
		"transports": []map[string]any{{
			"type": "webrtc", "signalUrl": signalURL,
			"host": "relay.example.com", "udpPort": 443,
		}},
	})
	response, err := http.Post(server.URL+"/v1/register", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	if response.StatusCode != http.StatusOK || decoded["verified"] != true {
		t.Fatalf("webrtc-only register failed: status=%d body=%v", response.StatusCode, decoded)
	}
	listResponse, err := http.Get(server.URL + "/v1/serverlist")
	if err != nil {
		t.Fatal(err)
	}
	defer listResponse.Body.Close()
	var list struct {
		Count   int    `json:"count"`
		Servers []Node `json:"servers"`
	}
	_ = json.NewDecoder(listResponse.Body).Decode(&list)
	if list.Count != 1 || len(list.Servers[0].Transports) != 1 || list.Servers[0].Transports[0].Type != "webrtc" {
		t.Fatalf("webrtc-only serverlist = %+v", list)
	}
}

func TestServerlistRewritesHTTPWebRTCToSignalProxy(t *testing.T) {
	registry := NewRegistry(10)
	transport := Transport{
		Type: "webrtc", SignalURL: "http://127.0.0.1:12345/rtc/offer",
		Host: "relay.example.com", UDPPort: 443,
	}
	key, _ := NodeKey([]Transport{transport})
	if _, err := registry.Register(Node{Name: "rtc-http", Transports: []Transport{transport}}); err != nil {
		t.Fatal(err)
	}
	registry.MarkTransportVerified(key, transport, time.Now())
	handler, _ := NewHandler(Options{Registry: registry, PublicURL: "https://master.example.com"})
	server := httptest.NewServer(handler)
	defer server.Close()
	response, err := http.Get(server.URL + "/v1/serverlist")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var list struct {
		Servers []Node `json:"servers"`
	}
	if err := json.NewDecoder(response.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Servers) != 1 || len(list.Servers[0].Transports) != 1 {
		t.Fatalf("list = %+v", list)
	}
	want := "https://master.example.com/v1/signal/" + SignalID(transport.SignalURL) + "/rtc/offer"
	if got := list.Servers[0].Transports[0].SignalURL; got != want {
		t.Fatalf("signalUrl = %q, want %q", got, want)
	}
}

func TestSignalProxyForHTTPWebRTC(t *testing.T) {
	var gotOrigin, gotToken, gotTarget string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOrigin = r.Header.Get("Origin")
		gotToken = r.Header.Get("X-Relay-Token")
		gotTarget = r.URL.Query().Get("target")
		switch r.URL.Path {
		case "/rtc/offer":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"type":"answer","sdp":"v=0\r\nm=application"}`))
		case "/healthz":
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/api/info":
			_, _ = w.Write([]byte(`{"name":"upstream"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	transport := Transport{
		Type: "webrtc", SignalURL: upstream.URL + "/rtc/offer",
		Host: "relay.example.com", UDPPort: 443,
	}
	registry := NewRegistry(10)
	key, _ := NodeKey([]Transport{transport})
	if _, err := registry.Register(Node{Name: "rtc-http", Transports: []Transport{transport}}); err != nil {
		t.Fatal(err)
	}
	registry.MarkTransportVerified(key, transport, time.Now())
	handler, _ := NewHandler(Options{Registry: registry, PublicURL: "https://master.example.com"})
	server := httptest.NewServer(handler)
	defer server.Close()

	id := SignalID(transport.SignalURL)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/signal/"+id+"/rtc/offer?target=1.2.3.4%3A8303", strings.NewReader(`{"type":"offer","sdp":"v=0"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://play.example.com")
	request.Header.Set("X-Relay-Token", "secret")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"answer"`) {
		t.Fatalf("proxy response status=%d body=%s", response.StatusCode, body)
	}
	if gotOrigin != "https://play.example.com" || gotToken != "secret" || gotTarget != "1.2.3.4:8303" {
		t.Fatalf("forwarded origin=%q token=%q target=%q", gotOrigin, gotToken, gotTarget)
	}
	health, _ := http.Get(server.URL + "/v1/signal/" + id + "/healthz")
	healthBody, _ := io.ReadAll(health.Body)
	health.Body.Close()
	if health.StatusCode != http.StatusOK || string(healthBody) != `{"ok":true}` {
		t.Fatalf("health proxy = %d %s", health.StatusCode, healthBody)
	}
}

func TestCORSAndServerlistHeaders(t *testing.T) {
	registry := NewRegistry(10)
	handler, _ := NewHandler(Options{Registry: registry, CORSOrigins: []string{"*"}})
	server := httptest.NewServer(handler)
	defer server.Close()
	request, _ := http.NewRequest(http.MethodOptions, server.URL+"/v1/register", nil)
	request.Header.Set("Origin", "https://play.example.com")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent || response.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("CORS preflight status=%d headers=%v", response.StatusCode, response.Header)
	}
}

func TestIPLimiter(t *testing.T) {
	limiter := newIPLimiter(2, time.Minute)
	if !limiter.Allow("1.2.3.4") || !limiter.Allow("1.2.3.4") {
		t.Fatal("first two registrations should be allowed")
	}
	if limiter.Allow("1.2.3.4") {
		t.Fatal("third registration should be limited")
	}
	if !limiter.Allow("5.6.7.8") {
		t.Fatal("other IP should be allowed")
	}
}

func TestProbeURL(t *testing.T) {
	got, err := ProbeURL("wss://relay.example.com/base/")
	if err != nil || got != "wss://relay.example.com/base/ws" {
		t.Fatalf("ProbeURL = %q, %v", got, err)
	}
}

// Keep bufio/net imports used in helper signatures for future probe variants.
var _ = bufio.NewReader
var _ net.Conn
