package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Master configures registration with the relay master.
type Master struct {
	Enabled       bool     `json:"enabled"`
	Domain        string   `json:"domain"`
	Scheme        string   `json:"scheme"`
	AdvertiseURL  string   `json:"advertiseUrl"`
	SignalURL     string   `json:"signalUrl,omitempty"`
	Transports    []string `json:"transports,omitempty"`
	IntervalMs    int64    `json:"intervalMs"`
	TimeoutMs     int64    `json:"timeoutMs"`
	SkipWhenToken bool     `json:"skipWhenToken"`
}

func defaultMaster() Master {
	return Master{
		Enabled:       true,
		Domain:        "master.landmine.top",
		Scheme:        "https",
		AdvertiseURL:  "",
		SignalURL:     "",
		Transports:    nil,
		IntervalMs:    30000,
		TimeoutMs:     5000,
		SkipWhenToken: true,
	}
}

// RegisterURL returns the full /v1/register endpoint.
func (m Master) RegisterURL() (string, error) {
	domain := strings.TrimSpace(m.Domain)
	if domain == "" {
		return "", errors.New("master.domain must not be empty")
	}
	base := strings.TrimRight(domain, "/")
	if strings.Contains(base, "://") {
		parsed, err := url.Parse(base)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return "", fmt.Errorf("invalid master.domain: %s", m.Domain)
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return "", fmt.Errorf("master.domain must use http:// or https://: %s", m.Domain)
		}
		return base + "/v1/register", nil
	}
	scheme := strings.ToLower(strings.TrimSpace(m.Scheme))
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("master.scheme must be http or https: %s", m.Scheme)
	}
	return scheme + "://" + base + "/v1/register", nil
}

// UnregisterURL returns the full /v1/unregister endpoint.
func (m Master) UnregisterURL() (string, error) {
	register, err := m.RegisterURL()
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(register, "/register") + "/unregister", nil
}

// AdvertiseRelayURL derives the relay URL advertised to the master unless it
// was explicitly configured.
func AdvertiseRelayURL(cfg *Config) (string, error) {
	if value := strings.TrimSpace(cfg.Master.AdvertiseURL); value != "" {
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Host == "" {
			return "", fmt.Errorf("master.advertiseUrl must be a valid ws:// or wss:// URL: %s", value)
		}
		return strings.TrimRight(value, "/"), nil
	}
	host := strings.TrimSpace(cfg.Host)
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	return "ws://" + net.JoinHostPort(host, strconv.Itoa(cfg.Port)), nil
}

// ShouldRegister reports whether this relay should register with the master.
func ShouldRegister(cfg *Config) (bool, string) {
	if !cfg.Master.Enabled {
		return false, "master registration disabled"
	}
	if cfg.Master.SkipWhenToken && len(cfg.Auth.Tokens) > 0 {
		return false, "relay has configured tokens; skipping master registration"
	}
	advertise, err := AdvertiseRelayURL(cfg)
	if err != nil {
		return false, err.Error()
	}
	parsed, err := url.Parse(advertise)
	if err != nil {
		return false, "invalid advertise URL"
	}
	host := parsed.Hostname()
	if isLoopbackHost(host) {
		masterHost := cfg.Master.Domain
		if parsedMaster, err := url.Parse(cfg.Master.Domain); err == nil && parsedMaster.Hostname() != "" {
			masterHost = parsedMaster.Hostname()
		} else if index := strings.IndexByte(masterHost, '/'); index >= 0 {
			masterHost = masterHost[:index]
		}
		if !isLoopbackHost(masterHost) {
			return false, "advertiseUrl is loopback but master is remote; set master.advertiseUrl to a public ws(s):// URL"
		}
	}
	return true, ""
}

// MasterInterval returns the configured heartbeat interval.
func (m Master) MasterInterval() time.Duration {
	interval := time.Duration(m.IntervalMs) * time.Millisecond
	if interval < 5*time.Second {
		interval = 30 * time.Second
	}
	return interval
}

// MasterTimeout returns the configured HTTP timeout.
func (m Master) MasterTimeout() time.Duration {
	timeout := time.Duration(m.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return timeout
}

func isLoopbackHost(host string) bool {
	value := strings.TrimSpace(strings.ToLower(host))
	if value == "localhost" || value == "::1" || value == "[::1]" {
		return true
	}
	if ip := net.ParseIP(value); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// validateMaster normalizes and validates the master config.
func validateMaster(cfg *Config) error {
	cfg.Master.Domain = strings.TrimSpace(cfg.Master.Domain)
	cfg.Master.Scheme = strings.ToLower(strings.TrimSpace(cfg.Master.Scheme))
	cfg.Master.AdvertiseURL = strings.TrimRight(strings.TrimSpace(cfg.Master.AdvertiseURL), "/")
	if cfg.Master.Enabled {
		if _, err := cfg.Master.RegisterURL(); err != nil {
			return err
		}
	}
	if cfg.Master.IntervalMs < 1000 {
		return errors.New("config.master.intervalMs must be >= 1000")
	}
	if cfg.Master.TimeoutMs < 100 || cfg.Master.TimeoutMs > 600000 {
		return errors.New("config.master.timeoutMs must be between 100 and 600000")
	}
	if cfg.Master.AdvertiseURL != "" {
		if _, err := AdvertiseRelayURL(cfg); err != nil {
			return err
		}
	}
	if cfg.Master.SignalURL != "" {
		parsed, err := url.Parse(cfg.Master.SignalURL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return errors.New("master.signalUrl must be an http:// or https:// URL")
		}
	}
	if len(cfg.Master.Transports) > 0 {
		seen := make(map[string]bool)
		for _, raw := range cfg.Master.Transports {
			value := strings.ToLower(strings.TrimSpace(raw))
			if value != "websocket" && value != "webrtc" {
				return fmt.Errorf("master.transports contains unsupported transport %q", raw)
			}
			if seen[value] {
				return fmt.Errorf("master.transports contains duplicate transport %q", value)
			}
			seen[value] = true
		}
		if seen["webrtc"] && !cfg.RTC.Enabled {
			return errors.New("master.transports includes webrtc but rtc.enabled is false")
		}
	}
	return nil
}
