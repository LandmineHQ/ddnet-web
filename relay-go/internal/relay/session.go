package relay

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"ddnet-relay-go/internal/config"
	"ddnet-relay-go/internal/logx"
	"ddnet-relay-go/internal/ratelimit"
	"ddnet-relay-go/internal/ssrf"
	"ddnet-relay-go/internal/stats"
	"ddnet-relay-go/internal/urlparse"
	"ddnet-relay-go/internal/wsproto"
)

// Session is one WebSocket client bound to one connected UDP socket.
type Session struct {
	id       string
	server   *Server
	conn     *wsproto.Conn
	target   urlparse.Target
	resolved ssrf.Resolved
	clientIP string
	origin   string
	cfg      *config.Config
	log      *logx.Logger
	stats    *stats.Stats

	releaseIP func()

	startedAt      time.Time
	lastActivityMS atomic.Int64
	lastPingMS     atomic.Int64
	lastPongMS     atomic.Int64

	bytesToTarget     atomic.Int64
	bytesFromTarget   atomic.Int64
	packetsToTarget   atomic.Int64
	packetsFromTarget atomic.Int64

	rateLimiter *ratelimit.ConnectionRateLimiter
	frameGuard  ratelimit.FrameGuard

	dropMu   sync.Mutex
	dropped  map[string]int64
	lastWarn map[string]time.Time

	udpMu    sync.Mutex
	udp      *net.UDPConn
	udpReady atomic.Bool

	pendingMu sync.Mutex
	pending   [][]byte

	writeCh           chan []byte
	pendingWriteBytes atomic.Int64

	closeCh     chan struct{}
	closeOnce   sync.Once
	closed      atomic.Bool
	closeReason atomic.Value // string

	wg sync.WaitGroup
}

func newSessionID() string {
	var raw [4]byte
	_, _ = rand.Read(raw[:])
	return "c-" + hex.EncodeToString(raw[:])
}

func newSession(
	server *Server,
	conn *wsproto.Conn,
	target urlparse.Target,
	resolved ssrf.Resolved,
	clientIP string,
	origin string,
	releaseIP func(),
) *Session {
	startedAt := time.Now()
	cfg := server.cfg
	session := &Session{
		id:         newSessionID(),
		server:     server,
		conn:       conn,
		target:     target,
		resolved:   resolved,
		clientIP:   clientIP,
		origin:     origin,
		cfg:        cfg,
		stats:      server.stats,
		releaseIP:  releaseIP,
		startedAt:  startedAt,
		dropped:    make(map[string]int64),
		lastWarn:   make(map[string]time.Time),
		writeCh:    make(chan []byte, 256),
		closeCh:    make(chan struct{}),
		frameGuard: ratelimit.FrameGuard{MaxFrameBytes: cfg.Limits.MaxFrameBytes, HardMaxFrameBytes: cfg.Limits.HardMaxFrameBytes},
	}
	nowMS := startedAt.UnixMilli()
	session.lastActivityMS.Store(nowMS)
	session.lastPingMS.Store(nowMS)
	session.log = server.log.With(
		logx.F("connId", session.id),
		logx.F("target", target.String()),
		logx.F("clientIp", clientIP),
	)
	limiter, err := ratelimit.NewConnectionRateLimiter(
		float64(cfg.Limits.MaxPacketsPerSecond),
		float64(cfg.Limits.PacketBurst),
		cfg.Limits.MaxBytesPerSecond,
		cfg.Limits.ByteBurst,
		nowMS,
	)
	if err == nil {
		session.rateLimiter = limiter
	}
	conn.SetPongHandler(func([]byte) {
		session.lastPongMS.Store(time.Now().UnixMilli())
	})
	server.stats.OnConnectionOpen(target.String(), clientIP)
	session.log.Info("connection_open",
		logx.F("family", resolved.Family),
		logx.F("address", resolved.Address.String()),
		logx.F("port", target.Port),
		logx.F("origin", origin),
	)
	return session
}

func (s *Session) start() {
	s.wg.Add(4)
	go s.runUDP()
	go s.runWriter()
	go s.runTicker()
	go s.runReader()
}

