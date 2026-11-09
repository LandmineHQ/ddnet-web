package master

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	MaxNameLen    = 64
	MaxRegionLen  = 32
	MaxVersionLen = 64
	MaxPlayers    = 1000000
)

// Transport is one declared relay endpoint. The type is "websocket" or
// "webrtc"; only the fields for that type are used.
type Transport struct {
	Type      string `json:"type"`
	URL       string `json:"url,omitempty"`
	SignalURL string `json:"signalUrl,omitempty"`
	Host      string `json:"host,omitempty"`
	UDPPort   int    `json:"udpPort,omitempty"`
	Origin    string `json:"origin,omitempty"`
}

// Node is one registered relay. Transports is the requested set; the server
// only exposes the subset that passed verification/liveness checks.
type Node struct {
	Name         string      `json:"name"`
	Region       string      `json:"region,omitempty"`
	Version      string      `json:"version,omitempty"`
	Players      int         `json:"players"`
	Transports   []Transport `json:"transports"`
	LastSeen     time.Time   `json:"lastSeen"`
	RegisteredAt time.Time   `json:"registeredAt"`
	VerifiedAt   time.Time   `json:"verifiedAt,omitempty"`
	LastChecked  time.Time   `json:"lastChecked,omitempty"`
	Healthy      bool        `json:"healthy"`

	verified map[string]Transport
}

// Registry is a concurrency-safe in-memory relay registry.
type Registry struct {
	mu    sync.RWMutex
	nodes map[string]*Node
	max   int
	now   func() time.Time
}

func NewRegistry(max int) *Registry {
	if max <= 0 {
		max = 1000
	}
	return &Registry{
		nodes: make(map[string]*Node),
		max:   max,
		now:   time.Now,
	}
}

// NormalizeURL validates a relay WebSocket base URL and removes a trailing slash.
func NormalizeURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", errors.New("url is required")
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("invalid url: %v", err)
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "ws" && scheme != "wss" {
		return "", errors.New("url must use ws:// or wss://")
	}
	if parsed.Host == "" {
		return "", errors.New("url must include a host")
	}
	if parsed.User != nil {
		return "", errors.New("url must not include credentials")
	}
	if parsed.RawQuery != "" {
		return "", errors.New("url must not include a query")
	}
	if parsed.Fragment != "" {
		return "", errors.New("url must not include a fragment")
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	return scheme + "://" + parsed.Host + path, nil
}

