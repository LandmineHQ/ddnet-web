// Package wsproto implements the small subset of RFC 6455 needed by the relay:
// the server handshake, frame encoding/decoding, message reassembly, ping/pong
// and the closing handshake. It is stdlib-only by design.
package wsproto

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"
	"unicode/utf8"
)

// WebSocket opcodes.
const (
	OpContinuation byte = 0x0
	OpText         byte = 0x1
	OpBinary       byte = 0x2
	OpClose        byte = 0x8
	OpPing         byte = 0x9
	OpPong         byte = 0xA
)

// ErrFrameTooLarge is returned when a frame or message exceeds the configured
// limit. The caller must close the connection (the peer violated maxPayload).
var ErrFrameTooLarge = errors.New("wsproto: message exceeds the maximum payload size")

// ProtocolError reports an RFC 6455 violation from the peer.
type ProtocolError struct{ Reason string }

func (e *ProtocolError) Error() string { return "wsproto: protocol error: " + e.Reason }

func protocolError(reason string) error { return &ProtocolError{Reason: reason} }

// CloseError is returned by ReadMessage when the peer sends a close frame.
type CloseError struct {
	Code   uint16
	Reason string
}

func (e *CloseError) Error() string { return "wsproto: close " + itoa(int(e.Code)) }

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	pos := len(digits)
	for value > 0 {
		pos--
		digits[pos] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		pos--
		digits[pos] = '-'
	}
	return string(digits[pos:])
}

// Frame is one decoded WebSocket frame.
type Frame struct {
	FIN     bool
	Opcode  byte
	Masked  bool
	Payload []byte
}