func (s *Session) runUDP() {
	defer s.wg.Done()
	remote := net.UDPAddrFromAddrPort(netip.AddrPortFrom(s.resolved.Address, uint16(s.target.Port)))
	conn, err := net.DialUDP("udp", nil, remote)
	if err != nil {
		s.log.Warn("udp_dial_error", logx.F("error", err.Error()))
		s.close(udpCloseReason(err), 1011)
		return
	}
	_ = conn.SetReadBuffer(1 << 20)
	_ = conn.SetWriteBuffer(1 << 20)
	s.udpMu.Lock()
	if s.closed.Load() {
		s.udpMu.Unlock()
		_ = conn.Close()
		return
	}
	s.udp = conn
	s.udpMu.Unlock()
	s.udpReady.Store(true)
	s.log.Info("udp_connected", logx.F("address", s.resolved.Address.String()), logx.F("port", s.target.Port))

	// Flush packets that arrived while the socket was being set up.
	s.pendingMu.Lock()
	pending := s.pending
	s.pending = nil
	s.pendingMu.Unlock()
	for _, packet := range pending {
		s.sendUDP(packet)
	}

	buffer := make([]byte, 65535)
	for {
		n, readErr := conn.Read(buffer)
		if readErr != nil {
			if s.closed.Load() {
				return
			}
			s.log.Warn("udp_error", logx.F("error", readErr.Error()))
			s.close(udpCloseReason(readErr), 1011)
			return
		}
		s.lastActivityMS.Store(time.Now().UnixMilli())
		s.packetsFromTarget.Add(1)
		s.bytesFromTarget.Add(int64(n))
		s.stats.OnPacketFromTarget(s.target.String(), int64(n))
		datagram := make([]byte, n)
		copy(datagram, buffer[:n])
		s.enqueueWS(datagram)
	}
}

func (s *Session) runWriter() {
	defer s.wg.Done()
	for {
		if s.closed.Load() {
			return
		}
		select {
		case <-s.closeCh:
			return
		case datagram := <-s.writeCh:
			if s.closed.Load() {
				s.pendingWriteBytes.Add(-int64(len(datagram)))
				continue
			}
			writeErr := s.conn.WriteMessage(wsproto.OpBinary, datagram)
			s.pendingWriteBytes.Add(-int64(len(datagram)))
			if writeErr != nil {
				s.log.Debug("ws_send_error", logx.F("error", writeErr.Error()))
			}
		}
	}
}

func (s *Session) runTicker() {
	defer s.wg.Done()
	idle := s.cfg.Limits.IdleTimeoutMs
	base := idle
	if base <= 0 {
		base = 1000
	}
	interval := base / 4
	if interval < 25 {
		interval = 25
	}
	if interval > 1000 {
		interval = 1000
	}
	ticker := time.NewTicker(time.Duration(interval) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-s.closeCh:
			return
		case <-ticker.C:
			if s.closed.Load() {
				return
			}
			now := time.Now().UnixMilli()
			if s.cfg.Limits.IdleTimeoutMs > 0 && now-s.lastActivityMS.Load() >= s.cfg.Limits.IdleTimeoutMs {
				s.close("idle_timeout", 1001)
				return
			}
			if s.cfg.Limits.MaxConnectionMs > 0 && now-s.startedAt.UnixMilli() >= s.cfg.Limits.MaxConnectionMs {
				s.close("max_duration", 1001)
				return
			}
			if s.cfg.Limits.PingIntervalMs > 0 && now-s.lastPingMS.Load() >= s.cfg.Limits.PingIntervalMs {
				s.lastPingMS.Store(now)
				if pingErr := s.conn.WritePing(nil); pingErr != nil {
					s.log.Debug("ws_ping_error", logx.F("error", pingErr.Error()))
				}
			}
		}
	}
}

func (s *Session) runReader() {
	defer s.wg.Done()
	for {
		if s.closed.Load() {
			return
		}
		opcode, payload, err := s.conn.ReadMessage()
		if err != nil {
			s.handleReadError(err)
			return
		}
		now := time.Now().UnixMilli()
		s.lastActivityMS.Store(now)
		if opcode != wsproto.OpBinary {
			// Text frames are not part of the data protocol; ignore and count.
			s.drop("text_frame")
			continue
		}
		if len(payload) == 0 {
			s.drop("empty_frame")
			continue
		}
		if ok, reason := s.frameGuard.Check(len(payload)); !ok {
			s.drop("frame_" + reason)
			s.warnThrottled("frame_dropped", logx.F("size", len(payload)), logx.F("reason", reason))
			continue
		}
		if s.rateLimiter != nil {
			if ok, reason := s.rateLimiter.AllowPacket(len(payload), now); !ok {
				s.drop(reason)
				s.warnThrottled("rate_limited", logx.F("size", len(payload)), logx.F("reason", reason))
				continue
			}
		}
		if !s.udpReady.Load() {
			s.pendingMu.Lock()
			if len(s.pending) >= s.cfg.Limits.MaxPendingPackets {
				s.pendingMu.Unlock()
				s.drop("pending_overflow")
				continue
			}
			s.pending = append(s.pending, payload)
			s.pendingMu.Unlock()
			continue
		}
		s.sendUDP(payload)
	}
}