func normalizeOrigin(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("webrtc.origin must be an absolute http(s) origin")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("webrtc.origin must use http:// or https://")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("webrtc.origin must not include a path")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// NormalizeTransport validates one transport declaration.
func NormalizeTransport(raw Transport) (Transport, error) {
	transport := Transport{
		Type:      strings.ToLower(strings.TrimSpace(raw.Type)),
		URL:       strings.TrimSpace(raw.URL),
		SignalURL: strings.TrimSpace(raw.SignalURL),
		Host:      strings.TrimSpace(raw.Host),
		UDPPort:   raw.UDPPort,
		Origin:    strings.TrimSpace(raw.Origin),
	}
	switch transport.Type {
	case "ws", "wss", "websocket":
		transport.Type = "websocket"
		if transport.SignalURL != "" || transport.Host != "" || transport.UDPPort != 0 || transport.Origin != "" {
			return Transport{}, errors.New("websocket transport must only set type and url")
		}
		normalized, err := NormalizeURL(transport.URL)
		if err != nil {
			return Transport{}, err
		}
		transport.URL = normalized
		return transport, nil
	case "webrtc", "rtc":
		transport.Type = "webrtc"
		if transport.URL != "" {
			return Transport{}, errors.New("webrtc transport must use signalUrl, not url")
		}
		if transport.Host == "" {
			return Transport{}, errors.New("webrtc.host is required")
		}
		if !validWebRTCHost(transport.Host) {
			return Transport{}, errors.New("webrtc.host must be a hostname or IP address")
		}
		if transport.UDPPort <= 0 || transport.UDPPort > 65535 {
			return Transport{}, errors.New("webrtc.udpPort must be a fixed port (1-65535)")
		}
		parsed, err := url.Parse(transport.SignalURL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return Transport{}, errors.New("webrtc.signalUrl must be an http:// or https:// URL")
		}
		if parsed.RawQuery != "" || parsed.Fragment != "" {
			return Transport{}, errors.New("webrtc.signalUrl must not include a query or fragment")
		}
		transport.SignalURL = strings.TrimRight(transport.SignalURL, "/")
		origin, err := normalizeOrigin(transport.Origin)
		if err != nil {
			return Transport{}, err
		}
		transport.Origin = origin
		return transport, nil
	default:
		return Transport{}, fmt.Errorf("unsupported transport type %q", raw.Type)
	}
}

func normalizeTransports(values []Transport) ([]Transport, error) {
	if len(values) == 0 {
		return nil, errors.New("at least one transport is required")
	}
	out := make([]Transport, 0, 2)
	seen := make(map[string]bool)
	for _, raw := range values {
		transport, err := NormalizeTransport(raw)
		if err != nil {
			return nil, err
		}
		if seen[transport.Type] {
			return nil, fmt.Errorf("duplicate transport %q", transport.Type)
		}
		seen[transport.Type] = true
		out = append(out, transport)
	}
	return out, nil
}

func validWebRTCHost(host string) bool {
	if _, err := netip.ParseAddr(host); err == nil {
		return true
	}
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "/:@?# \t") {
		return false
	}
	if strings.HasPrefix(host, ".") || strings.HasSuffix(host, ".") || strings.Contains(host, "..") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, char := range label {
			if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
				(char >= '0' && char <= '9') || char == '-' || char == '_' {
				continue
			}
			return false
		}
	}
	return true
}

func cleanText(value string, max int) string {
	text := strings.TrimSpace(value)
	if len(text) > max {
		text = text[:max]
	}
	return text
}

func transportID(transport Transport) string {
	return transport.Type + "|" + transport.URL + "|" + transport.SignalURL
}

// NodeKey returns the stable registry key for a node. WebSocket is the primary
// transport when present; WebRTC-only nodes use the signaling URL.
func NodeKey(transports []Transport) (string, error) {
	normalized, err := normalizeTransports(transports)
	if err != nil {
		return "", err
	}
	for _, transport := range normalized {
		if transport.Type == "websocket" {
			return "websocket:" + transport.URL, nil
		}
	}
	return "webrtc:" + normalized[0].SignalURL, nil
}

func verifiedMap(transports []Transport) map[string]Transport {
	verified := make(map[string]Transport, len(transports))
	for _, transport := range transports {
		verified[transportID(transport)] = transport
	}
	return verified
}

