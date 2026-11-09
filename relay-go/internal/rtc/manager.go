// Package rtc implements WebRTC support for the relay:
//
//   - /rtc/offer without ?target: latency probe. The browser opens a data
//     channel and every message (text/binary) is echoed unchanged.
//   - /rtc/offer?target=host:port: game transport. The browser's data channel
//     carries DDNet UDP datagrams; the relay bridges them to a connected UDP
//     socket. 1 data channel message = 1 UDP datagram.
//
// pion/webrtc (pure Go ICE/DTLS/SCTP) is used, so the relay stays a single
// static binary and needs no native module. The WebSocket transport in
// /udp/<host>:<port> remains available and is the automatic fallback.
package rtc

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"

	"ddnet-relay-go/internal/config"
	"ddnet-relay-go/internal/logx"
	"ddnet-relay-go/internal/ratelimit"
	"ddnet-relay-go/internal/relayerr"
	"ddnet-relay-go/internal/ssrf"
	"ddnet-relay-go/internal/urlparse"
)

const (
	maxTrackedRateBuckets = 4096
	rateBucketTTL         = 10 * time.Minute
)

// StatsSink receives traffic counters for game sessions.
type StatsSink interface {
	OnConnectionOpen(target, clientIP string)
	OnConnectionClose(target, reason string)
	OnPacketToTarget(target string, bytes int64)
	OnPacketFromTarget(target string, bytes int64)
	OnDrop(reason string)
}

// Options configures the manager.
type Options struct {
	Stats             StatsSink
	IdleTimeoutMs     int64
	MaxBufferedBytes  int64
	MaxPendingPackets int
}

// Counters mirrors the legacy Node relay's /api/stats rtc counters.
type Counters struct {
	TotalOffers        atomic.Int64
	AnswersCreated     atomic.Int64
	RejectedOffers     atomic.Int64
	RateLimited        atomic.Int64
	BusyRejections     atomic.Int64
	DisabledRejections atomic.Int64
	PeersClosed        atomic.Int64
	ChannelsOpened     atomic.Int64
	MessagesEchoed     atomic.Int64
	BytesEchoed        atomic.Int64
	GameSessions       atomic.Int64
	GameSessionsActive atomic.Int64
	GamePacketsTo      atomic.Int64
	GamePacketsFrom    atomic.Int64
	GameBytesTo        atomic.Int64
	GameBytesFrom      atomic.Int64
	Errors             atomic.Int64
}

type offerBucket struct {
	bucket     *ratelimit.TokenBucket
	lastRefill time.Time
}

type peer struct {
	id        string
	pc        *webrtc.PeerConnection
	clientIP  string
	createdAt time.Time
	closed    atomic.Bool
	timer     *time.Timer

	// Game mode (nil target = latency echo peer).
	target   *urlparse.Target
	resolved *ssrf.Resolved

	dcMu sync.Mutex
	dc   *webrtc.DataChannel
	udp  *net.UDPConn

	lastActivity atomic.Int64
	ready        atomic.Bool
	pendingMu    sync.Mutex
	pending      [][]byte

	messages   atomic.Int64
	bytes      atomic.Int64
	toTarget   atomic.Int64
	fromTarget atomic.Int64
}

// Manager owns all active WebRTC peers.
type Manager struct {
	cfg    config.RTC
	opts   Options
	log    *logx.Logger
	api    *webrtc.API
	mux    *ice.UDPMuxDefault
	closed atomic.Bool

	mu      sync.Mutex
	peers   map[string]*peer
	buckets map[string]*offerBucket

	lastError atomic.Value // string
	Counters
}

