package relay_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ddnet-relay-go/internal/config"
	"ddnet-relay-go/internal/logx"
	"ddnet-relay-go/internal/relay"
	"ddnet-relay-go/internal/ssrf"
	"ddnet-relay-go/internal/stats"
	"ddnet-relay-go/internal/wsproto"
)

// testRelay is a relay running on an ephemeral loopback port.
type testRelay struct {
	srv      *relay.Server
	stats    *stats.Stats
	wsBase   string
	httpBase string
}

func startRelay(t *testing.T, mutate func(*config.Config), lookup ssrf.LookupFunc) *testRelay {
	t.Helper()
	cfg := config.Default()
	cfg.Name = "Test Relay"
	cfg.Host = "127.0.0.1"
	cfg.Port = 0
	cfg.Auth.Tokens = []string{}
	cfg.Security.Allowlist = []string{"127.0.0.1/32", "::1/128"}
	if mutate != nil {
		mutate(&cfg)
	}
	if err := config.Validate(&cfg); err != nil {
		t.Fatalf("config validation: %v", err)
	}
	store := stats.New()
	server, err := relay.NewServer(&cfg, relay.Options{
		Logger: logx.New(logx.Silent, io.Discard),
		Stats:  store,
		Lookup: lookup,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	if err := server.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	host, port := server.BoundAddress()
	base := net.JoinHostPort(host, strconv.Itoa(port))
	return &testRelay{srv: server, stats: store, wsBase: "ws://" + base, httpBase: "http://" + base}
}

// echoServer echoes every UDP datagram back to the sender.
type echoServer struct {
	conn *net.UDPConn
	port int
	once sync.Once
}

func startEcho(t *testing.T) *echoServer {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("ListenUDP: %v", err)
	}
	server := &echoServer{conn: conn, port: conn.LocalAddr().(*net.UDPAddr).Port}
	go func() {
		buffer := make([]byte, 65535)
		for {
			read, address, err := conn.ReadFromUDP(buffer)
			if err != nil {
				return
			}
			_, _ = conn.WriteToUDP(buffer[:read], address)
		}
	}()
	t.Cleanup(server.close)
	return server
}

func (e *echoServer) close() {
	e.once.Do(func() { _ = e.conn.Close() })
}

// wsClient is a minimal RFC 6455 client used to exercise the relay.
type wsClient struct {
	t    *testing.T
	conn net.Conn
	bw   *bufio.Writer
	ws   *wsproto.Conn
}

func readResponseHead(reader *bufio.Reader) (int, http.Header, error) {
	textReader := textproto.NewReader(reader)
	line, err := textReader.ReadLine()
	if err != nil {
		return 0, nil, err
	}
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 2 {
		return 0, nil, fmt.Errorf("malformed status line %q", line)
	}
	statusCode, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, nil, fmt.Errorf("malformed status code in %q", line)
	}
	header, err := textReader.ReadMIMEHeader()
	if err != nil {
		return 0, nil, err
	}
	return statusCode, http.Header(header), nil
}

