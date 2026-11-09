package master

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"ddnet-relay-go/internal/logx"
)

// Options configures the master HTTP handler.
type Options struct {
	Registry             *Registry
	HeartbeatInterval    time.Duration
	ProbeTimeout         time.Duration
	ProbeInterval        time.Duration
	Version              string
	CORSOrigins          []string
	TrustProxy           bool
	RegisterPerMinute    int
	SignalProxyPerMinute int
	PublicURL            string
	Logger               *logx.Logger
}

// Handler serves the master API.
type Handler struct {
	registry      *Registry
	options       Options
	limiter       *ipLimiter
	signalLimiter *ipLimiter
}

func NewHandler(options Options) (*Handler, error) {
	if options.Registry == nil {
		return nil, fmt.Errorf("registry is required")
	}
	if options.HeartbeatInterval <= 0 {
		options.HeartbeatInterval = 30 * time.Second
	}
	if options.ProbeTimeout <= 0 {
		options.ProbeTimeout = 5 * time.Second
	}
	if options.ProbeInterval <= 0 {
		options.ProbeInterval = 15 * time.Minute
	}
	if options.Version == "" {
		options.Version = "1.0.0"
	}
	if len(options.CORSOrigins) == 0 {
		options.CORSOrigins = []string{"*"}
	}
	if options.SignalProxyPerMinute <= 0 {
		options.SignalProxyPerMinute = 120
	}
	return &Handler{
		registry:      options.Registry,
		options:       options,
		limiter:       newIPLimiter(options.RegisterPerMinute, time.Minute),
		signalLimiter: newIPLimiter(options.SignalProxyPerMinute, time.Minute),
	}, nil
}

type registerRequest struct {
	Name       string      `json:"name"`
	Region     string      `json:"region"`
	Version    string      `json:"version"`
	Players    int         `json:"players"`
	Transports []Transport `json:"transports"`
}

