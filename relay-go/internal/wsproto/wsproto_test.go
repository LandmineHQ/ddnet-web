package wsproto_test

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"ddnet-relay-go/internal/wsproto"
)

func readFrameFrom(t *testing.T, data []byte, maxPayload int) wsproto.Frame {
	t.Helper()
	reader := bufio.NewReader(bytes.NewReader(data))
	frame, err := wsproto.ReadFrame(reader, maxPayload)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	return frame
}

func TestFrameRoundTrip(t *testing.T) {
	sizes := []int{0, 1, 125, 126, 65535, 65536, 70000}
	for _, size := range sizes {
		payload := make([]byte, size)
		for i := range payload {
			payload[i] = byte(i % 251)
		}
		for _, mask := range []bool{false, true} {
			data := wsproto.AppendFrame(nil, wsproto.OpBinary, payload, mask)
			frame := readFrameFrom(t, data, 1<<20)
			if !frame.FIN || frame.Opcode != wsproto.OpBinary {
				t.Fatalf("size %d mask %v: header decoded incorrectly: %+v", size, mask, frame)
			}
			if frame.Masked != mask {
				t.Fatalf("size %d: masked = %v; want %v", size, frame.Masked, mask)
			}
			if !bytes.Equal(frame.Payload, payload) {
				t.Fatalf("size %d mask %v: payload mismatch (got %d bytes)", size, mask, len(frame.Payload))
			}
		}
	}
}

func TestFrameLimit(t *testing.T) {
	data := wsproto.AppendFrame(nil, wsproto.OpBinary, make([]byte, 4096), false)
	reader := bufio.NewReader(bytes.NewReader(data))
	if _, err := wsproto.ReadFrame(reader, 2048); !errors.Is(err, wsproto.ErrFrameTooLarge) {
		t.Fatalf("expected ErrFrameTooLarge, got %v", err)
	}
}

func TestProtocolViolations(t *testing.T) {
	cases := map[string][]byte{
		"unknown opcode":         {0x83, 0x00},
		"reserved bits":          {0xC2, 0x00},
		"fragmented ping":        {0x09, 0x00},
		"control payload 126":    {0x89, 126},
		"non-minimal len 126":    {0x82, 126, 0x00, 0x05, 'h', 'e', 'l', 'l', 'o'},
		"non-minimal len 127":    {0x82, 127, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0},
		"negative 64-bit length": {0x82, 127, 0x80, 0, 0, 0, 0, 0, 0, 0},
	}
	for name, data := range cases {
		reader := bufio.NewReader(bytes.NewReader(data))
		if _, err := wsproto.ReadFrame(reader, 1<<20); err == nil {
			t.Fatalf("%s: frame accepted", name)
		}
	}
}

func newClientConn(input []byte, output io.Writer) *wsproto.Conn {
	return wsproto.NewClientConn(nil, bufio.NewReader(bytes.NewReader(input)), bufio.NewWriter(output), 1<<20)
}

func TestReadMessageFragments(t *testing.T) {
	var stream []byte
	stream = append(stream, 0x02, 3, 'h', 'e', 'l') // binary, FIN=0
	stream = append(stream, 0x80, 2, 'l', 'o')      // continuation, FIN=1
	conn := newClientConn(stream, io.Discard)
	opcode, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if opcode != wsproto.OpBinary || string(payload) != "hello" {
		t.Fatalf("fragmented message = %d %q", opcode, payload)
	}
}

func TestReadMessageTooLargeFragments(t *testing.T) {
	var stream []byte
	stream = append(stream, 0x02, 4, 'a', 'b', 'c', 'd')
	stream = append(stream, 0x80, 4, 'e', 'f', 'g', 'h')
	reader := bufio.NewReader(bytes.NewReader(stream))
	conn := wsproto.NewClientConn(nil, reader, bufio.NewWriter(io.Discard), 6)
	if _, _, err := conn.ReadMessage(); !errors.Is(err, wsproto.ErrFrameTooLarge) {
		t.Fatalf("expected ErrFrameTooLarge, got %v", err)
	}
}

func TestReadMessagePingAutoPong(t *testing.T) {
	var stream []byte
	stream = append(stream, 0x89, 2, 'h', 'i')           // ping
	stream = append(stream, 0x82, 4, 'd', 'a', 't', 'a') // binary
	var output bytes.Buffer
	conn := newClientConn(stream, &output)
	opcode, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if opcode != wsproto.OpBinary || string(payload) != "data" {
		t.Fatalf("message = %d %q", opcode, payload)
	}
	pong, err := wsproto.ReadFrame(bufio.NewReader(&output), 1<<20)
	if err != nil {
		t.Fatalf("reading pong: %v", err)
	}
	if pong.Opcode != wsproto.OpPong || string(pong.Payload) != "hi" {
		t.Fatalf("pong = %+v", pong)
	}
}

