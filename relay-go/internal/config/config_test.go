package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefault(t *testing.T) {
	cfg := Default()
	if cfg.Name != "DDNet Relay" || cfg.Port != 8390 || cfg.UDPPath != "/udp" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if !cfg.Auth.AllowNoOrigin || cfg.Auth.TokenHeader != "x-relay-token" {
		t.Fatalf("unexpected auth defaults: %+v", cfg.Auth)
	}
	if cfg.Limits.MaxFrameBytes != 2048 || cfg.Limits.HardMaxFrameBytes != 65536 {
		t.Fatalf("unexpected frame limits: %+v", cfg.Limits)
	}
	if len(cfg.API.CORSOrigins) != 1 || cfg.API.CORSOrigins[0] != "*" {
		t.Fatalf("unexpected CORS defaults: %v", cfg.API.CORSOrigins)
	}
	if !cfg.API.StatsEnabled || !cfg.API.ServersEnabled {
		t.Fatalf("API endpoints should default to enabled: %+v", cfg.API)
	}
}

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func TestLoadFileAndPrecedence(t *testing.T) {
	configPath := writeFile(t, "relay.json", `{
		"name": "Config File Relay",
		"port": 8400,
		"auth": {"tokens": ["from-file"], "originAllowlist": ["https://file.example"]},
		"security": {"allowPrivate": true, "allowlist": ["127.0.0.1/32"]},
		"limits": {"maxFrameBytes": 1400, "idleTimeoutMs": 30000},
		"servers": [
			{"name": "Local", "host": "127.0.0.1", "port": 8313, "note": "e2e"},
			"ddnet.example.org:8303"
		]
	}`)
	env := map[string]string{
		"RELAY_PORT":         "9000",
		"RELAY_TOKENS":       "env-a,env-b",
		"MAX_FRAME_BYTES":    "1401",
		"RELAY_SERVERS_FILE": writeFile(t, "servers.json", `{"servers":[{"name":"EnvServer","host":"127.0.0.1","port":8314}]}`),
	}
	overrides := map[string]any{
		"host":     "0.0.0.0",
		"logLevel": "debug",
		"auth":     map[string]any{"tokens": []string{"cli-token"}},
	}
	cfg, err := Load(LoadOptions{ConfigPath: configPath, Env: env, Overrides: overrides})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Name != "Config File Relay" {
		t.Fatalf("file name not applied: %q", cfg.Name)
	}
	if cfg.Port != 9000 {
		t.Fatalf("env should override file port; got %d", cfg.Port)
	}
	if cfg.Host != "0.0.0.0" || cfg.LogLevel != "debug" {
		t.Fatalf("CLI overrides not applied: host=%q logLevel=%q", cfg.Host, cfg.LogLevel)
	}
	if len(cfg.Auth.Tokens) != 1 || cfg.Auth.Tokens[0] != "cli-token" {
		t.Fatalf("CLI tokens should win: %v", cfg.Auth.Tokens)
	}
	if len(cfg.Auth.OriginAllowlist) != 1 || cfg.Auth.OriginAllowlist[0] != "https://file.example" {
		t.Fatalf("file origin allowlist lost: %v", cfg.Auth.OriginAllowlist)
	}
	if !cfg.Security.AllowPrivate || len(cfg.Security.Allowlist) != 1 {
		t.Fatalf("security config lost: %+v", cfg.Security)
	}
	if cfg.Limits.MaxFrameBytes != 1401 {
		t.Fatalf("env limit override lost: %d", cfg.Limits.MaxFrameBytes)
	}
	if cfg.Limits.IdleTimeoutMs != 30000 {
		t.Fatalf("file idle timeout lost: %d", cfg.Limits.IdleTimeoutMs)
	}
	if len(cfg.Servers) != 1 || cfg.Servers[0].Name != "EnvServer" || cfg.Servers[0].Address != "127.0.0.1:8314" {
		t.Fatalf("servers file should replace config servers: %+v", cfg.Servers)
	}
}