type unregisterRequest struct {
	Transports []Transport `json:"transports"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/signal/") {
		h.handleSignalProxy(w, r)
		return
	}
	switch {
	case r.URL.Path == "/healthz" && r.Method == http.MethodGet:
		h.writeJSON(w, http.StatusOK, map[string]any{
			"ok":              true,
			"service":         "ddnet-relay-master",
			"version":         h.options.Version,
			"nodes":           h.registry.Count(),
			"probeIntervalMs": h.options.ProbeInterval.Milliseconds(),
			"time":            time.Now().UTC().Format(time.RFC3339Nano),
		})
	case r.URL.Path == "/v1/serverlist" && r.Method == http.MethodGet:
		nodes := h.registry.List()
		for i := range nodes {
			for j := range nodes[i].Transports {
				transport := &nodes[i].Transports[j]
				if transport.Type == "webrtc" {
					transport.SignalURL = h.publicSignalURL(r, transport.SignalURL)
				}
			}
		}
		h.writeJSON(w, http.StatusOK, map[string]any{
			"count":       len(nodes),
			"generatedAt": time.Now().UTC().Format(time.RFC3339Nano),
			"servers":     nodes,
		})
	case r.URL.Path == "/v1/register" && r.Method == http.MethodPost:
		h.handleRegister(w, r)
	case r.URL.Path == "/v1/unregister" && r.Method == http.MethodPost:
		h.handleUnregister(w, r)
	case r.URL.Path == "/api/stats" && r.Method == http.MethodGet:
		h.writeJSON(w, http.StatusOK, map[string]any{
			"service":         "ddnet-relay-master",
			"version":         h.options.Version,
			"nodes":           h.registry.Count(),
			"probeIntervalMs": h.options.ProbeInterval.Milliseconds(),
			"probeTimeoutMs":  h.options.ProbeTimeout.Milliseconds(),
			"time":            time.Now().UTC().Format(time.RFC3339Nano),
		})
	default:
		h.writeError(w, http.StatusNotFound, "not found")
	}
}

func (h *Handler) handleRegister(w http.ResponseWriter, r *http.Request) {
	ip := h.remoteIP(r)
	if h.limiter != nil && !h.limiter.Allow(ip) {
		h.writeError(w, http.StatusTooManyRequests, "too many registrations")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32*1024)
	defer r.Body.Close()
	var req registerRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	transports, err := normalizeTransports(req.Transports)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	key, err := NodeKey(transports)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	_, exists := h.registry.Get(key)
	existingVerified := make(map[string]Transport)
	if exists {
		for _, transport := range h.registry.VerifiedTransports(key) {
			existingVerified[transportID(transport)] = transport
		}
	}
	node, err := h.registry.Register(Node{
		Name:       req.Name,
		Region:     req.Region,
		Version:    req.Version,
		Players:    req.Players,
		Transports: transports,
	})
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	probeStart := time.Now()
	probed := 0
	var failures []string
	for _, transport := range transports {
		if _, ok := existingVerified[transportID(transport)]; ok {
			continue
		}
		probed++
		var probeErr error
		switch transport.Type {
		case "websocket":
			probeErr = ProbeWebSocket(r.Context(), transport.URL, h.options.ProbeTimeout)
		case "webrtc":
			probeErr = ProbeWebRTC(r.Context(), transport, h.options.ProbeTimeout)
		default:
			probeErr = fmt.Errorf("unsupported transport %q", transport.Type)
		}
		if probeErr != nil {
			failures = append(failures, transport.Type+": "+probeErr.Error())
			if h.options.Logger != nil {
				h.options.Logger.Warn("master_register_probe_failed",
					logx.F("node", key),
					logx.F("transport", transport.Type),
					logx.F("remoteIp", ip),
					logx.F("error", probeErr.Error()),
				)
			}
			continue
		}
		h.registry.MarkTransportVerified(key, transport, time.Now().UTC())
	}
	if !h.registry.HasVerified(key) {
		h.registry.Remove(key)
		message := "no relay transport verified"
		if len(failures) > 0 {
			message += ": " + strings.Join(failures, "; ")
		}
		h.writeError(w, http.StatusBadGateway, message)
		return
	}
	verified := h.registry.VerifiedTransports(key)
	if h.options.Logger != nil {
		h.options.Logger.Info("master_register",
			logx.F("node", key),
			logx.F("name", node.Name),
			logx.F("region", node.Region),
			logx.F("remoteIp", ip),
			logx.F("probed", probed),
			logx.F("transports", len(verified)),
			logx.F("probeMs", time.Since(probeStart).Milliseconds()),
			logx.F("nodes", h.registry.Count()),
		)
	}
	h.writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"key":           key,
		"transports":    verified,
		"verified":      true,
		"probed":        probed > 0,
		"probeMs":       time.Since(probeStart).Milliseconds(),
		"intervalMs":    h.options.HeartbeatInterval.Milliseconds(),
		"healthCheckMs": h.options.ProbeInterval.Milliseconds(),
		"count":         h.registry.Count(),
	})
}

func (h *Handler) handleUnregister(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 32*1024)
	defer r.Body.Close()
	var req unregisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	key, err := NodeKey(req.Transports)
	if err != nil {
		h.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	removed := h.registry.Remove(key)
	h.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": removed, "count": h.registry.Count()})
}

func (h *Handler) remoteIP(r *http.Request) string {
	if h.options.TrustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			if index := strings.IndexByte(forwarded, ','); index >= 0 {
				forwarded = forwarded[:index]
			}
			if value := strings.TrimSpace(forwarded); value != "" {
				return value
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (h *Handler) setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	allowed := ""
	for _, candidate := range h.options.CORSOrigins {
		if candidate == "*" {
			allowed = "*"
			break
		}
		if origin != "" && strings.EqualFold(candidate, origin) {
			allowed = origin
			break
		}
	}
	if allowed != "" {
		w.Header().Set("Access-Control-Allow-Origin", allowed)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "600")
	}
	w.Header().Set("Vary", "Origin")
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (h *Handler) writeError(w http.ResponseWriter, status int, message string) {
	h.writeJSON(w, status, map[string]any{"ok": false, "error": message})
}

type ipLimiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	limit  int
	window time.Duration
	now    func() time.Time
}

func newIPLimiter(limit int, window time.Duration) *ipLimiter {
	if limit <= 0 {
		return nil
	}
	return &ipLimiter{hits: make(map[string][]time.Time), limit: limit, window: window, now: time.Now}
}

func (l *ipLimiter) Allow(ip string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-l.window)
	list := l.hits[ip]
	start := 0
	for start < len(list) && list[start].Before(cutoff) {
		start++
	}
	list = list[start:]
	if len(list) >= l.limit {
		l.hits[ip] = list
		return false
	}
	l.hits[ip] = append(list, now)
	return true
}
