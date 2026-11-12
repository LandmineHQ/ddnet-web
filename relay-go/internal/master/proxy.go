package master

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SignalID is the opaque, stable identifier used by the master signaling
// proxy. It never exposes the upstream URL in serverlist proxy links.
func SignalID(raw string) string {
	sum := sha256.Sum256([]byte(strings.TrimRight(strings.TrimSpace(raw), "/")))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// FindWebRTCBySignalID returns a verified WebRTC transport whose upstream
// signal URL is an insecure HTTP URL. HTTPS upstreams are used directly by
// browsers and are never proxied by the master.
func (r *Registry) FindWebRTCBySignalID(id string) (Transport, bool) {
	if len(id) < 16 {
		return Transport{}, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, node := range r.nodes {
		if !node.Healthy || node.VerifiedAt.IsZero() {
			continue
		}
		for _, transport := range node.verified {
			if transport.Type != "webrtc" || !strings.HasPrefix(strings.ToLower(transport.SignalURL), "http://") {
				continue
			}
			if SignalID(transport.SignalURL) == id {
				return transport, true
			}
		}
	}
	return Transport{}, false
}

// publicBase returns the externally visible master origin, preferring the
// configured public URL and otherwise deriving it from the request/nginx.
func (h *Handler) publicBase(r *http.Request) string {
	if value := strings.TrimRight(strings.TrimSpace(h.options.PublicURL), "/"); value != "" {
		return value
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
		scheme = "https"
	}
	host := strings.TrimSpace(r.Host)
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// publicSignalURL rewrites an insecure WebRTC signal URL to the master's
// HTTPS signaling proxy. Secure upstreams are returned unchanged.
func (h *Handler) publicSignalURL(r *http.Request, raw string) string {
	if !strings.HasPrefix(strings.ToLower(raw), "http://") {
		return raw
	}
	base := h.publicBase(r)
	if base == "" {
		return raw
	}
	return strings.TrimRight(base, "/") + "/v1/signal/" + SignalID(raw) + "/rtc/offer"
}

// handleSignalProxy proxies signaling/health/info requests to a verified HTTP
// relay signal endpoint. It never proxies /udp or any UDP data path.
func (h *Handler) handleSignalProxy(w http.ResponseWriter, r *http.Request) {
	if h.signalLimiter != nil && !h.signalLimiter.Allow(h.remoteIP(r)) {
		h.writeError(w, http.StatusTooManyRequests, "too many signaling proxy requests")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/v1/signal/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[0] == "" {
		h.writeError(w, http.StatusNotFound, "not found")
		return
	}
	id, action := parts[0], parts[1]
	transport, ok := h.registry.FindWebRTCBySignalID(id)
	if !ok {
		h.writeError(w, http.StatusNotFound, "signaling node not found")
		return
	}
	signalURL, err := url.Parse(transport.SignalURL)
	if err != nil || signalURL.Host == "" {
		h.writeError(w, http.StatusBadGateway, "invalid upstream signal URL")
		return
	}
	var method, upstreamPath string
	switch action {
	case "rtc/offer":
		method = http.MethodPost
		upstreamPath = signalURL.Path
		if upstreamPath == "" {
			upstreamPath = "/rtc/offer"
		}
	case "healthz":
		method = http.MethodGet
		upstreamPath = strings.TrimSuffix(signalURL.Path, "/rtc/offer") + "/healthz"
	case "api/info":
		method = http.MethodGet
		upstreamPath = strings.TrimSuffix(signalURL.Path, "/rtc/offer") + "/api/info"
	case "api/servers":
		method = http.MethodGet
		upstreamPath = strings.TrimSuffix(signalURL.Path, "/rtc/offer") + "/api/servers"
	default:
		h.writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != method {
		w.Header().Set("Allow", method+", OPTIONS")
		h.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	upstream := *signalURL
	if action != "rtc/offer" {
		upstream.Path = upstreamPath
		upstream.RawPath = ""
	}
	upstream.RawQuery = r.URL.RawQuery
	var bodyBytes []byte
	if action == "rtc/offer" {
		bodyBytes, err = io.ReadAll(io.LimitReader(r.Body, 256*1024+1))
		if err != nil {
			h.writeError(w, http.StatusBadRequest, "cannot read signaling body")
			return
		}
		if len(bodyBytes) > 256*1024 {
			h.writeError(w, http.StatusRequestEntityTooLarge, "signaling body too large")
			return
		}
	}
	request, err := http.NewRequestWithContext(r.Context(), method, upstream.String(), bytes.NewReader(bodyBytes))
	if err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid signaling request")
		return
	}
	request.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	if accept := r.Header.Get("Accept"); accept != "" {
		request.Header.Set("Accept", accept)
	}
	for _, header := range []string{"Origin", "Authorization", "X-Relay-Token"} {
		if value := r.Header.Get(header); value != "" {
			request.Header.Set(header, value)
		}
	}
	request.Header.Set("User-Agent", "ddnet-relay-master-signal-proxy/1.0")
	request.Header.Set("X-Forwarded-For", h.remoteIP(r))

	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("signaling redirects are not allowed")
		},
	}
	response, err := client.Do(request)
	if err != nil {
		h.writeError(w, http.StatusBadGateway, "upstream signaling unavailable")
		return
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 256*1024))
	if readErr != nil {
		h.writeError(w, http.StatusBadGateway, "upstream signaling read failed")
		return
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(body)
}