func TestLoadNormalizesServers(t *testing.T) {
	configPath := writeFile(t, "relay.json", `{
		"servers": [
			{"host": "127.0.0.1", "port": 8313},
			{"host": "::1", "port": 8313, "note": "v6"},
			{"address": "ddnet.example.org:8303", "name": "Example", "region": "EU", "players": 7},
			"localhost:8304"
		]
	}`)
	cfg, err := Load(LoadOptions{ConfigPath: configPath, Env: map[string]string{}})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Servers) != 4 {
		t.Fatalf("expected 4 servers, got %d", len(cfg.Servers))
	}
	if cfg.Servers[0].Name != "127.0.0.1:8313" || cfg.Servers[0].Address != "127.0.0.1:8313" {
		t.Fatalf("default name/address wrong: %+v", cfg.Servers[0])
	}
	if cfg.Servers[1].Address != "[::1]:8313" || cfg.Servers[1].Note != "v6" {
		t.Fatalf("IPv6 server normalization wrong: %+v", cfg.Servers[1])
	}
	if cfg.Servers[2].Name != "Example" || cfg.Servers[2].Address != "ddnet.example.org:8303" {
		t.Fatalf("address server normalization wrong: %+v", cfg.Servers[2])
	}
	if cfg.Servers[3].Name != "localhost:8304" {
		t.Fatalf("string server normalization wrong: %+v", cfg.Servers[3])
	}
}

func TestEnvOverrides(t *testing.T) {
	env := map[string]string{
		"RELAY_NAME":            "Env Relay",
		"RELAY_REGION":          "eu",
		"RELAY_HOST":            "0.0.0.0",
		"RELAY_PORT":            "8399",
		"RELAY_LOG_LEVEL":       "warn",
		"RELAY_TRUST_PROXY":     "yes",
		"RELAY_TOKENS":          `["a", "b"]`,
		"RELAY_ORIGINS":         "https://a.example,https://b.example",
		"RELAY_ALLOW_NO_ORIGIN": "0",
		"ALLOW_PRIVATE":         "on",
		"RELAY_ALLOWLIST":       "127.0.0.1/32,10.0.0.0/8",
		"MAX_CONNS_PER_IP":      "3",
		"MAX_CONNECTIONS_TOTAL": "30",
		"MAX_FRAME_BYTES":       "1500",
		"MAX_PACKETS_PER_SEC":   "120",
		"MAX_BYTES_PER_SEC":     "131072",
		"IDLE_TIMEOUT_MS":       "15000",
		"RELAY_API_CORS":        "https://frontend.example",
		"RTC_ENABLED":           "false",
		"RELAY_DNS_TIMEOUT_MS":  "2500",
	}
	cfg, err := Load(LoadOptions{Env: env})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Name != "Env Relay" || cfg.Region != "eu" || cfg.Host != "0.0.0.0" || cfg.Port != 8399 {
		t.Fatalf("basic env overrides lost: %+v", cfg)
	}
	if cfg.LogLevel != "warn" || !cfg.TrustProxy {
		t.Fatalf("log/trust proxy overrides lost: %v %v", cfg.LogLevel, cfg.TrustProxy)
	}
	if len(cfg.Auth.Tokens) != 2 || cfg.Auth.Tokens[1] != "b" {
		t.Fatalf("token env lost: %v", cfg.Auth.Tokens)
	}
	if len(cfg.Auth.OriginAllowlist) != 2 || cfg.Auth.OriginAllowlist[0] != "https://a.example" {
		t.Fatalf("origin env lost: %v", cfg.Auth.OriginAllowlist)
	}
	if cfg.Auth.AllowNoOrigin {
		t.Fatal("RELAY_ALLOW_NO_ORIGIN=0 ignored")
	}
	if !cfg.Security.AllowPrivate || len(cfg.Security.Allowlist) != 2 || cfg.Security.DNSTimeoutMs != 2500 {
		t.Fatalf("security env lost: %+v", cfg.Security)
	}
	if cfg.Limits.MaxConnectionsPerIP != 3 || cfg.Limits.MaxConnectionsTotal != 30 {
		t.Fatalf("connection limits env lost: %+v", cfg.Limits)
	}
	if cfg.Limits.MaxFrameBytes != 1500 || cfg.Limits.MaxPacketsPerSecond != 120 || cfg.Limits.MaxBytesPerSecond != 131072 {
		t.Fatalf("rate limits env lost: %+v", cfg.Limits)
	}
	if cfg.Limits.IdleTimeoutMs != 15000 {
		t.Fatalf("idle timeout env lost: %d", cfg.Limits.IdleTimeoutMs)
	}
	if len(cfg.API.CORSOrigins) != 1 || cfg.API.CORSOrigins[0] != "https://frontend.example" {
		t.Fatalf("CORS env lost: %v", cfg.API.CORSOrigins)
	}
	if cfg.RTC.Enabled {
		t.Fatal("RTC_ENABLED=false ignored")
	}
}

