package relaymaster

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ddnet-relay-go/internal/config"
)

func testConfig(masterURL string) config.Config {
	cfg := config.Default()
	cfg.Name = "Test Relay"
	cfg.Region = "EU"
	cfg.Master.Domain = masterURL
	cfg.Master.AdvertiseURL = "wss://relay.example.com"
	cfg.Master.IntervalMs = 30000
	cfg.Master.TimeoutMs = 2000
	cfg.RTC.UDPPort = 8390
	return cfg
}

func TestRegisterOnce(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/register" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"intervalMs":60000,"healthCheckMs":900000}`))
	}))
	defer server.Close()

	cfg := testConfig(server.URL)
	client := New(cfg, nil)
	interval, err := client.RegisterOnce(context.Background())
	if err != nil {
		t.Fatalf("RegisterOnce: %v", err)
	}
	if interval != time.Minute {
		t.Fatalf("interval = %v, want 1m", interval)
	}
	if received["url"] != "wss://relay.example.com" || received["name"] != "Test Relay" || received["region"] != "EU" {
		t.Fatalf("payload = %#v", received)
	}
	webrtc, ok := received["webrtc"].(map[string]any)
	if !ok || webrtc["enabled"] != true || webrtc["udpPort"] != float64(8390) ||
		webrtc["host"] != "relay.example.com" || webrtc["signalUrl"] != "https://relay.example.com/rtc/offer" {
		t.Fatalf("webrtc payload = %#v", received["webrtc"])
	}
	transports, _ := received["transports"].([]any)
	if len(transports) != 2 || transports[0] != "websocket" || transports[1] != "webrtc" {
		t.Fatalf("transports payload = %#v", received["transports"])
	}
}

func TestRunSkipsTokenRelay(t *testing.T) {
	registerRequests := 0
	unregisterRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/register":
			registerRequests++
		case "/v1/unregister":
			unregisterRequests++
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	cfg := testConfig(server.URL)
	cfg.Auth.Tokens = []string{"secret"}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		New(cfg, nil).Run(ctx)
		close(done)
	}()
	time.Sleep(80 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop")
	}
	if registerRequests != 0 {
		t.Fatalf("token relay sent %d registration requests", registerRequests)
	}
	if unregisterRequests != 1 {
		t.Fatalf("token relay should remove a stale entry once, got %d unregister requests", unregisterRequests)
	}
}

func TestRegisterFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "probe failed", http.StatusBadGateway)
	}))
	defer server.Close()
	cfg := testConfig(server.URL)
	if _, err := New(cfg, nil).RegisterOnce(context.Background()); err == nil {
		t.Fatal("expected registration error")
	}
}