// New builds a WebRTC manager. A disabled config yields an unavailable manager
// instead of an error so the UDP relay keeps working.
func New(cfg config.RTC, logger *logx.Logger, opts Options) *Manager {
	m := &Manager{
		cfg:     cfg,
		opts:    opts,
		log:     logger,
		peers:   make(map[string]*peer),
		buckets: make(map[string]*offerBucket),
	}
	m.lastError.Store("")
	if !cfg.Enabled {
		m.lastError.Store("WebRTC endpoint is disabled")
		return m
	}
	settingEngine := webrtc.SettingEngine{}
	if cfg.UDPPort > 0 {
		conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: cfg.UDPPort})
		if err != nil {
			m.lastError.Store("failed to bind rtc.udpPort " + strconv.Itoa(cfg.UDPPort) + ": " + err.Error())
			m.log.Warn("rtc_udp_port_bind_failed", logx.F("port", cfg.UDPPort), logx.F("error", err.Error()))
			return m
		}
		m.mux = ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: conn})
		settingEngine.SetICEUDPMux(m.mux)
	}
	if cfg.PublicIP != "" {
		settingEngine.SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}
	m.api = webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))
	m.log.Info("rtc_ready",
		logx.F("implementation", "pion/webrtc"),
		logx.F("maxPeers", cfg.MaxPeers),
		logx.F("maxLifetimeMs", cfg.MaxLifetimeMs),
		logx.F("iceServers", len(cfg.ICEServers)),
		logx.F("udpPort", cfg.UDPPort),
		logx.F("publicIp", cfg.PublicIP),
	)
	return m
}

// Available reports whether WebRTC offers are accepted.
func (m *Manager) Available() bool {
	return m != nil && m.cfg.Enabled && m.api != nil && !m.closed.Load()
}

func buildICEServers(entries []string) []webrtc.ICEServer {
	out := make([]webrtc.ICEServer, 0, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		server := webrtc.ICEServer{URLs: []string{entry}}
		if strings.HasPrefix(entry, "turn:") || strings.HasPrefix(entry, "turns:") {
			if user, pass, ok := splitTurnCredentials(entry); ok {
				server.URLs = []string{stripTurnCredentials(entry)}
				server.Username = user
				server.Credential = pass
				server.CredentialType = webrtc.ICECredentialTypePassword
			}
		}
		out = append(out, server)
	}
	return out
}

func splitTurnCredentials(entry string) (string, string, bool) {
	rest := strings.TrimPrefix(strings.TrimPrefix(entry, "turn:"), "turns:")
	at := strings.LastIndex(rest, "@")
	if at <= 0 {
		return "", "", false
	}
	userinfo := rest[:at]
	colon := strings.Index(userinfo, ":")
	if colon <= 0 || colon == len(userinfo)-1 {
		return "", "", false
	}
	return userinfo[:colon], userinfo[colon+1:], true
}

func stripTurnCredentials(entry string) string {
	prefix := "turn:"
	if strings.HasPrefix(entry, "turns:") {
		prefix = "turns:"
	}
	rest := strings.TrimPrefix(entry, prefix)
	at := strings.LastIndex(rest, "@")
	if at < 0 {
		return entry
	}
	return prefix + rest[at+1:]
}

func newPeerID() string {
	var raw [4]byte
	_, _ = rand.Read(raw[:])
	return "rtc-" + hex.EncodeToString(raw[:])
}

func (m *Manager) allowOfferFromIP(clientIP string) bool {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	bucket, ok := m.buckets[clientIP]
	if !ok {
		limiter, err := ratelimit.NewTokenBucket(
			float64(m.cfg.MaxOffersPerIPPerMinute)/60.0,
			float64(m.cfg.OfferBurst),
			now.UnixMilli(),
		)
		if err != nil {
			return false
		}
		bucket = &offerBucket{bucket: limiter, lastRefill: now}
		m.buckets[clientIP] = bucket
		if len(m.buckets) > maxTrackedRateBuckets {
			for ip, candidate := range m.buckets {
				if now.Sub(candidate.lastRefill) > rateBucketTTL {
					delete(m.buckets, ip)
				}
			}
		}
	}
	bucket.lastRefill = now
	return bucket.bucket.TryRemove(1, now.UnixMilli())
}

// HandleOffer handles a latency-probe offer (data channel is echoed).
func (m *Manager) HandleOffer(offerSDP, clientIP string) (string, error) {
	return m.handleOffer(offerSDP, clientIP, nil, nil)
}

