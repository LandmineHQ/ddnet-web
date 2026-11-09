package master

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ddnet-relay-go/internal/logx"

	"github.com/pion/webrtc/v4"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// ProbeURL appends the master health WebSocket path to a relay base URL.
func ProbeURL(base string) (string, error) {
	normalized, err := NormalizeURL(base)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(normalized, "/") + "/ws", nil
}

// ProbeWebSocket performs an RFC 6455 handshake against <relay>/ws. It only
// verifies that the relay accepts WebSocket connections; the connection is
// closed immediately after the 101 response.
func ProbeWebSocket(ctx context.Context, base string, timeout time.Duration) error {
	target, err := ProbeURL(base)
	if err != nil {
		return err
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return err
	}
	port := parsed.Port()
	if port == "" {
		if parsed.Scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(probeCtx, "tcp", net.JoinHostPort(parsed.Hostname(), port))
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if parsed.Scheme == "wss" {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: parsed.Hostname(), MinVersion: tls.VersionTLS12})
		if err := tlsConn.HandshakeContext(probeCtx); err != nil {
			return fmt.Errorf("tls handshake: %w", err)
		}
		conn = tlsConn
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		return err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	path := parsed.EscapedPath()
	if path == "" {
		path = "/ws"
	}
	request := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + parsed.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"User-Agent: ddnet-relay-master/1.0\r\n" +
		"\r\n"
	if _, err := conn.Write([]byte(request)); err != nil {
		return fmt.Errorf("write handshake: %w", err)
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		return fmt.Errorf("read handshake: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		return fmt.Errorf("relay websocket returned HTTP %d", resp.StatusCode)
	}
	if !headerContains(resp.Header, "Upgrade", "websocket") || !headerContains(resp.Header, "Connection", "upgrade") {
		return errors.New("relay did not return a WebSocket upgrade")
	}
	expected := acceptKey(key)
	if got := strings.TrimSpace(resp.Header.Get("Sec-WebSocket-Accept")); got != expected {
		return fmt.Errorf("invalid Sec-WebSocket-Accept: %q", got)
	}
	return nil
}

func acceptKey(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func headerContains(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// ProbeWebRTC creates a real data channel against the relay's /rtc/offer
// endpoint and waits until the peer connection/data channel is open.
func ProbeWebRTC(ctx context.Context, transport Transport, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if transport.SignalURL == "" {
		return errors.New("webrtc.signalUrl is required")
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return fmt.Errorf("create peer connection: %w", err)
	}
	defer pc.Close()
	dc, err := pc.CreateDataChannel("master-probe", nil)
	if err != nil {
		return fmt.Errorf("create data channel: %w", err)
	}
	opened := make(chan struct{})
	var openOnce sync.Once
	dc.OnOpen(func() { openOnce.Do(func() { close(opened) }) })
	connected := make(chan struct{})
	var connOnce sync.Once
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			connOnce.Do(func() { close(connected) })
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}
	select {
	case <-gather:
	case <-probeCtx.Done():
		return fmt.Errorf("ice gathering: %w", probeCtx.Err())
	}
	local := pc.LocalDescription()
	if local == nil {
		return errors.New("no local SDP")
	}
	body, _ := json.Marshal(map[string]string{"type": "offer", "sdp": local.SDP})
	request, err := http.NewRequestWithContext(probeCtx, http.MethodPost, transport.SignalURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "ddnet-relay-master/1.0")
	if transport.Origin != "" {
		request.Header.Set("Origin", transport.Origin)
	}
	client := &http.Client{Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("signaling request: %w", err)
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 256*1024))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("signaling returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	var answer struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}
	if err := json.Unmarshal(responseBody, &answer); err != nil {
		return fmt.Errorf("decode answer: %w", err)
	}
	if answer.SDP == "" {
		return errors.New("signaling answer has no SDP")
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		return fmt.Errorf("set remote description: %w", err)
	}
	select {
	case <-opened:
		return nil
	case <-connected:
		// A connected peer is enough; the relay may not expose the same
		// datachannel callback ordering.
		return nil
	case <-probeCtx.Done():
		return fmt.Errorf("wait for data channel: %w", probeCtx.Err())
	}
}

// CheckAll probes every verified transport of every registered node. Failed
// transports are removed; nodes with no remaining transport are removed.
// It returns the number of checked and removed nodes.
func CheckAll(ctx context.Context, registry *Registry, timeout time.Duration, concurrency int, logger *logx.Logger) (int, int) {
	if concurrency <= 0 {
		concurrency = 8
	}
	nodes := registry.All()
	if len(nodes) == 0 {
		return 0, 0
	}
	sem := make(chan struct{}, concurrency)
	var checked atomic.Int64
	var removed atomic.Int64
	var wait sync.WaitGroup
	for _, node := range nodes {
		node := node
		wait.Add(1)
		go func() {
			defer wait.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			key, err := NodeKey(node.Transports)
			if err != nil {
				registry.Remove(key)
				removed.Add(1)
				return
			}
			for _, transport := range registry.VerifiedTransports(key) {
				var probeErr error
				switch transport.Type {
				case "websocket":
					probeErr = ProbeWebSocket(ctx, transport.URL, timeout)
				case "webrtc":
					probeErr = ProbeWebRTC(ctx, transport, timeout)
				default:
					probeErr = fmt.Errorf("unsupported transport %q", transport.Type)
				}
				if probeErr != nil {
					registry.MarkTransportFailed(key, transport)
					if logger != nil {
						logger.Warn("master_probe_failed",
							logx.F("node", key),
							logx.F("transport", transport.Type),
							logx.F("error", probeErr.Error()),
						)
					}
				}
			}
			checked.Add(1)
			healthy := registry.HasVerified(key)
			registry.MarkChecked(key, time.Now().UTC(), healthy)
			if !healthy {
				registry.Remove(key)
				removed.Add(1)
			}
		}()
	}
	wait.Wait()
	return int(checked.Load()), int(removed.Load())
}