func TestReadMessageClose(t *testing.T) {
	payload := make([]byte, 2, 5)
	binary.BigEndian.PutUint16(payload, 1001)
	payload = append(payload, 'b', 'y', 'e')
	stream := []byte{0x88, 5}
	stream = append(stream, payload...)
	var output bytes.Buffer
	conn := newClientConn(stream, &output)
	_, _, err := conn.ReadMessage()
	var closeErr *wsproto.CloseError
	if !errors.As(err, &closeErr) {
		t.Fatalf("expected CloseError, got %v", err)
	}
	if closeErr.Code != 1001 || closeErr.Reason != "bye" {
		t.Fatalf("close = %+v", closeErr)
	}
	echo, err := wsproto.ReadFrame(bufio.NewReader(&output), 1<<20)
	if err != nil {
		t.Fatalf("reading close echo: %v", err)
	}
	if echo.Opcode != wsproto.OpClose {
		t.Fatalf("close echo opcode = %d", echo.Opcode)
	}
}

func TestServerRequiresMasking(t *testing.T) {
	stream := []byte{0x82, 1, 'x'} // unmasked binary frame
	conn := wsproto.NewServerConn(nil, bufio.NewReader(bytes.NewReader(stream)), bufio.NewWriter(io.Discard), 1<<20)
	_, _, err := conn.ReadMessage()
	var protocolErr *wsproto.ProtocolError
	if !errors.As(err, &protocolErr) {
		t.Fatalf("expected protocol error, got %v", err)
	}
}

func TestWriteCloseTruncatesReason(t *testing.T) {
	var output bytes.Buffer
	conn := wsproto.NewClientConn(nil, bufio.NewReader(bytes.NewReader(nil)), bufio.NewWriter(&output), 1<<20)
	longReason := strings.Repeat("ü", 200)
	if err := conn.WriteClose(1001, longReason); err != nil {
		t.Fatalf("WriteClose: %v", err)
	}
	frame, err := wsproto.ReadFrame(bufio.NewReader(&output), 1<<20)
	if err != nil {
		t.Fatalf("reading close: %v", err)
	}
	if len(frame.Payload) > 125 {
		t.Fatalf("close payload too large: %d", len(frame.Payload))
	}
	reason := frame.Payload[2:]
	if !utf8.Valid(reason) {
		t.Fatal("truncated close reason is not valid UTF-8")
	}
}

func TestAcceptKey(t *testing.T) {
	// RFC 6455 section 1.3 sample.
	if got := wsproto.AcceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("AcceptKey = %q", got)
	}
}

func upgradeRequest() *http.Request {
	request, _ := http.NewRequest(http.MethodGet, "http://relay.invalid/udp/127.0.0.1:8303", nil)
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	return request
}

func TestValidateUpgrade(t *testing.T) {
	if err := wsproto.ValidateUpgrade(upgradeRequest()); err != nil {
		t.Fatalf("valid upgrade rejected: %v", err)
	}
	if !wsproto.IsUpgrade(upgradeRequest()) {
		t.Fatal("IsUpgrade returned false for a valid upgrade")
	}

	missingKey := upgradeRequest()
	missingKey.Header.Del("Sec-WebSocket-Key")
	if err := wsproto.ValidateUpgrade(missingKey); err == nil {
		t.Fatal("missing key accepted")
	}

	badVersion := upgradeRequest()
	badVersion.Header.Set("Sec-WebSocket-Version", "8")
	if err := wsproto.ValidateUpgrade(badVersion); err == nil || err.Status != http.StatusUpgradeRequired {
		t.Fatalf("bad version: %+v", err)
	}

	badMethod := upgradeRequest()
	badMethod.Method = http.MethodPost
	if err := wsproto.ValidateUpgrade(badMethod); err == nil || err.Status != http.StatusMethodNotAllowed {
		t.Fatalf("bad method: %+v", err)
	}

	noUpgrade := upgradeRequest()
	noUpgrade.Header.Del("Upgrade")
	if err := wsproto.ValidateUpgrade(noUpgrade); err == nil {
		t.Fatal("missing Upgrade header accepted")
	}
	if wsproto.IsUpgrade(noUpgrade) {
		t.Fatal("IsUpgrade returned true without Upgrade header")
	}
}

func TestUpgradeResponse(t *testing.T) {
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := wsproto.Upgrade(writer, upgradeRequest()); err != nil {
		t.Fatalf("Upgrade: %v", err)
	}
	response := output.String()
	if !strings.HasPrefix(response, "HTTP/1.1 101 Switching Protocols\r\n") {
		t.Fatalf("unexpected response: %q", response)
	}
	if !strings.Contains(response, "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n") {
		t.Fatalf("missing/incorrect accept header: %q", response)
	}
}