// HandleGameOffer handles a game-transport offer: the data channel is bridged
// to a connected UDP socket for the resolved target.
func (m *Manager) HandleGameOffer(offerSDP, clientIP string, target urlparse.Target, resolved ssrf.Resolved) (string, error) {
	return m.handleOffer(offerSDP, clientIP, &target, &resolved)
}

func (m *Manager) handleOffer(offerSDP, clientIP string, target *urlparse.Target, resolved *ssrf.Resolved) (string, error) {
	m.TotalOffers.Add(1)
	if m.closed.Load() {
		m.RejectedOffers.Add(1)
		return "", relayerr.New(relayerr.RTCDisabled, "Relay is shutting down", 503)
	}
	if !m.cfg.Enabled || m.api == nil {
		m.DisabledRejections.Add(1)
		m.RejectedOffers.Add(1)
		return "", relayerr.New(relayerr.RTCDisabled, "WebRTC endpoint is disabled", 503)
	}
	if len(offerSDP) > m.cfg.MaxOfferBytes {
		m.RejectedOffers.Add(1)
		return "", relayerr.New(relayerr.RTCOfferTooLarge, "Offer body exceeds the configured limit", 413)
	}
	if !m.allowOfferFromIP(clientIP) {
		m.RateLimited.Add(1)
		m.RejectedOffers.Add(1)
		return "", relayerr.New(relayerr.RTCRateLimited, "Too many WebRTC offers from this IP", 429)
	}
	m.mu.Lock()
	if len(m.peers) >= m.cfg.MaxPeers {
		m.mu.Unlock()
		m.BusyRejections.Add(1)
		m.RejectedOffers.Add(1)
		return "", relayerr.New(relayerr.RTCBusy, "Relay has reached its WebRTC peer limit", 503)
	}
	m.mu.Unlock()

	pc, err := m.api.NewPeerConnection(webrtc.Configuration{ICEServers: buildICEServers(m.cfg.ICEServers)})
	if err != nil {
		m.Errors.Add(1)
		m.RejectedOffers.Add(1)
		m.log.Warn("rtc_peer_create_failed", logx.F("clientIp", clientIP), logx.F("error", err.Error()))
		return "", relayerr.New(relayerr.RTCUnavailable, "Failed to create WebRTC peer", 503)
	}

	peerID := newPeerID()
	p := &peer{id: peerID, pc: pc, clientIP: clientIP, createdAt: time.Now(), target: target, resolved: resolved}
	p.lastActivity.Store(time.Now().UnixMilli())
	m.mu.Lock()
	m.peers[peerID] = p
	m.mu.Unlock()

	// Latency-probe peers are short-lived; game peers are closed by idle timeout
	// or when the data channel closes.
	if target == nil {
		p.timer = time.AfterFunc(time.Duration(m.cfg.MaxLifetimeMs)*time.Millisecond, func() {
			m.closePeer(p, "max_lifetime")
		})
	} else {
		m.GameSessionsActive.Add(1)
	}

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		m.ChannelsOpened.Add(1)
		p.dcMu.Lock()
		p.dc = dc
		p.dcMu.Unlock()
		dc.OnOpen(func() {
			if target != nil {
				m.startGameBridge(p)
			}
			p.ready.Store(true)
		})
		dc.OnClose(func() {
			m.closePeer(p, "client_closed")
		})
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			m.onDataChannelMessage(p, msg)
		})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		m.log.Debug("rtc_peer_state", logx.F("peerId", p.id), logx.F("state", state.String()))
		switch state {
		case webrtc.PeerConnectionStateFailed:
			m.closePeer(p, "connection_failed")
		case webrtc.PeerConnectionStateClosed:
			m.closePeer(p, "closed")
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		m.Errors.Add(1)
		m.RejectedOffers.Add(1)
		m.closePeer(p, "invalid_offer")
		return "", relayerr.New(relayerr.RTCInvalidOffer, "Invalid WebRTC offer: "+err.Error(), 400)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		m.Errors.Add(1)
		m.RejectedOffers.Add(1)
		m.closePeer(p, "answer_failed")
		return "", relayerr.New(relayerr.RTCAnswerFailed, "Failed to create WebRTC answer: "+err.Error(), 504)
	}
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		m.Errors.Add(1)
		m.RejectedOffers.Add(1)
		m.closePeer(p, "answer_failed")
		return "", relayerr.New(relayerr.RTCAnswerFailed, "Failed to set WebRTC answer: "+err.Error(), 504)
	}
	timeout := time.Duration(m.cfg.GatherTimeoutMs) * time.Millisecond
	select {
	case <-gatherDone:
	case <-time.After(timeout):
		if local := pc.LocalDescription(); local != nil && strings.Contains(local.SDP, "a=candidate") {
			m.log.Warn("rtc_gather_partial", logx.F("peerId", p.id))
		} else {
			m.Errors.Add(1)
			m.RejectedOffers.Add(1)
			m.closePeer(p, "gather_timeout")
			return "", relayerr.New(relayerr.RTCGatherTimeout, "ICE candidate gathering timed out (relay may have no usable network interface)", 504)
		}
	}
	local := pc.LocalDescription()
	if local == nil || local.SDP == "" {
		m.Errors.Add(1)
		m.RejectedOffers.Add(1)
		m.closePeer(p, "answer_failed")
		return "", relayerr.New(relayerr.RTCAnswerFailed, "Failed to create WebRTC answer", 504)
	}
	m.AnswersCreated.Add(1)
	fields := []logx.Field{logx.F("peerId", p.id), logx.F("clientIp", clientIP), logx.F("answerBytes", len(local.SDP))}
	if target != nil {
		fields = append(fields, logx.F("target", target.String()), logx.F("game", true))
	}
	m.log.Info("rtc_answer_created", fields...)
	return local.SDP, nil
}