func (s *Session) handleReadError(err error) {
	var closeErr *wsproto.CloseError
	switch {
	case errors.As(err, &closeErr):
		s.close("client_closed", 1000)
	case errors.Is(err, wsproto.ErrFrameTooLarge):
		s.drop("frame_hard_limit")
		s.log.Warn("frame_hard_limit",
			logx.F("limit", s.cfg.Limits.HardMaxFrameBytes),
		)
		s.close("ws_error", 1011)
	default:
		var protocolErr *wsproto.ProtocolError
		if errors.As(err, &protocolErr) {
			s.log.Warn("ws_protocol_error", logx.F("error", err.Error()))
			s.close("ws_error", 1011)
			return
		}
		if !s.closed.Load() {
			s.close("client_closed", 1000)
		}
	}
}

func (s *Session) sendUDP(payload []byte) {
	if s.closed.Load() {
		return
	}
	s.udpMu.Lock()
	conn := s.udp
	s.udpMu.Unlock()
	if conn == nil {
		return
	}
	written, err := conn.Write(payload)
	if err != nil {
		if s.closed.Load() {
			return
		}
		if isUnreachableError(err) {
			s.log.Warn("udp_send_unreachable", logx.F("error", err.Error()))
			s.close("target_unreachable", 1011)
			return
		}
		s.drop("udp_send_error")
		s.log.Warn("udp_send_error", logx.F("error", err.Error()))
		return
	}
	s.packetsToTarget.Add(1)
	s.bytesToTarget.Add(int64(written))
	s.stats.OnPacketToTarget(s.target.String(), int64(written))
}

func (s *Session) enqueueWS(datagram []byte) {
	pending := s.pendingWriteBytes.Add(int64(len(datagram)))
	if pending > s.cfg.Limits.MaxBufferedBytes {
		s.pendingWriteBytes.Add(-int64(len(datagram)))
		s.drop("backpressure")
		s.warnThrottled("backpressure_drop", logx.F("bufferedBytes", pending))
		return
	}
	select {
	case s.writeCh <- datagram:
	default:
		s.pendingWriteBytes.Add(-int64(len(datagram)))
		s.drop("backpressure")
		s.warnThrottled("backpressure_drop", logx.F("bufferedBytes", pending))
	}
}

func (s *Session) drop(reason string) {
	s.dropMu.Lock()
	s.dropped[reason]++
	s.dropMu.Unlock()
	s.stats.OnDrop(reason)
}

func (s *Session) droppedSnapshot() map[string]int64 {
	s.dropMu.Lock()
	defer s.dropMu.Unlock()
	out := make(map[string]int64, len(s.dropped))
	for key, value := range s.dropped {
		out[key] = value
	}
	return out
}

func (s *Session) warnThrottled(event string, fields ...logx.Field) {
	s.dropMu.Lock()
	last := s.lastWarn[event]
	now := time.Now()
	if now.Sub(last) < 5*time.Second {
		s.dropMu.Unlock()
		return
	}
	s.lastWarn[event] = now
	s.dropMu.Unlock()
	s.log.Warn(event, fields...)
}

// close is idempotent: it stops timers, closes the UDP socket, records stats,
// sends a close frame and schedules a hard close 250 ms later.
func (s *Session) close(reason string, code uint16) {
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		s.closeReason.Store(reason)
		close(s.closeCh)

		s.udpMu.Lock()
		conn := s.udp
		s.udp = nil
		s.udpMu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}

		durationMS := time.Since(s.startedAt).Milliseconds()
		s.stats.OnConnectionClose(s.target.String(), reason)
		dropped := s.droppedSnapshot()
		s.log.Info("connection_closed",
			logx.F("reason", reason),
			logx.F("durationMs", durationMS),
			logx.F("bytesToTarget", s.bytesToTarget.Load()),
			logx.F("bytesFromTarget", s.bytesFromTarget.Load()),
			logx.F("packetsToTarget", s.packetsToTarget.Load()),
			logx.F("packetsFromTarget", s.packetsFromTarget.Load()),
			logx.F("dropped", dropped),
		)

		s.server.removeSession(s)
		if s.releaseIP != nil {
			s.releaseIP()
		}

		if code != 0 {
			_ = s.conn.WriteClose(code, reason)
		}
		time.AfterFunc(250*time.Millisecond, func() {
			_ = s.conn.Close()
		})
	})
}

func (s *Session) forceTerminate() {
	_ = s.conn.Close()
}

func isUnreachableError(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH) ||
		errors.Is(err, syscall.EACCES) ||
		errors.Is(err, syscall.EPERM)
}

func udpCloseReason(err error) string {
	if isUnreachableError(err) {
		return "target_unreachable"
	}
	return "udp_error"
}
