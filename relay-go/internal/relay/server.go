// Package relay implements the WSS -> UDP relay server: the HTTP API, the
// WebSocket upgrade path and one UDP session per WebSocket client.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ddnet-relay-go/internal/auth"
	"ddnet-relay-go/internal/config"
	"ddnet-relay-go/internal/logx"
	"ddnet-relay-go/internal/ratelimit"
	"ddnet-relay-go/internal/relayerr"
	"ddnet-relay-go/internal/rtc"
	"ddnet-relay-go/internal/ssrf"
	"ddnet-relay-go/internal/stats"
	"ddnet-relay-go/internal/urlparse"
	"ddnet-relay-go/internal/wsproto"
)

// Options configures a Server. All fields are optional.
type Options struct {
	Logger *logx.Logger
	Stats  *stats.Stats
	// Lookup overrides DNS resolution (tests).
	Lookup ssrf.LookupFunc
}

// Server is the relay server.
type Server struct {
	cfg       *config.Config
	log       *logx.Logger
	stats     *stats.Stats
	policy    *ssrf.Policy
	ipLimiter *ratelimit.IPConnectionLimiter
	lookup    ssrf.LookupFunc
	rtc       *rtc.Manager

	mu       sync.Mutex
	sessions map[*Session]struct{}

	httpServer *http.Server
	listener   net.Listener
	closing    atomic.Bool

	shutdownOnce sync.Once
	shutdownErr  error
}

// NewServer validates the config-derived policy and builds the server.
func NewServer(cfg *config.Config, options Options) (*Server, error) {
	if cfg == nil {
		return nil, errors.New("relay: config is required")
	}
	policy, err := ssrf.NewPolicy(cfg.Security.AllowPrivate, cfg.Security.Allowlist)
	if err != nil {
		return nil, err
	}
	logger := options.Logger
	if logger == nil {
		logger = logx.New(logx.Info, nil)
	}
	statsStore := options.Stats
	if statsStore == nil {
		statsStore = stats.New()
	}
	lookup := options.Lookup
	if lookup == nil {
		lookup = ssrf.DefaultLookup
	}
	rtcManager := rtc.New(cfg.RTC, logger, rtc.Options{
		Stats:             statsStore,
		IdleTimeoutMs:     cfg.Limits.IdleTimeoutMs,
		MaxBufferedBytes:  cfg.Limits.MaxBufferedBytes,
		MaxPendingPackets: cfg.Limits.MaxPendingPackets,
	})
	return &Server{
		cfg:       cfg,
		log:       logger,
		stats:     statsStore,
		policy:    policy,
		ipLimiter: ratelimit.NewIPConnectionLimiter(cfg.Limits.MaxConnectionsPerIP),
		lookup:    lookup,
		rtc:       rtcManager,
		sessions:  make(map[*Session]struct{}),
	}, nil
}

// Stats exposes the aggregate statistics store.
func (s *Server) Stats() *stats.Stats { return s.stats }

// Config returns the effective configuration.
func (s *Server) Config() *config.Config { return s.cfg }

// SessionsCount returns the number of live sessions.
func (s *Server) SessionsCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

func (s *Server) addSession(session *Session) {
	s.mu.Lock()
	s.sessions[session] = struct{}{}
	s.mu.Unlock()
}

func (s *Server) removeSession(session *Session) {
	s.mu.Lock()
	delete(s.sessions, session)
	s.mu.Unlock()
}

func (s *Server) sessionList() []*Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Session, 0, len(s.sessions))
	for session := range s.sessions {
		out = append(out, session)
	}
	return out
}