func (m *Manager) onDataChannelMessage(p *peer, msg webrtc.DataChannelMessage) {
	if p.closed.Load() || m.closed.Load() {
		return
	}
	p.lastActivity.Store(time.Now().UnixMilli())
	if p.target == nil {
		// Latency probe: echo unchanged, text stays text.
		if msg.IsString {
			if err := m.sendDataChannel(p, []byte{}, string(msg.Data), true); err != nil {
				return
			}
		} else {
			if err := m.sendDataChannel(p, msg.Data, "", false); err != nil {
				return
			}
		}
		p.messages.Add(1)
		p.bytes.Add(int64(len(msg.Data)))
		m.MessagesEchoed.Add(1)
		m.BytesEchoed.Add(int64(len(msg.Data)))
		return
	}
	if msg.IsString {
		// Game transport is binary only.
		if m.opts.Stats != nil {
			m.opts.Stats.OnDrop("rtc_text_frame")
		}
		return
	}
	if len(msg.Data) == 0 {
		if m.opts.Stats != nil {
			m.opts.Stats.OnDrop("rtc_empty_frame")
		}
		return
	}
	p.dcMu.Lock()
	udp := p.udp
	p.dcMu.Unlock()
	if udp == nil || !p.ready.Load() {
		p.pendingMu.Lock()
		limit := m.opts.MaxPendingPackets
		if limit <= 0 {
			limit = 256
		}
		if len(p.pending) >= limit {
			p.pendingMu.Unlock()
			if m.opts.Stats != nil {
				m.opts.Stats.OnDrop("rtc_pending_overflow")
			}
			return
		}
		p.pending = append(p.pending, append([]byte(nil), msg.Data...))
		p.pendingMu.Unlock()
		return
	}
	if _, err := udp.Write(msg.Data); err != nil {
		p.toTarget.Add(int64(len(msg.Data)))
		if m.opts.Stats != nil {
			m.opts.Stats.OnDrop("rtc_udp_send_error")
		}
		return
	}
	p.messages.Add(1)
	p.bytes.Add(int64(len(msg.Data)))
	p.toTarget.Add(int64(len(msg.Data)))
	m.GamePacketsTo.Add(1)
	m.GameBytesTo.Add(int64(len(msg.Data)))
	if m.opts.Stats != nil && p.target != nil {
		m.opts.Stats.OnPacketToTarget(p.target.String(), int64(len(msg.Data)))
	}
}