// Register inserts or refreshes a node. Existing verification is retained only
// for transports that are unchanged in the new request.
func (r *Registry) Register(node Node) (Node, error) {
	transports, err := normalizeTransports(node.Transports)
	if err != nil {
		return Node{}, err
	}
	key, err := NodeKey(transports)
	if err != nil {
		return Node{}, err
	}
	name := cleanText(node.Name, MaxNameLen)
	if name == "" {
		name = key
	}
	if node.Players < 0 || node.Players > MaxPlayers {
		return Node{}, errors.New("players must be between 0 and 1000000")
	}
	now := r.now().UTC()
	entry := Node{
		Name:         name,
		Region:       cleanText(node.Region, MaxRegionLen),
		Version:      cleanText(node.Version, MaxVersionLen),
		Players:      node.Players,
		Transports:   transports,
		LastSeen:     now,
		RegisteredAt: now,
		verified:     make(map[string]Transport),
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.nodes[key]; ok {
		entry.RegisteredAt = existing.RegisteredAt
		entry.VerifiedAt = existing.VerifiedAt
		entry.LastChecked = existing.LastChecked
		for _, transport := range transports {
			if old, ok := existing.verified[transportID(transport)]; ok {
				entry.verified[transportID(old)] = old
			}
		}
		entry.Healthy = len(entry.verified) > 0
		r.nodes[key] = &entry
		return entry, nil
	}
	if len(r.nodes) >= r.max {
		return Node{}, fmt.Errorf("registry is full (max %d nodes)", r.max)
	}
	r.nodes[key] = &entry
	return entry, nil
}

// MarkTransportVerified marks one exact transport endpoint as verified.
func (r *Registry) MarkTransportVerified(key string, transport Transport, verified time.Time) {
	normalized, err := NormalizeTransport(transport)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	node, ok := r.nodes[key]
	if !ok {
		return
	}
	if node.verified == nil {
		node.verified = make(map[string]Transport)
	}
	node.verified[transportID(normalized)] = normalized
	node.VerifiedAt = verified.UTC()
	node.LastChecked = verified.UTC()
	node.Healthy = true
}

// MarkTransportFailed removes a failed transport; the node remains if another
// verified transport is still available.
func (r *Registry) MarkTransportFailed(key string, transport Transport) {
	id := transportID(transport)
	r.mu.Lock()
	defer r.mu.Unlock()
	node, ok := r.nodes[key]
	if !ok {
		return
	}
	delete(node.verified, id)
	node.LastChecked = r.now().UTC()
	node.Healthy = len(node.verified) > 0
}

// VerifiedTransports returns the verified endpoints for a node.
func (r *Registry) VerifiedTransports(key string) []Transport {
	r.mu.RLock()
	defer r.mu.RUnlock()
	node, ok := r.nodes[key]
	if !ok {
		return nil
	}
	return node.verifiedTransports()
}

// HasVerified reports whether a node has at least one verified transport.
func (r *Registry) HasVerified(key string) bool {
	return len(r.VerifiedTransports(key)) > 0
}

func (n *Node) verifiedTransports() []Transport {
	out := make([]Transport, 0, len(n.verified))
	for _, transport := range n.verified {
		out = append(out, transport)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out
}

// MarkChecked updates the health check timestamps without changing verification.
func (r *Registry) MarkChecked(key string, checked time.Time, healthy bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if node, ok := r.nodes[key]; ok {
		node.LastChecked = checked.UTC()
		node.Healthy = healthy
		if healthy {
			node.LastSeen = checked.UTC()
		}
	}
}

// Get returns a copy of a node by key.
func (r *Registry) Get(key string) (Node, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	node, ok := r.nodes[key]
	if !ok {
		return Node{}, false
	}
	copy := *node
	copy.verified = verifiedMap(node.verifiedTransports())
	return copy, true
}

// Remove deletes a node by key.
func (r *Registry) Remove(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.nodes[key]; !ok {
		return false
	}
	delete(r.nodes, key)
	return true
}

// List returns nodes with at least one verified transport, exposing only those
// verified transports.
func (r *Registry) List() []Node {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Node, 0, len(r.nodes))
	for _, node := range r.nodes {
		verified := node.verifiedTransports()
		if node.VerifiedAt.IsZero() || !node.Healthy || len(verified) == 0 {
			continue
		}
		copy := *node
		copy.Transports = verified
		copy.verified = verifiedMap(verified)
		out = append(out, copy)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return strings.Join(transportIDs(out[i].Transports), ",") < strings.Join(transportIDs(out[j].Transports), ",")
	})
	return out
}

func transportIDs(transports []Transport) []string {
	out := make([]string, 0, len(transports))
	for _, transport := range transports {
		out = append(out, transportID(transport))
	}
	return out
}

// All returns all registered nodes, including unhealthy ones, for health checks.
func (r *Registry) All() []Node {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Node, 0, len(r.nodes))
	for _, node := range r.nodes {
		copy := *node
		copy.verified = verifiedMap(node.verifiedTransports())
		out = append(out, copy)
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.Join(transportIDs(out[i].Transports), ",") < strings.Join(transportIDs(out[j].Transports), ",")
	})
	return out
}

// Count returns the number of active (verified and healthy) nodes.
func (r *Registry) Count() int {
	return len(r.List())
}

// SetNow is used by tests.
func (r *Registry) SetNow(now func() time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.now = now
}