// Start binds the TCP listener and begins serving. Port 0 picks an ephemeral
// port (useful for tests).
func (s *Server) Start() error {
	address := net.JoinHostPort(s.cfg.Host, strconv.Itoa(s.cfg.Port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	s.listener = listener
	s.httpServer = &http.Server{
		Handler:           http.HandlerFunc(s.handleHTTP),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		serveErr := s.httpServer.Serve(listener)
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) && !s.closing.Load() {
			s.log.Error("http_serve_error", logx.F("error", serveErr.Error()))
		}
	}()

	if len(s.cfg.Auth.Tokens) == 0 {
		s.log.Warn("auth_disabled", logx.F("message", "No relay tokens configured; all clients are accepted"))
	}
	if len(s.cfg.Auth.OriginAllowlist) == 0 {
		s.log.Warn("origin_allowlist_empty", logx.F("message", "No Origin allowlist configured; browser Origins are not restricted"))
	}
	if s.cfg.Security.AllowPrivate {
		s.log.Warn("private_targets_allowed", logx.F("message", "ALLOW_PRIVATE is enabled; private/loopback targets are permitted"))
	}

	host, port := s.BoundAddress()
	endpoint := net.JoinHostPort(host, strconv.Itoa(port))
	s.log.Info("relay_listening",
		logx.F("host", host),
		logx.F("port", port),
		logx.F("udpPath", s.cfg.UDPPath),
		logx.F("version", config.Version),
	)
	s.log.Info("relay_started",
		logx.F("url", "ws://"+endpoint+s.cfg.UDPPath+"/<host>:<port>"),
		logx.F("healthz", "http://"+endpoint+"/healthz"),
		logx.F("config", config.Describe(s.cfg)),
	)
	return nil
}

// BoundAddress returns the actual listening host/port.
func (s *Server) BoundAddress() (string, int) {
	if s.listener == nil {
		return s.cfg.Host, s.cfg.Port
	}
	if tcpAddress, ok := s.listener.Addr().(*net.TCPAddr); ok {
		return tcpAddress.IP.String(), tcpAddress.Port
	}
	host, portText, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil {
		return s.cfg.Host, s.cfg.Port
	}
	port, _ := strconv.Atoi(portText)
	return host, port
}

// HTTPBaseURL returns the base URL for the HTTP API.
func (s *Server) HTTPBaseURL() string {
	host, port := s.BoundAddress()
	displayHost := host
	if displayHost == "0.0.0.0" || displayHost == "::" || displayHost == "" {
		displayHost = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(displayHost, strconv.Itoa(port))
}

// Shutdown gracefully stops the relay: stop accepting, close all sessions with
// 1001 server_shutdown, then force-terminate stragglers.
func (s *Server) Shutdown(ctx context.Context) error {
	s.shutdownOnce.Do(func() {
		s.closing.Store(true)
		s.log.Info("shutdown_start", logx.F("activeConnections", s.stats.ActiveConnections()))
		s.rtc.Close()
		if s.httpServer != nil {
			shutdownContext, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
			shutdownErr := s.httpServer.Shutdown(shutdownContext)
			cancel()
			if shutdownErr != nil && !errors.Is(shutdownErr, context.DeadlineExceeded) {
				s.log.Warn("http_shutdown_error", logx.F("error", shutdownErr.Error()))
			}
		}
		for _, session := range s.sessionList() {
			session.close("server_shutdown", 1001)
		}
		deadline := time.Now().Add(1500 * time.Millisecond)
		for time.Now().Before(deadline) {
			if s.SessionsCount() == 0 {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		for _, session := range s.sessionList() {
			session.forceTerminate()
		}
		s.log.Info("shutdown_complete", logx.F("closedConnections", s.stats.ClosedConnections()))
	})
	return s.shutdownErr
}

// Close is an alias for Shutdown(context.Background()) for tests and callers
// that do not care about the context.
func (s *Server) Close() error { return s.Shutdown(context.Background()) }

// GetClientIP resolves the client address, honouring X-Forwarded-For only when
// trustProxy is enabled.
func GetClientIP(request *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
			first := strings.TrimSpace(strings.Split(forwarded, ",")[0])
			if addr, ok := ssrf.NormalizeAddress(first); ok {
				return addr.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	if addr, ok := ssrf.NormalizeAddress(host); ok {
		return addr.String()
	}
	return host
}

func formatTime(now time.Time) string {
	return now.UTC().Format("2006-01-02T15:04:05.000Z")
}

type corsHeaders map[string]string

func (s *Server) corsFor(request *http.Request) corsHeaders {
	allowed := s.cfg.API.CORSOrigins
	origin := request.Header.Get("Origin")
	for _, entry := range allowed {
		if entry == "*" {
			return corsHeaders{
				"Access-Control-Allow-Origin":  "*",
				"Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
				"Access-Control-Allow-Headers": "authorization, x-relay-token, content-type",
			}
		}
	}
	if origin != "" {
		for _, entry := range allowed {
			if strings.EqualFold(strings.TrimSpace(entry), origin) {
				return corsHeaders{
					"Access-Control-Allow-Origin":  origin,
					"Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
					"Access-Control-Allow-Headers": "authorization, x-relay-token, content-type",
					"Vary":                         "Origin",
				}
			}
		}
	}
	return corsHeaders{}
}

func mergeHeaders(groups ...map[string]string) map[string]string {
	out := make(map[string]string)
	for _, group := range groups {
		for key, value := range group {
			out[key] = value
		}
	}
	return out
}

func writeJSON(writer http.ResponseWriter, request *http.Request, status int, body any, headers map[string]string) {
	payload, err := json.Marshal(body)
	if err != nil {
		payload = []byte(`{"error":"Internal relay error","code":"internal_error"}`)
		status = http.StatusInternalServerError
	}
	responseHeaders := writer.Header()
	responseHeaders.Set("Content-Type", "application/json; charset=utf-8")
	responseHeaders.Set("Cache-Control", "no-store")
	responseHeaders.Set("Content-Length", strconv.Itoa(len(payload)))
	for key, value := range headers {
		responseHeaders.Set(key, value)
	}
	writer.WriteHeader(status)
	if request != nil && request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(payload)
}

func writeRelayError(writer http.ResponseWriter, request *http.Request, err error, headers map[string]string) {
	status, code, message := relayerr.Status(err)
	writeJSON(writer, request, status, map[string]any{"error": message, "code": code}, headers)
}

func (s *Server) handleHTTP(writer http.ResponseWriter, request *http.Request) {
	// WebSocket upgrade requests are routed before the plain HTTP API, exactly
	// like the Node ws server's 'upgrade' event.
	if wsproto.IsUpgrade(request) {
		if request.URL.Path == "/ws" {
			s.handleHealthUpgrade(writer, request)
			return
		}
		s.handleUpgrade(writer, request)
		return
	}

	cors := s.corsFor(request)
	if request.Method == http.MethodOptions {
		headers := writer.Header()
		for key, value := range cors {
			headers.Set(key, value)
		}
		headers.Set("Access-Control-Max-Age", "600")
		writer.WriteHeader(http.StatusNoContent)
		return
	}

	pathname := request.URL.Path
	if pathname == "/rtc/offer" {
		s.handleRTCOffer(writer, request, cors)
		return
	}

	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writeJSON(writer, request, http.StatusMethodNotAllowed,
			map[string]any{"error": "Method not allowed", "code": relayerr.MethodNotAllowed},
			mergeHeaders(cors, map[string]string{"Allow": "GET, HEAD, OPTIONS"}))
		return
	}

	switch pathname {
	case "/healthz":
		host, port := s.BoundAddress()
		s.writeJSONResponse(writer, request, http.StatusOK, map[string]any{
			"status":            "ok",
			"service":           "ddnet-ws-relay",
			"version":           config.Version,
			"activeConnections": s.SessionsCount(),
			"rtc":               s.rtc.Available(),
			"uptimeSec":         s.stats.UptimeSec(),
			"time":              formatTime(time.Now()),
			"address":           map[string]any{"host": host, "port": port},
		}, cors)
	case "/api/info":
		s.writeJSONResponse(writer, request, http.StatusOK, map[string]any{
			"name":              s.cfg.Name,
			"version":           config.Version,
			"protocol":          config.Protocol,
			"region":            s.cfg.Region,
			"rtc":               s.rtc.Available(),
			"iceServers":        append([]string{}, s.cfg.RTC.ICEServers...),
			"uptimeSec":         s.stats.UptimeSec(),
			"activeConnections": s.SessionsCount(),
			"time":              formatTime(time.Now()),
		}, cors)
	case "/api/stats":
		if !s.cfg.API.StatsEnabled {
			writeJSON(writer, request, http.StatusNotFound,
				map[string]any{"error": "Not found", "code": relayerr.NotFound}, cors)
			return
		}
		s.writeJSONResponse(writer, request, http.StatusOK, s.stats.Map(map[string]any{
			"service": "ddnet-ws-relay",
			"version": config.Version,
			"limits": map[string]any{
				"maxConnectionsPerIp": s.cfg.Limits.MaxConnectionsPerIP,
				"maxConnectionsTotal": s.cfg.Limits.MaxConnectionsTotal,
				"maxFrameBytes":       s.cfg.Limits.MaxFrameBytes,
				"maxPacketsPerSecond": s.cfg.Limits.MaxPacketsPerSecond,
				"maxBytesPerSecond":   s.cfg.Limits.MaxBytesPerSecond,
				"idleTimeoutMs":       s.cfg.Limits.IdleTimeoutMs,
				"maxConnectionMs":     s.cfg.Limits.MaxConnectionMs,
			},
			"security": map[string]any{
				"allowPrivate":      s.cfg.Security.AllowPrivate,
				"tokensConfigured":  len(s.cfg.Auth.Tokens),
				"originsConfigured": len(s.cfg.Auth.OriginAllowlist),
			},
			"config": config.Printable(s.cfg),
			"rtc":    s.rtcSnapshot(),
		}), cors)
	case "/api/servers":
		if !s.cfg.API.ServersEnabled {
			writeJSON(writer, request, http.StatusNotFound,
				map[string]any{"error": "Not found", "code": relayerr.NotFound}, cors)
			return
		}
		servers := s.cfg.Servers
		if servers == nil {
			servers = []config.Server{}
		}
		s.writeJSONResponse(writer, request, http.StatusOK, map[string]any{
			"servers":     servers,
			"count":       len(servers),
			"generatedAt": formatTime(time.Now()),
		}, cors)
	default:
		writeJSON(writer, request, http.StatusNotFound,
			map[string]any{"error": "Not found", "code": relayerr.NotFound}, cors)
	}
}

// writeJSONResponse exists so the corsHeaders map can be passed directly.
func (s *Server) writeJSONResponse(writer http.ResponseWriter, request *http.Request, status int, body any, cors corsHeaders) {
	writeJSON(writer, request, status, body, map[string]string(cors))
}

func (s *Server) rtcSnapshot() map[string]any {
	return s.rtc.Snapshot()
}

func (s *Server) handleRTCOffer(writer http.ResponseWriter, request *http.Request, cors corsHeaders) {
	if request.Method != http.MethodPost {
		writeJSON(writer, request, http.StatusMethodNotAllowed,
			map[string]any{"error": "Method not allowed", "code": relayerr.MethodNotAllowed},
			mergeHeaders(map[string]string(cors), map[string]string{"Allow": "POST, OPTIONS"}))
		return
	}

	origin := urlparse.ExtractOrigin(request.Header)
	if result := auth.CheckOrigin(origin, s.cfg.Auth.OriginAllowlist, s.cfg.Auth.AllowNoOrigin); !result.OK {
		s.stats.OnAuthFailure("origin")
		s.log.Warn("rtc_origin_rejected", logx.F("origin", origin), logx.F("reason", result.Reason))
		displayOrigin := origin
		if displayOrigin == "" {
			displayOrigin = "null"
		}
		writeRelayError(writer, request, relayerr.New(relayerr.OriginDenied, "Origin not allowed: "+displayOrigin, 403), map[string]string(cors))
		return
	}

	token := urlparse.ExtractToken(request.URL, request.Header, s.cfg.Auth.TokenHeader)
	if result := auth.CheckToken(token, s.cfg.Auth.Tokens); !result.OK {
		s.stats.OnAuthFailure(result.Reason)
		s.log.Warn("rtc_auth_rejected",
			logx.F("reason", result.Reason),
			logx.F("remote", GetClientIP(request, s.cfg.TrustProxy)),
		)
		writeRelayError(writer, request, relayerr.New(relayerr.Unauthorized, "Invalid or missing relay token", 401),
			mergeHeaders(map[string]string(cors), map[string]string{"WWW-Authenticate": `Bearer realm="ddnet-relay"`}))
		return
	}

	if !s.cfg.RTC.Enabled {
		writeRelayError(writer, request, relayerr.New(relayerr.RTCDisabled, "WebRTC endpoint is disabled", 503), map[string]string(cors))
		return
	}

	// Read and validate the SDP offer. The body limit mirrors the Node relay's
	// maxOfferBytes and is enforced before JSON decoding.
	maxOfferBytes := int64(s.cfg.RTC.MaxOfferBytes)
	if maxOfferBytes <= 0 {
		maxOfferBytes = 262144
	}
	if request.ContentLength > maxOfferBytes {
		writeRelayError(writer, request, relayerr.New(relayerr.RTCOfferTooLarge, "Offer body exceeds the configured limit", 413), map[string]string(cors))
		return
	}
	body, readErr := io.ReadAll(io.LimitReader(request.Body, maxOfferBytes+1))
	if readErr != nil {
		writeRelayError(writer, request, relayerr.New(relayerr.RTCInvalidOffer, "Failed to read request body", 400), map[string]string(cors))
		return
	}
	if int64(len(body)) > maxOfferBytes {
		writeRelayError(writer, request, relayerr.New(relayerr.RTCOfferTooLarge, "Offer body exceeds the configured limit", 413), map[string]string(cors))
		return
	}
	var payload struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeRelayError(writer, request, relayerr.New(relayerr.RTCInvalidOffer, "Request body must be valid JSON", 400), map[string]string(cors))
		return
	}
	if payload.Type != "" && !strings.EqualFold(payload.Type, "offer") {
		writeRelayError(writer, request, relayerr.New(relayerr.RTCInvalidOffer, `Expected a WebRTC "offer" payload`, 400), map[string]string(cors))
		return
	}
	// Keep the raw SDP: pion's SDP parser requires the trailing newline that
	// Chrome/Firefox always send. Trimming it produces a confusing "EOF" error.
	sdp := payload.SDP
	checkSDP := strings.TrimSpace(sdp)
	if len(checkSDP) < 20 || !strings.HasPrefix(checkSDP, "v=0") || !strings.Contains(checkSDP, "m=application") {
		writeRelayError(writer, request, relayerr.New(relayerr.RTCInvalidOffer, `Offer "sdp" must be a valid data-channel SDP (v=0, m=application)`, 400), map[string]string(cors))
		return
	}
	if !strings.HasSuffix(sdp, "\n") {
		sdp += "\r\n"
	}

	clientIP := GetClientIP(request, s.cfg.TrustProxy)
	targetParam := strings.TrimSpace(request.URL.Query().Get("target"))

	var answer string
	var answerErr error
	if targetParam != "" {
		// Game transport: the data channel carries UDP datagrams for this target.
		target, err := urlparse.SplitHostPort(targetParam, urlparse.DefaultTargetPort)
		if err != nil {
			writeRelayError(writer, request, err, map[string]string(cors))
			return
		}
		resolved, err := ssrf.ResolveTarget(
			request.Context(),
			target.Host,
			s.policy,
			s.lookup,
			time.Duration(s.cfg.Security.DNSTimeoutMs)*time.Millisecond,
		)
		if err != nil {
			code := relayerr.CodeOf(err, relayerr.TargetNotAllowed)
			s.stats.OnTargetRejected(code)
			s.log.Warn("rtc_target_rejected",
				logx.F("target", target.String()),
				logx.F("clientIp", clientIP),
				logx.F("code", code),
				logx.F("message", err.Error()),
			)
			writeRelayError(writer, request, err, map[string]string(cors))
			return
		}
		s.log.Info("rtc_game_offer", logx.F("target", target.String()), logx.F("clientIp", clientIP), logx.F("offerBytes", len(sdp)))
		answer, answerErr = s.rtc.HandleGameOffer(sdp, clientIP, target, resolved)
	} else {
		answer, answerErr = s.rtc.HandleOffer(sdp, clientIP)
	}
	if answerErr != nil {
		s.log.Warn("rtc_offer_rejected", logx.F("clientIp", clientIP), logx.F("error", answerErr.Error()))
		writeRelayError(writer, request, answerErr, map[string]string(cors))
		return
	}
	writeJSON(writer, request, http.StatusOK, map[string]any{"type": "answer", "sdp": answer}, map[string]string(cors))
}

// handleHealthUpgrade accepts a WebSocket handshake on /ws and immediately
// closes it. The master uses this to verify that a relay is reachable before
// accepting its registration and during periodic liveness checks.
func (s *Server) handleHealthUpgrade(writer http.ResponseWriter, request *http.Request) {
	if s.closing.Load() {
		writeRelayError(writer, request, relayerr.New(relayerr.ServerBusy, "Relay is shutting down", 503), nil)
		return
	}
	if err := wsproto.ValidateUpgrade(request); err != nil {
		writeRelayError(writer, request, relayerr.New(relayerr.BadHandshake, err.Message, err.Status), err.Headers)
		return
	}
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		writeRelayError(writer, request, relayerr.New(relayerr.Internal, "Internal relay error", 500), nil)
		return
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	if err := wsproto.Upgrade(buffered.Writer, request); err != nil {
		return
	}
	s.log.Debug("health_ws_probe", logx.F("remote", GetClientIP(request, s.cfg.TrustProxy)))
}

func (s *Server) handleUpgrade(writer http.ResponseWriter, request *http.Request) {
	if s.closing.Load() {
		writeRelayError(writer, request, relayerr.New(relayerr.ServerBusy, "Relay is shutting down", 503), nil)
		return
	}
	// Validate the RFC 6455 handshake up front but keep the relay-specific
	// validation order of the Node relay: target -> origin -> token -> limits ->
	// DNS -> handshake.
	if err := wsproto.ValidateUpgrade(request); err != nil {
		writeRelayError(writer, request, relayerr.New(relayerr.BadHandshake, err.Message, err.Status), err.Headers)
		return
	}

	relayRequest, err := urlparse.ParseRelayRequest(request.RequestURI, request.Header, s.cfg.UDPPath, s.cfg.Auth.TokenHeader)
	if err != nil {
		s.log.Warn("request_rejected",
			logx.F("reason", relayerr.CodeOf(err, relayerr.BadTarget)),
			logx.F("remote", GetClientIP(request, s.cfg.TrustProxy)),
		)
		writeRelayError(writer, request, err, nil)
		return
	}

	origin := urlparse.ExtractOrigin(request.Header)
	if result := auth.CheckOrigin(origin, s.cfg.Auth.OriginAllowlist, s.cfg.Auth.AllowNoOrigin); !result.OK {
		s.stats.OnAuthFailure("origin")
		s.log.Warn("origin_rejected", logx.F("origin", origin), logx.F("reason", result.Reason))
		displayOrigin := origin
		if displayOrigin == "" {
			displayOrigin = "null"
		}
		writeRelayError(writer, request, relayerr.New(relayerr.OriginDenied, "Origin not allowed: "+displayOrigin, 403), nil)
		return
	}
	if result := auth.CheckToken(relayRequest.Token, s.cfg.Auth.Tokens); !result.OK {
		s.stats.OnAuthFailure(result.Reason)
		s.log.Warn("auth_rejected",
			logx.F("reason", result.Reason),
			logx.F("remote", GetClientIP(request, s.cfg.TrustProxy)),
		)
		writeRelayError(writer, request, relayerr.New(relayerr.Unauthorized, "Invalid or missing relay token", 401),
			map[string]string{"WWW-Authenticate": `Bearer realm="ddnet-relay"`})
		return
	}

	if int64(s.SessionsCount()) >= int64(s.cfg.Limits.MaxConnectionsTotal) {
		s.stats.OnTargetRejected("server_busy")
		writeRelayError(writer, request, relayerr.New(relayerr.ServerBusy, "Relay is at capacity", 503), nil)
		return
	}

	clientIP := GetClientIP(request, s.cfg.TrustProxy)
	if !s.ipLimiter.Acquire(clientIP) {
		s.stats.OnTargetRejected("ip_limit")
		s.log.Warn("ip_limit_rejected", logx.F("clientIp", clientIP), logx.F("active", s.ipLimiter.Count(clientIP)))
		writeRelayError(writer, request, relayerr.New(relayerr.TooManyConnections, "Too many connections from "+clientIP, 429), nil)
		return
	}
	var released atomic.Bool
	releaseIP := func() {
		if released.CompareAndSwap(false, true) {
			s.ipLimiter.Release(clientIP)
		}
	}

	resolved, err := ssrf.ResolveTarget(
		request.Context(),
		relayRequest.Target.Host,
		s.policy,
		s.lookup,
		time.Duration(s.cfg.Security.DNSTimeoutMs)*time.Millisecond,
	)
	if err != nil {
		releaseIP()
		code := relayerr.CodeOf(err, relayerr.TargetNotAllowed)
		s.stats.OnTargetRejected(code)
		s.log.Warn("target_rejected",
			logx.F("target", relayRequest.Target.String()),
			logx.F("clientIp", clientIP),
			logx.F("code", code),
			logx.F("message", err.Error()),
		)
		writeRelayError(writer, request, err, nil)
		return
	}

	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		releaseIP()
		writeRelayError(writer, request, relayerr.New(relayerr.Internal, "Internal relay error", 500), nil)
		return
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		releaseIP()
		return
	}
	if err := wsproto.Upgrade(buffered.Writer, request); err != nil {
		releaseIP()
		_ = conn.Close()
		return
	}
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
		_ = tcpConn.SetKeepAlive(true)
		_ = tcpConn.SetKeepAlivePeriod(30 * time.Second)
	}

	websocket := wsproto.NewServerConn(conn, buffered.Reader, buffered.Writer, s.cfg.Limits.HardMaxFrameBytes)
	session := newSession(s, websocket, relayRequest.Target, resolved, clientIP, origin, releaseIP)
	s.addSession(session)
	session.start()
}
