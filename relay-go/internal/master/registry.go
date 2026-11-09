// Package master implements the relay master/registry: relays register
// themselves, the master verifies them over WebSocket, and the web client
// fetches the active node list.
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

// WebRTCInfo is the relay's declared WebRTC transport endpoint. The signal
// URL is the HTTP(S) /rtc/offer endpoint; UDP port is the shared fixed ICE port.
type WebRTCInfo struct {
	Enabled   bool   `json:"enabled"`
	Host      string `json:"host"`
	SignalURL string `json:"signalUrl"`
	UDPPort   int    `json:"udpPort"`
}

// Node is one registered relay.
type Node struct {
	Name         string      `json:"name"`
	URL          string      `json:"url"`
	Region       string      `json:"region,omitempty"`
	Version      string      `json:"version,omitempty"`
	Players      int         `json:"players"`
	Transports   []string    `json:"transports,omitempty"`
	WebRTC       *WebRTCInfo `json:"webrtc,omitempty"`
	LastSeen     time.Time   `json:"lastSeen"`
	RegisteredAt time.Time   `json:"registeredAt"`
	VerifiedAt   time.Time   `json:"verifiedAt,omitempty"`
	LastChecked  time.Time   `json:"lastChecked,omitempty"`
	Healthy      bool        `json:"healthy"`
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

// NormalizeURL validates a relay base URL and removes a trailing slash.
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

func cleanTransports(values []string) []string {
	seen := make(map[string]bool)
	out := make([]string, 0, 3)
	for _, value := range values {
		transport := strings.ToLower(strings.TrimSpace(value))
		if transport == "" || seen[transport] {
			continue
		}
		seen[transport] = true
		out = append(out, transport)
		if len(out) >= 8 {
			break
		}
	}
	if len(out) == 0 {
		out = append(out, "websocket")
	}
	return out
}

func normalizeWebRTC(raw *WebRTCInfo, transports []string) (*WebRTCInfo, []string, error) {
	if raw == nil {
		return nil, transports, nil
	}
	info := &WebRTCInfo{Enabled: raw.Enabled, Host: strings.TrimSpace(raw.Host), UDPPort: raw.UDPPort}
	signal := strings.TrimSpace(raw.SignalURL)
	if info.UDPPort < 0 || info.UDPPort > 65535 {
		return nil, transports, errors.New("webrtc.udpPort must be between 0 and 65535")
	}
	if info.Enabled {
		if info.UDPPort == 0 {
			return nil, transports, errors.New("webrtc.udpPort must be a fixed port (1-65535) when WebRTC is enabled")
		}
		if info.Host == "" {
			return nil, transports, errors.New("webrtc.host is required when WebRTC is enabled")
		}
		if !validWebRTCHost(info.Host) {
			return nil, transports, errors.New("webrtc.host must be a hostname or IP address")
		}
		parsed, err := url.Parse(signal)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return nil, transports, errors.New("webrtc.signalUrl must be an http:// or https:// URL")
		}
		if parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, transports, errors.New("webrtc.signalUrl must not include a query or fragment")
		}
		info.SignalURL = strings.TrimRight(signal, "/")
		hasWebRTC := false
		for _, transport := range transports {
			if transport == "webrtc" {
				hasWebRTC = true
				break
			}
		}
		if !hasWebRTC {
			transports = append(transports, "webrtc")
		}
	} else {
		info.SignalURL = signal
	}
	return info, transports, nil
}

func validWebRTCHost(host string) bool {
	// A bare IPv6 address may contain colons; accept it via netip first.
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

// Register inserts or refreshes a node. For existing nodes it preserves the
// verification time; the caller verifies new nodes over WebSocket.
func (r *Registry) Register(node Node) (Node, error) {
	normalized, err := NormalizeURL(node.URL)
	if err != nil {
		return Node{}, err
	}
	name := cleanText(node.Name, MaxNameLen)
	if name == "" {
		name = normalized
	}
	if node.Players < 0 || node.Players > MaxPlayers {
		return Node{}, errors.New("players must be between 0 and 1000000")
	}
	transports := cleanTransports(node.Transports)
	webrtc, transports, err := normalizeWebRTC(node.WebRTC, transports)
	if err != nil {
		return Node{}, err
	}
	now := r.now().UTC()
	entry := Node{
		Name:         name,
		URL:          normalized,
		Region:       cleanText(node.Region, MaxRegionLen),
		Version:      cleanText(node.Version, MaxVersionLen),
		Players:      node.Players,
		Transports:   transports,
		WebRTC:       webrtc,
		LastSeen:     now,
		RegisteredAt: now,
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.nodes[normalized]; ok {
		entry.RegisteredAt = existing.RegisteredAt
		entry.VerifiedAt = existing.VerifiedAt
		entry.LastChecked = existing.LastChecked
		entry.Healthy = existing.Healthy
		r.nodes[normalized] = &entry
		return entry, nil
	}
	if len(r.nodes) >= r.max {
		return Node{}, fmt.Errorf("registry is full (max %d nodes)", r.max)
	}
	r.nodes[normalized] = &entry
	return entry, nil
}

// MarkVerified marks a node as verified and healthy.
func (r *Registry) MarkVerified(rawURL string, verified time.Time) {
	normalized, err := NormalizeURL(rawURL)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if node, ok := r.nodes[normalized]; ok {
		node.VerifiedAt = verified.UTC()
		node.LastChecked = verified.UTC()
		node.Healthy = true
	}
}

// MarkChecked updates the health check result without changing verification.
func (r *Registry) MarkChecked(rawURL string, checked time.Time, healthy bool) {
	normalized, err := NormalizeURL(rawURL)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if node, ok := r.nodes[normalized]; ok {
		node.LastChecked = checked.UTC()
		node.Healthy = healthy
		if healthy {
			node.LastSeen = checked.UTC()
		}
	}
}

// Get returns a copy of a node.
func (r *Registry) Get(rawURL string) (Node, bool) {
	normalized, err := NormalizeURL(rawURL)
	if err != nil {
		return Node{}, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	node, ok := r.nodes[normalized]
	if !ok {
		return Node{}, false
	}
	return *node, true
}

// Remove deletes a node.
func (r *Registry) Remove(rawURL string) bool {
	normalized, err := NormalizeURL(rawURL)
	if err != nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.nodes[normalized]; !ok {
		return false
	}
	delete(r.nodes, normalized)
	return true
}

// List returns verified nodes sorted by name and URL.
func (r *Registry) List() []Node {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Node, 0, len(r.nodes))
	for _, node := range r.nodes {
		if node.VerifiedAt.IsZero() || !node.Healthy {
			continue
		}
		out = append(out, *node)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].URL < out[j].URL
	})
	return out
}

// All returns all registered nodes, including unhealthy ones, for health checks.
func (r *Registry) All() []Node {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Node, 0, len(r.nodes))
	for _, node := range r.nodes {
		out = append(out, *node)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].URL < out[j].URL })
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
