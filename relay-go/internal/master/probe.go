package master

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ddnet-relay-go/internal/logx"
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

// CheckAll probes every registered node and removes those that do not accept a
// WebSocket connection. It returns the number of checked and removed nodes.
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
			if err := ProbeWebSocket(ctx, node.URL, timeout); err != nil {
				registry.Remove(node.URL)
				removed.Add(1)
				checked.Add(1)
				if logger != nil {
					logger.Warn("master_probe_failed",
						logx.F("node", node.URL),
						logx.F("error", err.Error()),
					)
				}
				return
			}
			registry.MarkChecked(node.URL, time.Now().UTC(), true)
			checked.Add(1)
		}()
	}
	wait.Wait()
	return int(checked.Load()), int(removed.Load())
}
