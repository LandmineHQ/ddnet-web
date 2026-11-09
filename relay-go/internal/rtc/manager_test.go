package rtc

import (
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"ddnet-relay-go/internal/config"
	"ddnet-relay-go/internal/logx"
	"ddnet-relay-go/internal/ssrf"
	"ddnet-relay-go/internal/urlparse"
)

func testConfig() config.RTC {
	return config.RTC{
		Enabled:                 true,
		MaxPeers:                8,
		MaxLifetimeMs:           5000,
		MaxOfferBytes:           262144,
		MaxOffersPerIPPerMinute: 600,
		OfferBurst:              60,
		GatherTimeoutMs:         3000,
	}
}

func newManager(t *testing.T) *Manager {
	t.Helper()
	return New(testConfig(), logx.New(logx.Error, nil), Options{IdleTimeoutMs: 5000, MaxPendingPackets: 64})
}

type clientPeer struct {
	pc      *webrtc.PeerConnection
	dc      *webrtc.DataChannel
	offer   string
	opened  chan struct{}
	recv    chan webrtc.DataChannelMessage
	closed  chan struct{}
	openErr error
}

func newClientPeer(t *testing.T, init *webrtc.DataChannelInit) *clientPeer {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("client NewPeerConnection: %v", err)
	}
	dc, err := pc.CreateDataChannel("test", init)
	if err != nil {
		t.Fatalf("CreateDataChannel: %v", err)
	}
	cp := &clientPeer{
		pc:     pc,
		dc:     dc,
		opened: make(chan struct{}),
		recv:   make(chan webrtc.DataChannelMessage, 16),
		closed: make(chan struct{}),
	}
	dc.OnOpen(func() { close(cp.opened) })
	dc.OnMessage(func(msg webrtc.DataChannelMessage) { cp.recv <- msg })
	dc.OnClose(func() { close(cp.closed) })
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("SetLocalDescription: %v", err)
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second):
		t.Fatal("client ICE gathering timed out")
	}
	cp.offer = pc.LocalDescription().SDP
	return cp
}

func (cp *clientPeer) finish(t *testing.T, answer string) {
	t.Helper()
	if err := cp.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatalf("SetRemoteDescription(answer): %v", err)
	}
	select {
	case <-cp.opened:
	case <-time.After(10 * time.Second):
		t.Fatal("data channel did not open")
	}
}

func (cp *clientPeer) close() { _ = cp.pc.Close() }

func startUDPEcho(t *testing.T) (int, func()) {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("ListenUDP: %v", err)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 65535)
		for {
			n, addr, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_, _ = conn.WriteToUDP(buf[:n], addr)
		}
	}()
	return conn.LocalAddr().(*net.UDPAddr).Port, func() {
		_ = conn.Close()
		wg.Wait()
	}
}

func TestEchoOffer(t *testing.T) {
	m := newManager(t)
	defer m.Close()
	client := newClientPeer(t, nil)
	defer client.close()
	answer, err := m.HandleOffer(client.offer, "127.0.0.1")
	if err != nil {
		t.Fatalf("HandleOffer: %v", err)
	}
	client.finish(t, answer)

	if err := client.dc.SendText("ping"); err != nil {
		t.Fatalf("SendText: %v", err)
	}
	select {
	case msg := <-client.recv:
		if !msg.IsString || string(msg.Data) != "ping" {
			t.Fatalf("echo = %q string=%v", msg.Data, msg.IsString)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("text echo timed out")
	}
	binary := []byte{0xff, 0x00, 0x01, 0xfe}
	if err := client.dc.Send(binary); err != nil {
		t.Fatalf("Send binary: %v", err)
	}
	select {
	case msg := <-client.recv:
		if msg.IsString || string(msg.Data) != string(binary) {
			t.Fatalf("binary echo = %v string=%v", msg.Data, msg.IsString)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("binary echo timed out")
	}
	if m.Available() != true || m.MessagesEchoed.Load() != 2 {
		t.Fatalf("counters available=%v echoed=%d", m.Available(), m.MessagesEchoed.Load())
	}
}

func TestGameOfferBridgesUDP(t *testing.T) {
	echoPort, stop := startUDPEcho(t)
	defer stop()

	m := newManager(t)
	defer m.Close()
	ordered := false
	client := newClientPeer(t, &webrtc.DataChannelInit{Ordered: &ordered})
	defer client.close()

	target := urlparse.Target{Host: "127.0.0.1", Port: echoPort}
	resolved := ssrf.Resolved{Host: "127.0.0.1", Address: netip.MustParseAddr("127.0.0.1"), Family: 4}
	answer, err := m.HandleGameOffer(client.offer, "127.0.0.1", target, resolved)
	if err != nil {
		t.Fatalf("HandleGameOffer: %v", err)
	}
	client.finish(t, answer)

	payload := []byte{0xde, 0xad, 0xbe, 0xef, 0x01}
	if err := client.dc.Send(payload); err != nil {
		t.Fatalf("Send: %v", err)
	}
	select {
	case msg := <-client.recv:
		if msg.IsString || string(msg.Data) != string(payload) {
			t.Fatalf("udp echo = %v string=%v", msg.Data, msg.IsString)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("UDP echo through data channel timed out")
	}
	if m.GamePacketsTo.Load() != 1 || m.GamePacketsFrom.Load() != 1 {
		t.Fatalf("game counters to=%d from=%d", m.GamePacketsTo.Load(), m.GamePacketsFrom.Load())
	}
	if m.GameSessions.Load() != 1 || m.GameSessionsActive.Load() != 1 {
		t.Fatalf("game sessions total=%d active=%d", m.GameSessions.Load(), m.GameSessionsActive.Load())
	}
}

func TestOfferRateLimit(t *testing.T) {
	cfg := testConfig()
	cfg.MaxOffersPerIPPerMinute = 1
	cfg.OfferBurst = 1
	m := New(cfg, logx.New(logx.Error, nil), Options{})
	defer m.Close()
	client := newClientPeer(t, nil)
	defer client.close()
	if _, err := m.HandleOffer(client.offer, "203.0.113.7"); err != nil {
		t.Fatalf("first offer: %v", err)
	}
	second := newClientPeer(t, nil)
	defer second.close()
	if _, err := m.HandleOffer(second.offer, "203.0.113.7"); err == nil {
		t.Fatal("second offer should be rate limited")
	}
}