func (m *Manager) sendDataChannel(p *peer, binary []byte, text string, isString bool) error {
	p.dcMu.Lock()
	dc := p.dc
	p.dcMu.Unlock()
	if dc == nil {
		return errors.New("data channel unavailable")
	}
	var err error
	if isString {
		err = dc.SendText(text)
	} else {
		err = dc.Send(binary)
	}
	if err != nil {
		m.Errors.Add(1)
		m.log.Warn("rtc_send_error", logx.F("peerId", p.id), logx.F("error", err.Error()))
	}
	return err
}

func (m *Manager) startGameBridge(p *peer) {
	if p.target == nil || p.resolved == nil || p.closed.Load() {
		return
	}
	remote := net.UDPAddrFromAddrPort(netip.AddrPortFrom(p.resolved.Address, uint16(p.target.Port)))
	conn, err := net.DialUDP("udp", nil, remote)
	if err != nil {
		m.log.Warn("rtc_udp_dial_error", logx.F("peerId", p.id), logx.F("error", err.Error()))
		m.closePeer(p, "target_unreachable")
		return
	}
	_ = conn.SetReadBuffer(1 << 20)
	_ = conn.SetWriteBuffer(1 << 20)
	p.dcMu.Lock()
	if p.closed.Load() {
		p.dcMu.Unlock()
		_ = conn.Close()
		return
	}
	p.udp = conn
	p.dcMu.Unlock()
	p.ready.Store(true)
	m.log.Info("rtc_game_open",
		logx.F("peerId", p.id),
		logx.F("target", p.target.String()),
		logx.F("address", p.resolved.Address.String()),
		logx.F("clientIp", p.clientIP),
	)
	m.GameSessions.Add(1)
	if m.opts.Stats != nil {
		m.opts.Stats.OnConnectionOpen(p.target.String(), p.clientIP)
	}

	// Flush packets that arrived while the UDP socket was being created.
	p.pendingMu.Lock()
	pending := p.pending
	p.pending = nil
	p.pendingMu.Unlock()
	for _, packet := range pending {
		if _, err := conn.Write(packet); err == nil {
			p.toTarget.Add(int64(len(packet)))
			m.GamePacketsTo.Add(1)
			m.GameBytesTo.Add(int64(len(packet)))
			if m.opts.Stats != nil {
				m.opts.Stats.OnPacketToTarget(p.target.String(), int64(len(packet)))
			}
		}
	}

	// UDP -> DataChannel.
	go func() {
		buffer := make([]byte, 65535)
		for {
			n, readErr := conn.Read(buffer)
			if readErr != nil {
				if p.closed.Load() {
					return
				}
				if isUnreachable(readErr) {
					m.closePeer(p, "target_unreachable")
				} else {
					m.closePeer(p, "udp_error")
				}
				return
			}
			p.lastActivity.Store(time.Now().UnixMilli())
			datagram := append([]byte(nil), buffer[:n]...)
			p.fromTarget.Add(int64(n))
			m.GamePacketsFrom.Add(1)
			m.GameBytesFrom.Add(int64(n))
			if m.opts.Stats != nil {
				m.opts.Stats.OnPacketFromTarget(p.target.String(), int64(n))
			}
			if err := m.sendDataChannel(p, datagram, "", false); err != nil {
				m.closePeer(p, "ws_error")
				return
			}
		}
	}()

	// Idle watchdog.
	go func() {
		interval := m.opts.IdleTimeoutMs / 4
		if interval <= 0 {
			interval = 1000
		}
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
			case <-ticker.C:
				if p.closed.Load() {
					return
				}
				if m.opts.IdleTimeoutMs > 0 && time.Now().UnixMilli()-p.lastActivity.Load() >= m.opts.IdleTimeoutMs {
					m.closePeer(p, "idle_timeout")
					return
				}
			}
		}
	}()
}

func isUnreachable(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH) ||
		errors.Is(err, syscall.EACCES) ||
		errors.Is(err, syscall.EPERM)
}