// ReadFrame reads and decodes one frame. Client-to-server frames are unmasked
// on the fly. maxPayload limits the payload size (0 disables the check).
func ReadFrame(reader *bufio.Reader, maxPayload int) (Frame, error) {
	var header [2]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return Frame{}, err
	}
	fin := header[0]&0x80 != 0
	if header[0]&0x70 != 0 {
		return Frame{}, protocolError("reserved bits set")
	}
	opcode := header[0] & 0x0f
	switch opcode {
	case OpContinuation, OpText, OpBinary, OpClose, OpPing, OpPong:
	default:
		return Frame{}, protocolError("unknown opcode")
	}
	masked := header[1]&0x80 != 0
	length := int64(header[1] & 0x7f)
	if opcode >= 0x8 {
		if !fin {
			return Frame{}, protocolError("fragmented control frame")
		}
		if length > 125 {
			return Frame{}, protocolError("control frame payload too large")
		}
	}
	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			return Frame{}, err
		}
		length = int64(binary.BigEndian.Uint16(extended[:]))
		if length < 126 {
			return Frame{}, protocolError("non-minimal payload length")
		}
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			return Frame{}, err
		}
		unsigned := binary.BigEndian.Uint64(extended[:])
		if unsigned&(1<<63) != 0 {
			return Frame{}, protocolError("invalid payload length")
		}
		length = int64(unsigned)
		if length < 65536 {
			return Frame{}, protocolError("non-minimal payload length")
		}
	}
	if maxPayload > 0 && length > int64(maxPayload) {
		return Frame{}, ErrFrameTooLarge
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(reader, mask[:]); err != nil {
			return Frame{}, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return Frame{}, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return Frame{FIN: fin, Opcode: opcode, Masked: masked, Payload: payload}, nil
}

// AppendFrame appends one complete frame to dst. When mask is true a fresh
// random mask key is used.
func AppendFrame(dst []byte, opcode byte, payload []byte, mask bool) []byte {
	length := len(payload)
	maskBit := byte(0)
	if mask {
		maskBit = 0x80
	}
	dst = append(dst, 0x80|opcode)
	switch {
	case length < 126:
		dst = append(dst, maskBit|byte(length))
	case length <= 65535:
		dst = append(dst, maskBit|126, 0, 0)
		binary.BigEndian.PutUint16(dst[len(dst)-2:], uint16(length))
	default:
		dst = append(dst, maskBit|127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(dst[len(dst)-8:], uint64(length))
	}
	if !mask {
		return append(dst, payload...)
	}
	var key [4]byte
	randomMaskKey(key[:])
	dst = append(dst, key[:]...)
	for i := 0; i < length; i++ {
		dst = append(dst, payload[i]^key[i%4])
	}
	return dst
}

// randomMaskKey fills key with cryptographically random bytes.
func randomMaskKey(key []byte) {
	_, _ = rand.Read(key)
}

// writeAll writes the whole buffer, handling short writes.
func writeAll(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := writer.Write(payload)
		if written > 0 {
			payload = payload[written:]
		}
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

// Conn is a WebSocket connection bound to a net.Conn (or nil for unit tests).
// Exactly one goroutine may call ReadMessage; writes are serialized.
type Conn struct {
	conn         netConn
	reader       *bufio.Reader
	writer       *bufio.Writer
	maxPayload   int
	expectMasked bool

	writeMu   sync.Mutex
	closeMu   sync.Mutex
	closeSent bool
	closed    bool

	onPong func([]byte)
}

// netConn is the minimal net.Conn surface used here (keeps tests easy).
type netConn interface {
	SetWriteDeadline(time.Time) error
	Close() error
}

// NewServerConn wraps a hijacked server connection. Client frames must be
// masked and outgoing server frames are unmasked.
func NewServerConn(conn netConn, reader *bufio.Reader, writer *bufio.Writer, maxPayload int) *Conn {
	return &Conn{conn: conn, reader: reader, writer: writer, maxPayload: maxPayload, expectMasked: true}
}

// NewClientConn wraps a client connection (used by tests). Server frames must
// be unmasked and outgoing client frames are masked.
func NewClientConn(conn netConn, reader *bufio.Reader, writer *bufio.Writer, maxPayload int) *Conn {
	return &Conn{conn: conn, reader: reader, writer: writer, maxPayload: maxPayload, expectMasked: false}
}

// SetPongHandler installs a callback for received pong frames.
func (c *Conn) SetPongHandler(handler func([]byte)) { c.onPong = handler }

// ReadMessage returns the next complete data message, answering pings and
// closing the handshake automatically. A peer close is reported as *CloseError.
func (c *Conn) ReadMessage() (byte, []byte, error) {
	var messageOpcode byte
	var assembled []byte
	fragmented := false
	for {
		frame, err := ReadFrame(c.reader, c.maxPayload)
		if err != nil {
			return 0, nil, err
		}
		if c.expectMasked && !frame.Masked {
			return 0, nil, protocolError("client frame is not masked")
		}
		if !c.expectMasked && frame.Masked {
			return 0, nil, protocolError("server frame is masked")
		}
		switch frame.Opcode {
		case OpPing:
			if err := c.writeFrame(OpPong, frame.Payload); err != nil {
				return 0, nil, err
			}
			continue
		case OpPong:
			if c.onPong != nil {
				c.onPong(frame.Payload)
			}
			continue
		case OpClose:
			code := uint16(1005)
			reason := ""
			if len(frame.Payload) >= 2 {
				code = binary.BigEndian.Uint16(frame.Payload[:2])
				reason = string(frame.Payload[2:])
			}
			_ = c.WriteClose(code, reason)
			return 0, nil, &CloseError{Code: code, Reason: reason}
		case OpContinuation:
			if !fragmented {
				return 0, nil, protocolError("unexpected continuation frame")
			}
			if c.maxPayload > 0 && len(assembled)+len(frame.Payload) > c.maxPayload {
				return 0, nil, ErrFrameTooLarge
			}
			assembled = append(assembled, frame.Payload...)
			if frame.FIN {
				return messageOpcode, assembled, nil
			}
		case OpText, OpBinary:
			if fragmented {
				return 0, nil, protocolError("new data frame while a message is fragmented")
			}
			if frame.FIN {
				return frame.Opcode, frame.Payload, nil
			}
			messageOpcode = frame.Opcode
			assembled = append(assembled[:0], frame.Payload...)
			fragmented = true
		}
	}
}

// WriteMessage sends one data message as a single final frame.
func (c *Conn) WriteMessage(opcode byte, payload []byte) error {
	if opcode != OpText && opcode != OpBinary {
		return protocolError("WriteMessage called with a control opcode")
	}
	return c.writeFrame(opcode, payload)
}

// WriteClose sends a close frame once. Later calls are no-ops.
func (c *Conn) WriteClose(code uint16, reason string) error {
	c.closeMu.Lock()
	if c.closeSent {
		c.closeMu.Unlock()
		return nil
	}
	c.closeSent = true
	c.closeMu.Unlock()
	payload := make([]byte, 2, 2+len(reason))
	binary.BigEndian.PutUint16(payload[:2], code)
	payload = append(payload, truncateCloseReason(reason)...)
	return c.writeFrame(OpClose, payload)
}

func truncateCloseReason(reason string) []byte {
	value := []byte(reason)
	if len(value) > 123 {
		value = value[:123]
		for len(value) > 0 && !utf8.Valid(value) {
			value = value[:len(value)-1]
		}
	}
	return value
}

// WritePing sends a ping frame.
func (c *Conn) WritePing(payload []byte) error { return c.writeFrame(OpPing, payload) }

func (c *Conn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed {
		return io.ErrClosedPipe
	}
	if c.conn != nil {
		_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	}
	buffer := AppendFrame(nil, opcode, payload, !c.expectMasked)
	err := writeAll(c.writer, buffer)
	if err == nil {
		err = c.writer.Flush()
	}
	if c.conn != nil {
		_ = c.conn.SetWriteDeadline(time.Time{})
	}
	return err
}

// Close closes the underlying connection.
func (c *Conn) Close() error {
	c.closeMu.Lock()
	if c.closed {
		c.closeMu.Unlock()
		return nil
	}
	c.closed = true
	c.closeMu.Unlock()
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}
