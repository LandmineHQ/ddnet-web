// Package relaymaster registers this relay with the central relay master and
// keeps it registered with periodic heartbeat requests.
package relaymaster

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ddnet-relay-go/internal/config"
	"ddnet-relay-go/internal/logx"
)

type transport struct {
	Type      string `json:"type"`
	URL       string `json:"url,omitempty"`
	SignalURL string `json:"signalUrl,omitempty"`
	Host      string `json:"host,omitempty"`
	UDPPort   int    `json:"udpPort,omitempty"`
	Origin    string `json:"origin,omitempty"`
}

type registerRequest struct {
	Name       string      `json:"name"`
	Region     string      `json:"region"`
	Version    string      `json:"version"`
	Players    int         `json:"players"`
	Transports []transport `json:"transports"`
}

type registerResponse struct {
	OK         bool  `json:"ok"`
	TTLMs      int64 `json:"ttlMs"`
	IntervalMs int64 `json:"intervalMs"`
}

// Client registers one relay.
type Client struct {
	Config config.Config
	HTTP   *http.Client
	Log    *logx.Logger
}

func New(cfg config.Config, logger *logx.Logger) *Client {
	return &Client{
		Config: cfg,
		HTTP:   &http.Client{Timeout: cfg.Master.MasterTimeout()},
		Log:    logger,
	}
}

// RegisterOnce performs one registration and returns the suggested heartbeat
// interval. The master probes <url>/ws before accepting a new node.
func (c *Client) RegisterOnce(ctx context.Context) (time.Duration, error) {
	endpoint, err := c.Config.Master.RegisterURL()
	if err != nil {
		return 0, err
	}
	advertise, err := config.AdvertiseRelayURL(&c.Config)
	if err != nil {
		return 0, err
	}
	transports := registrationTransports(&c.Config, advertise)
	payload, err := json.Marshal(registerRequest{
		Name:       c.Config.Name,
		Region:     c.Config.Region,
		Version:    config.Version,
		Players:    0,
		Transports: transports,
	})
	if err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "ddnet-relay/"+config.Version)
	response, err := c.HTTP.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := strings.TrimSpace(string(body))
		if message == "" {
			message = response.Status
		}
		return 0, fmt.Errorf("master returned HTTP %d: %s", response.StatusCode, message)
	}
	var parsed registerResponse
	if err := json.Unmarshal(body, &parsed); err == nil && parsed.IntervalMs > 0 {
		interval := time.Duration(parsed.IntervalMs) * time.Millisecond
		if interval >= 5*time.Second {
			return interval, nil
		}
	}
	return c.Config.Master.MasterInterval(), nil
}

// rtcHost is the host/IP clients use for the WebRTC UDP entry. Prefer the
// explicit public IP, otherwise use the advertised relay hostname.
func rtcHost(rtc config.RTC, relayURL string) string {
	if host := strings.TrimSpace(rtc.PublicIP); host != "" {
		return host
	}
	parsed, err := url.Parse(relayURL)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

// rtcSignalURL derives the HTTP(S) WebRTC signaling endpoint from the public
// relay URL: wss://host/base -> https://host/base/rtc/offer. An explicit
// master.signalUrl wins, which allows WebRTC-only relays behind a separate
// HTTP(S) signaling endpoint.
func rtcSignalURL(cfg *config.Config, relayURL string) string {
	if value := strings.TrimSpace(cfg.Master.SignalURL); value != "" {
		return strings.TrimRight(value, "/")
	}
	parsed, err := url.Parse(relayURL)
	if err != nil || parsed.Host == "" {
		return ""
	}
	scheme := "http"
	if parsed.Scheme == "wss" {
		scheme = "https"
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/") + "/rtc/offer"
	return scheme + "://" + parsed.Host + path
}

// registrationTransports builds the break-change transport array. By default
// a RTC-enabled relay advertises WebSocket + WebRTC; a WebRTC-only deployment
// can set RELAY_MASTER_TRANSPORTS=webrtc.
func registrationTransports(cfg *config.Config, advertise string) []transport {
	desired := cfg.Master.Transports
	if len(desired) == 0 {
		desired = []string{"websocket"}
		if cfg.RTC.Enabled {
			desired = append(desired, "webrtc")
		}
	}
	out := make([]transport, 0, len(desired))
	for _, raw := range desired {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "websocket":
			out = append(out, transport{Type: "websocket", URL: advertise})
		case "webrtc":
			origin := ""
			if len(cfg.Auth.OriginAllowlist) > 0 {
				origin = strings.TrimSpace(cfg.Auth.OriginAllowlist[0])
				if origin == "*" {
					origin = "https://master.landmine.top"
				}
			}
			out = append(out, transport{
				Type:      "webrtc",
				SignalURL: rtcSignalURL(cfg, advertise),
				Host:      rtcHost(cfg.RTC, advertise),
				UDPPort:   cfg.RTC.UDPPort,
				Origin:    origin,
			})
		}
	}
	return out
}

// Run registers immediately, then heartbeats until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	should, reason := config.ShouldRegister(&c.Config)
	if !should {
		if c.Log != nil {
			c.Log.Info("master_register_skipped", logx.F("reason", reason))
		}
		// If this relay was registered before (e.g. it now has a token), remove
		// the stale entry; the master's WS probe would otherwise keep it alive.
		c.unregister()
		return
	}
	advertise, _ := config.AdvertiseRelayURL(&c.Config)
	if c.Log != nil {
		c.Log.Info("master_register_start",
			logx.F("master", c.Config.Master.Domain),
			logx.F("url", advertise),
		)
	}
	backoff := 5 * time.Second
	for {
		start := time.Now()
		interval, err := c.RegisterOnce(ctx)
		if ctx.Err() != nil {
			c.unregister()
			return
		}
		if err != nil {
			if c.Log != nil {
				c.Log.Warn("master_register_failed", logx.F("error", err.Error()), logx.F("retryInMs", backoff.Milliseconds()))
			}
			select {
			case <-ctx.Done():
				c.unregister()
				return
			case <-time.After(backoff):
			}
			if backoff < 60*time.Second {
				backoff *= 2
				if backoff > 60*time.Second {
					backoff = 60 * time.Second
				}
			}
			continue
		}
		backoff = 5 * time.Second
		if c.Log != nil {
			c.Log.Info("master_register_ok",
				logx.F("master", c.Config.Master.Domain),
				logx.F("url", advertise),
				logx.F("intervalMs", interval.Milliseconds()),
				logx.F("tookMs", time.Since(start).Milliseconds()),
			)
		}
		select {
		case <-ctx.Done():
			c.unregister()
			return
		case <-time.After(interval):
		}
	}
}

func (c *Client) unregister() {
	endpoint, err := c.Config.Master.UnregisterURL()
	if err != nil {
		return
	}
	advertise, err := config.AdvertiseRelayURL(&c.Config)
	if err != nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"transports": registrationTransports(&c.Config, advertise),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.HTTP.Do(request)
	if err == nil {
		_ = response.Body.Close()
	}
}
