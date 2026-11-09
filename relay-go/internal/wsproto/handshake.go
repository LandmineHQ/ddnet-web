package wsproto

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"strings"
)

// acceptGUID is the RFC 6455 handshake GUID.
const acceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// AcceptKey computes the Sec-WebSocket-Accept value for a client key.
func AcceptKey(key string) string {
	hash := sha1.Sum([]byte(key + acceptGUID))
	return base64.StdEncoding.EncodeToString(hash[:])
}

// IsUpgrade reports whether the request asks for a WebSocket upgrade.
func IsUpgrade(request *http.Request) bool {
	if !headerContainsToken(request.Header, "Connection", "upgrade") {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket")
}

// UpgradeError describes a rejected handshake (before the 101 response).
type UpgradeError struct {
	Status  int
	Message string
	Headers map[string]string
}

func (e *UpgradeError) Error() string { return e.Message }

// ValidateUpgrade checks an RFC 6455 client handshake request.
func ValidateUpgrade(request *http.Request) *UpgradeError {
	if request.Method != http.MethodGet {
		return &UpgradeError{Status: http.StatusMethodNotAllowed, Message: "Method not allowed", Headers: map[string]string{"Allow": "GET"}}
	}
	if request.ProtoMajor != 1 || request.ProtoMinor < 1 {
		return &UpgradeError{Status: http.StatusBadRequest, Message: "WebSocket handshake requires HTTP/1.1"}
	}
	if !headerContainsToken(request.Header, "Connection", "upgrade") {
		return &UpgradeError{Status: http.StatusBadRequest, Message: "Missing Connection: Upgrade header"}
	}
	if !strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket") {
		return &UpgradeError{Status: http.StatusBadRequest, Message: "Missing Upgrade: websocket header"}
	}
	if version := strings.TrimSpace(request.Header.Get("Sec-WebSocket-Version")); version != "13" {
		return &UpgradeError{
			Status:  http.StatusUpgradeRequired,
			Message: "Unsupported WebSocket version; only version 13 is supported",
			Headers: map[string]string{"Sec-WebSocket-Version": "13"},
		}
	}
	key := strings.TrimSpace(request.Header.Get("Sec-WebSocket-Key"))
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decoded) != 16 {
		return &UpgradeError{Status: http.StatusBadRequest, Message: "Invalid Sec-WebSocket-Key header"}
	}
	return nil
}

// Upgrade writes the 101 Switching Protocols response. ValidateUpgrade must
// have been called first; the caller flushes the writer.
func Upgrade(writer *bufio.Writer, request *http.Request) error {
	accept := AcceptKey(strings.TrimSpace(request.Header.Get("Sec-WebSocket-Key")))
	if _, err := writer.WriteString(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + accept + "\r\n" +
			"\r\n",
	); err != nil {
		return err
	}
	return writer.Flush()
}

func headerContainsToken(headers http.Header, name, token string) bool {
	for _, value := range headers.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}