func TestEnvPrecedenceTokens(t *testing.T) {
	cfg, err := Load(LoadOptions{Env: map[string]string{"RELAY_TOKENS": "env-token"}})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Auth.Tokens) != 1 || cfg.Auth.Tokens[0] != "env-token" {
		t.Fatalf("RELAY_TOKENS not applied: %v", cfg.Auth.Tokens)
	}

	// An explicitly empty RELAY_TOKENS disables authentication.
	cfg, err = Load(LoadOptions{Env: map[string]string{"RELAY_TOKENS": ""}})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Auth.Tokens) != 0 {
		t.Fatalf("empty RELAY_TOKENS should disable tokens: %v", cfg.Auth.Tokens)
	}
}

func TestValidationErrors(t *testing.T) {
	cases := map[string]func(*Config){
		"empty name":            func(c *Config) { c.Name = "  " },
		"bad port":              func(c *Config) { c.Port = 70000 },
		"bad udp path":          func(c *Config) { c.UDPPath = "udp" },
		"bad log level":         func(c *Config) { c.LogLevel = "verbose" },
		"bad dns timeout":       func(c *Config) { c.Security.DNSTimeoutMs = 0 },
		"frame > hard":          func(c *Config) { c.Limits.MaxFrameBytes = 70000 },
		"per-ip > total":        func(c *Config) { c.Limits.MaxConnectionsPerIP = c.Limits.MaxConnectionsTotal + 1 },
		"zero packet rate":      func(c *Config) { c.Limits.MaxPacketsPerSecond = 0 },
		"negative idle timeout": func(c *Config) { c.Limits.IdleTimeoutMs = -1 },
		"bad ice server":        func(c *Config) { c.RTC.ICEServers = []string{"http://nope"} },
		"huge max offer":        func(c *Config) { c.RTC.MaxOfferBytes = 9 * 1024 * 1024 },
	}
	for name, mutate := range cases {
		cfg := Default()
		mutate(&cfg)
		if err := Validate(&cfg); err == nil {
			t.Fatalf("%s: validation unexpectedly passed", name)
		}
	}
}

func TestPrintableRedactsTokens(t *testing.T) {
	cfg := Default()
	cfg.Auth.Tokens = []string{"super-secret-token"}
	cfg.Servers = []Server{{Name: "Local", Host: "127.0.0.1", Port: 8313, Note: "note"}}
	if err := Validate(&cfg); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	printable := Printable(&cfg)
	auth, ok := printable["auth"].(map[string]any)
	if !ok {
		t.Fatalf("auth missing: %+v", printable)
	}
	if auth["tokensConfigured"] != 1 {
		t.Fatalf("tokensConfigured = %v", auth["tokensConfigured"])
	}
	encoded := strings.Join(flatten(printable), " ")
	if strings.Contains(encoded, "super-secret-token") {
		t.Fatal("printable config leaks token values")
	}
	servers, ok := printable["servers"].([]map[string]any)
	if !ok || len(servers) != 1 || servers[0]["note"] != "note" {
		t.Fatalf("printable servers wrong: %+v", printable["servers"])
	}
}

func flatten(value any) []string {
	var out []string
	switch typed := value.(type) {
	case string:
		out = append(out, typed)
	case map[string]any:
		for _, item := range typed {
			out = append(out, flatten(item)...)
		}
	case []string:
		out = append(out, typed...)
	case []map[string]any:
		for _, item := range typed {
			out = append(out, flatten(item)...)
		}
	case []any:
		for _, item := range typed {
			out = append(out, flatten(item)...)
		}
	}
	return out
}