// dialWS performs the client handshake. On a non-101 response it returns the
// status/code/body and a nil client.
func dialWS(t *testing.T, rawURL string, headers http.Header) (*wsClient, int, map[string]any) {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse %s: %v", rawURL, err)
	}
	conn, err := net.DialTimeout("tcp", parsed.Host, 2*time.Second)
	if err != nil {
		t.Fatalf("dial %s: %v", parsed.Host, err)
	}
	// Keep the socket alive for the whole test even if the server goes away.
	_ = conn.SetDeadline(time.Time{})
	writer := bufio.NewWriter(conn)
	reader := bufio.NewReader(conn)
	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef"))
	target := parsed.RequestURI()
	if _, err := fmt.Fprintf(writer,
		"GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
			"Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n",
		target, parsed.Host, key,
	); err != nil {
		_ = conn.Close()
		t.Fatalf("write handshake: %v", err)
	}
	for name, values := range headers {
		for _, value := range values {
			if _, err := fmt.Fprintf(writer, "%s: %s\r\n", name, value); err != nil {
				_ = conn.Close()
				t.Fatalf("write header: %v", err)
			}
		}
	}
	if _, err := writer.WriteString("\r\n"); err != nil {
		_ = conn.Close()
		t.Fatalf("finish handshake: %v", err)
	}
	if err := writer.Flush(); err != nil {
		_ = conn.Close()
		t.Fatalf("flush handshake: %v", err)
	}
	status, responseHeaders, err := readResponseHead(reader)
	if err != nil {
		_ = conn.Close()
		t.Fatalf("read handshake response: %v", err)
	}
	if status != http.StatusSwitchingProtocols {
		body := readBody(reader, responseHeaders)
		_ = conn.Close()
		var parsedBody map[string]any
		_ = json.Unmarshal(body, &parsedBody)
		return nil, status, parsedBody
	}
	if accept := responseHeaders.Get("Sec-WebSocket-Accept"); accept != wsproto.AcceptKey(key) {
		_ = conn.Close()
		t.Fatalf("bad Sec-WebSocket-Accept %q", accept)
	}
	client := &wsClient{t: t, conn: conn, bw: writer}
	client.ws = wsproto.NewClientConn(conn, reader, writer, 1<<20)
	t.Cleanup(func() { _ = conn.Close() })
	return client, status, nil
}

func readBody(reader *bufio.Reader, headers http.Header) []byte {
	length, err := strconv.Atoi(headers.Get("Content-Length"))
	if err != nil || length <= 0 {
		return nil
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil
	}
	return body
}

func (c *wsClient) send(payload []byte) {
	c.t.Helper()
	if err := c.ws.WriteMessage(wsproto.OpBinary, payload); err != nil {
		c.t.Fatalf("send binary: %v", err)
	}
}

func (c *wsClient) sendText(payload []byte) {
	c.t.Helper()
	if err := c.ws.WriteMessage(wsproto.OpText, payload); err != nil {
		c.t.Fatalf("send text: %v", err)
	}
}

func (c *wsClient) expectEcho(payload []byte, timeout time.Duration) {
	c.t.Helper()
	c.send(payload)
	echoed, err := c.readBinary(timeout)
	if err != nil {
		c.t.Fatalf("waiting for echo of %d bytes: %v", len(payload), err)
	}
	if !bytes.Equal(echoed, payload) {
		c.t.Fatalf("echo mismatch: got %d bytes, want %d bytes", len(echoed), len(payload))
	}
}

func (c *wsClient) readBinary(timeout time.Duration) ([]byte, error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(timeout))
	defer func() { _ = c.conn.SetReadDeadline(time.Time{}) }()
	opcode, payload, err := c.ws.ReadMessage()
	if err != nil {
		return nil, err
	}
	if opcode != wsproto.OpBinary {
		return nil, fmt.Errorf("expected a binary frame, got opcode %d", opcode)
	}
	return payload, nil
}

func (c *wsClient) close() {
	_ = c.ws.WriteClose(1000, "test done")
	_ = c.conn.Close()
}

func (c *wsClient) waitClose(timeout time.Duration) (uint16, string, error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(timeout))
	defer func() { _ = c.conn.SetReadDeadline(time.Time{}) }()
	for {
		_, _, err := c.ws.ReadMessage()
		if err == nil {
			continue
		}
		var closeErr *wsproto.CloseError
		if errors.As(err, &closeErr) {
			return closeErr.Code, closeErr.Reason, nil
		}
		return 0, "", err
	}
}

func getJSON(t *testing.T, rawURL string) (int, http.Header, map[string]any) {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(rawURL)
	if err != nil {
		t.Fatalf("GET %s: %v", rawURL, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatalf("read %s: %v", rawURL, err)
	}
	var parsed map[string]any
	if len(body) > 0 {
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("invalid JSON from %s: %v (%s)", rawURL, err, body)
		}
	}
	return response.StatusCode, response.Header, parsed
}

func postJSON(t *testing.T, rawURL string, headers http.Header, body string) (int, http.Header, map[string]any) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, rawURL, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", rawURL, err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	var parsed map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &parsed)
	}
	return response.StatusCode, response.Header, parsed
}

func wsURL(relayBase, target string) string {
	return relayBase + "/udp/" + target
}