func (m *Manager) closePeer(p *peer, reason string) {
	if p == nil || !p.closed.CompareAndSwap(false, true) {
		return
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	m.mu.Lock()
	delete(m.peers, p.id)
	m.mu.Unlock()
	m.PeersClosed.Add(1)
	p.dcMu.Lock()
	udp := p.udp
	p.udp = nil
	dc := p.dc
	p.dc = nil
	p.dcMu.Unlock()
	if udp != nil {
		_ = udp.Close()
	}
	if dc != nil {
		_ = dc.Close()
	}
	_ = p.pc.Close()
	if p.target != nil {
		m.GameSessionsActive.Add(-1)
		if m.opts.Stats != nil {
			m.opts.Stats.OnConnectionClose(p.target.String(), reason)
		}
	}
	m.log.Info("rtc_peer_closed",
		logx.F("peerId", p.id),
		logx.F("clientIp", p.clientIP),
		logx.F("reason", reason),
		logx.F("ageMs", time.Since(p.createdAt).Milliseconds()),
		logx.F("messages", p.messages.Load()),
		logx.F("bytes", p.bytes.Load()),
		logx.F("toTarget", p.toTarget.Load()),
		logx.F("fromTarget", p.fromTarget.Load()),
	)
}

// Close releases every active peer (server shutdown).
func (m *Manager) Close() {
	if m == nil || !m.closed.CompareAndSwap(false, true) {
		return
	}
	m.mu.Lock()
	peers := make([]*peer, 0, len(m.peers))
	for _, p := range m.peers {
		peers = append(peers, p)
	}
	m.mu.Unlock()
	for _, p := range peers {
		m.closePeer(p, "server_shutdown")
	}
	if m.mux != nil {
		_ = m.mux.Close()
		m.mux = nil
	}
	m.mu.Lock()
	m.buckets = make(map[string]*offerBucket)
	m.mu.Unlock()
}

// Snapshot returns the counters in the same shape as the Node relay's
// rtc.snapshot() so /api/stats stays compatible, plus game-transport counters.
func (m *Manager) Snapshot() map[string]any {
	if m == nil {
		return map[string]any{"enabled": false, "available": false}
	}
	m.mu.Lock()
	active := len(m.peers)
	m.mu.Unlock()
	return map[string]any{
		"enabled":                 m.cfg.Enabled,
		"available":               m.Available(),
		"activePeers":             active,
		"maxPeers":                m.cfg.MaxPeers,
		"maxLifetimeMs":           m.cfg.MaxLifetimeMs,
		"maxOfferBytes":           m.cfg.MaxOfferBytes,
		"maxOffersPerIpPerMinute": m.cfg.MaxOffersPerIPPerMinute,
		"totalOffers":             m.TotalOffers.Load(),
		"answersCreated":          m.AnswersCreated.Load(),
		"rejectedOffers":          m.RejectedOffers.Load(),
		"rateLimited":             m.RateLimited.Load(),
		"busyRejections":          m.BusyRejections.Load(),
		"disabledRejections":      m.DisabledRejections.Load(),
		"peersClosed":             m.PeersClosed.Load(),
		"channelsOpened":          m.ChannelsOpened.Load(),
		"messagesEchoed":          m.MessagesEchoed.Load(),
		"bytesEchoed":             m.BytesEchoed.Load(),
		"gameSessions":            m.GameSessions.Load(),
		"activeGameSessions":      m.GameSessionsActive.Load(),
		"gamePacketsToTarget":     m.GamePacketsTo.Load(),
		"gamePacketsFromTarget":   m.GamePacketsFrom.Load(),
		"gameBytesToTarget":       m.GameBytesTo.Load(),
		"gameBytesFromTarget":     m.GameBytesFrom.Load(),
		"errors":                  m.Errors.Load(),
		"lastError":               lastErrorString(m),
	}
}

func lastErrorString(m *Manager) any {
	if m == nil {
		return nil
	}
	if value, ok := m.lastError.Load().(string); ok && value != "" {
		return value
	}
	return nil
}