func TestParseBoolAndList(t *testing.T) {
	for _, value := range []string{"1", "true", "YES", "on"} {
		if parsed, err := ParseBool(value, "x"); err != nil || !parsed {
			t.Fatalf("ParseBool(%q) = %v, %v", value, parsed, err)
		}
	}
	for _, value := range []string{"0", "false", "NO", "off"} {
		if parsed, err := ParseBool(value, "x"); err != nil || parsed {
			t.Fatalf("ParseBool(%q) = %v, %v", value, parsed, err)
		}
	}
	if _, err := ParseBool("maybe", "x"); err == nil {
		t.Fatal("invalid boolean accepted")
	}

	if list, err := ParseList(" a , b ,, c "); err != nil || len(list) != 3 || list[2] != "c" {
		t.Fatalf("ParseList comma = %v, %v", list, err)
	}
	if list, err := ParseList(`["a", 1, true]`); err != nil || len(list) != 3 || list[1] != "1" || list[2] != "true" {
		t.Fatalf("ParseList JSON = %v, %v", list, err)
	}
	if list, err := ParseList(""); err != nil || len(list) != 0 {
		t.Fatalf("ParseList empty = %v, %v", list, err)
	}
	if _, err := ParseList("[not json"); err == nil {
		t.Fatal("invalid JSON list accepted")
	}
}

func TestLoadMissingFile(t *testing.T) {
	if _, err := Load(LoadOptions{ConfigPath: filepath.Join(t.TempDir(), "nope.json"), Env: map[string]string{}}); err == nil {
		t.Fatal("missing config file accepted")
	}
	if _, err := Load(LoadOptions{ConfigPath: writeFile(t, "bad.json", "{oops"), Env: map[string]string{}}); err == nil {
		t.Fatal("invalid JSON config accepted")
	}
	if _, err := Load(LoadOptions{ConfigPath: writeFile(t, "array.json", "[]"), Env: map[string]string{}}); err == nil {
		t.Fatal("array config accepted")
	}
}

func TestMasterDefaultsAndOverrides(t *testing.T) {
	cfg, err := Load(LoadOptions{Env: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Master.Domain != "master.landmine.top" || !cfg.Master.Enabled || !cfg.Master.SkipWhenToken {
		t.Fatalf("master defaults = %+v", cfg.Master)
	}
	if cfg.Master.MasterInterval() != 30*time.Second {
		t.Fatalf("master interval = %v", cfg.Master.MasterInterval())
	}

	cfg, err = Load(LoadOptions{Env: map[string]string{
		"RELAY_MASTER_DOMAIN":        "http://127.0.0.1:8391",
		"RELAY_MASTER_ADVERTISE_URL": "ws://127.0.0.1:8390",
		"RELAY_MASTER_INTERVAL_MS":   "45000",
		"RELAY_MASTER_TIMEOUT_MS":    "2500",
		"RELAY_MASTER_ENABLED":       "true",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Master.Domain != "http://127.0.0.1:8391" || cfg.Master.AdvertiseURL != "ws://127.0.0.1:8390" {
		t.Fatalf("master env = %+v", cfg.Master)
	}
	if cfg.Master.MasterInterval() != 45*time.Second || cfg.Master.MasterTimeout() != 2500*time.Millisecond {
		t.Fatalf("master durations = %v/%v", cfg.Master.MasterInterval(), cfg.Master.MasterTimeout())
	}
	registerURL, err := cfg.Master.RegisterURL()
	if err != nil || registerURL != "http://127.0.0.1:8391/v1/register" {
		t.Fatalf("RegisterURL = %q, %v", registerURL, err)
	}
	if ok, _ := ShouldRegister(cfg); !ok {
		t.Fatal("local master/advertise should register")
	}

	cfg.Auth.Tokens = []string{"secret"}
	if ok, reason := ShouldRegister(cfg); ok || reason == "" {
		t.Fatal("token relay must skip registration")
	}
	cfg.Auth.Tokens = nil
	cfg.Master.AdvertiseURL = "ws://127.0.0.1:8390"
	cfg.Master.Domain = "https://master.landmine.top"
	if ok, _ := ShouldRegister(cfg); ok {
		t.Fatal("loopback advertise against remote master must be skipped")
	}
}

func TestRTCUDPPortMatchesRelayPort(t *testing.T) {
	cfg, err := Load(LoadOptions{Env: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.RTC.Enabled || cfg.RTC.UDPPort != cfg.Port {
		t.Fatalf("rtc.udpPort=%d should default to relay port %d", cfg.RTC.UDPPort, cfg.Port)
	}
	cfg, err = Load(LoadOptions{Env: map[string]string{"RELAY_PORT": "9000", "RTC_UDP_PORT": "9000"}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RTC.UDPPort != 9000 {
		t.Fatalf("explicit rtc.udpPort = %d", cfg.RTC.UDPPort)
	}
}
