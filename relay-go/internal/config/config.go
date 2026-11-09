// Package config loads the relay configuration: built-in defaults, then an
// optional JSON config file, then RELAY_* environment overrides, then explicit
// CLI overrides (same precedence as the legacy Node relay's config.mjs).
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"regexp"
	"strconv"
	"strings"

	"ddnet-relay-go/internal/logx"
	"ddnet-relay-go/internal/urlparse"
)

// Version is reported by /healthz and /api/info.
const Version = "1.0.0"

// Protocol is the wire protocol advertised by /api/info. The frontend uses it
// to detect that 1 WebSocket binary frame equals 1 UDP datagram.
const Protocol = "ws-udp-datagram/1"

// Auth is the authentication / Origin configuration.
type Auth struct {
	Tokens          []string `json:"tokens"`
	OriginAllowlist []string `json:"originAllowlist"`
	AllowNoOrigin   bool     `json:"allowNoOrigin"`
	TokenHeader     string   `json:"tokenHeader"`
}

// Security is the SSRF policy configuration.
type Security struct {
	AllowPrivate bool     `json:"allowPrivate"`
	Allowlist    []string `json:"allowlist"`
	DNSTimeoutMs int64    `json:"dnsTimeoutMs"`
}

// Limits are the relay limits.
type Limits struct {
	MaxConnectionsPerIP int     `json:"maxConnectionsPerIp"`
	MaxConnectionsTotal int     `json:"maxConnectionsTotal"`
	MaxFrameBytes       int     `json:"maxFrameBytes"`
	HardMaxFrameBytes   int     `json:"hardMaxFrameBytes"`
	MaxPacketsPerSecond int     `json:"maxPacketsPerSecond"`
	PacketBurst         int     `json:"packetBurst"`
	MaxBytesPerSecond   float64 `json:"maxBytesPerSecond"`
	ByteBurst           float64 `json:"byteBurst"`
	IdleTimeoutMs       int64   `json:"idleTimeoutMs"`
	MaxConnectionMs     int64   `json:"maxConnectionMs"`
	MaxBufferedBytes    int64   `json:"maxBufferedBytes"`
	PingIntervalMs      int64   `json:"pingIntervalMs"`
	MaxPendingPackets   int     `json:"maxPendingPackets"`
}

// API is the HTTP API configuration.
type API struct {
	StatsEnabled   bool     `json:"statsEnabled"`
	ServersEnabled bool     `json:"serversEnabled"`
	CORSOrigins    []string `json:"corsOrigins"`
}

// RTC is the WebRTC configuration. The Go relay implements /rtc/offer with
// pion/webrtc: a data-channel echo for latency probes and, when ?target= is
// present, a DataChannel<->UDP bridge for the game transport.
type RTC struct {
	Enabled                 bool     `json:"enabled"`
	MaxPeers                int      `json:"maxPeers"`
	MaxLifetimeMs           int64    `json:"maxLifetimeMs"`
	MaxOfferBytes           int      `json:"maxOfferBytes"`
	MaxOffersPerIPPerMinute int64    `json:"maxOffersPerIpPerMinute"`
	OfferBurst              int      `json:"offerBurst"`
	GatherTimeoutMs         int64    `json:"gatherTimeoutMs"`
	ICEServers              []string `json:"iceServers"`
	// UDPPort pins ICE traffic to one UDP port (0 = ephemeral). Publish it in
	// docker/compose and open it in the firewall for public deployments.
	UDPPort int `json:"udpPort"`
	// PublicIP is advertised as a 1:1 NAT host candidate (relay behind NAT).
	PublicIP string `json:"publicIp"`
}

// Server is one recommended server entry exposed by GET /api/servers. Unknown
// JSON keys are preserved so operators can attach region/players metadata.
type Server struct {
	Name    string `json:"name"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	Address string `json:"address"`
	Note    string `json:"note,omitempty"`

	extra     map[string]json.RawMessage
	rawString string
}

// UnmarshalJSON accepts either {"name":...,"host":...,"port":...} or the
// shorthand string form "host:port".
func (s *Server) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		*s = Server{}
		return nil
	}
	if trimmed[0] == '"' {
		var value string
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return err
		}
		*s = Server{rawString: value}
		return nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return err
	}
	*s = Server{}
	for key, value := range raw {
		var err error
		switch key {
		case "name":
			err = json.Unmarshal(value, &s.Name)
		case "host":
			err = json.Unmarshal(value, &s.Host)
		case "port":
			err = json.Unmarshal(value, &s.Port)
		case "address":
			err = json.Unmarshal(value, &s.Address)
		case "note":
			err = json.Unmarshal(value, &s.Note)
		default:
			if s.extra == nil {
				s.extra = make(map[string]json.RawMessage)
			}
			s.extra[key] = value
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// MarshalJSON emits the normalized object plus any extra metadata keys.
func (s Server) MarshalJSON() ([]byte, error) {
	out := make(map[string]any, len(s.extra)+5)
	for key, value := range s.extra {
		out[key] = value
	}
	out["name"] = s.Name
	out["host"] = s.Host
	out["port"] = s.Port
	out["address"] = s.Address
	if s.Note != "" {
		out["note"] = s.Note
	}
	return json.Marshal(out)
}

// Config is the complete relay configuration.
type Config struct {
	Name       string   `json:"name"`
	Region     string   `json:"region"`
	Host       string   `json:"host"`
	Port       int      `json:"port"`
	UDPPath    string   `json:"udpPath"`
	LogLevel   string   `json:"logLevel"`
	TrustProxy bool     `json:"trustProxy"`
	Auth       Auth     `json:"auth"`
	Security   Security `json:"security"`
	Limits     Limits   `json:"limits"`
	API        API      `json:"api"`
	RTC        RTC      `json:"rtc"`
	Master     Master   `json:"master"`
	Servers    []Server `json:"servers"`
}

// Default returns the built-in defaults (a copy, safe to mutate).
func Default() Config {
	return Config{
		Name:       "DDNet Relay",
		Region:     "",
		Host:       "127.0.0.1",
		Port:       8390,
		UDPPath:    "/udp",
		LogLevel:   "info",
		TrustProxy: false,
		Auth: Auth{
			Tokens:          []string{},
			OriginAllowlist: []string{},
			AllowNoOrigin:   true,
			TokenHeader:     "x-relay-token",
		},
		Security: Security{
			AllowPrivate: false,
			Allowlist:    []string{},
			DNSTimeoutMs: 5000,
		},
		Limits: Limits{
			MaxConnectionsPerIP: 8,
			MaxConnectionsTotal: 1000,
			MaxFrameBytes:       2048,
			HardMaxFrameBytes:   65536,
			MaxPacketsPerSecond: 300,
			PacketBurst:         600,
			MaxBytesPerSecond:   256 * 1024,
			ByteBurst:           512 * 1024,
			IdleTimeoutMs:       60000,
			MaxConnectionMs:     0,
			MaxBufferedBytes:    512 * 1024,
			PingIntervalMs:      20000,
			MaxPendingPackets:   256,
		},
		API: API{StatsEnabled: true, ServersEnabled: true, CORSOrigins: []string{"*"}},
		RTC: RTC{
			Enabled:                 true,
			MaxPeers:                16,
			MaxLifetimeMs:           60000,
			MaxOfferBytes:           262144,
			MaxOffersPerIPPerMinute: 30,
			OfferBurst:              10,
			GatherTimeoutMs:         5000,
			ICEServers:              []string{},
			UDPPort:                 0,
		},
		Master:  defaultMaster(),
		Servers: []Server{},
	}
}

// LoadOptions controls Load.
type LoadOptions struct {
	// ConfigPath is the JSON config file (--config). When empty, RELAY_CONFIG
	// from the environment is used.
	ConfigPath string
	// Env is the environment to read. Nil means os.Environ().
	Env map[string]string
	// Overrides are explicit CLI overrides (highest precedence).
	Overrides map[string]any
}

// Environ snapshots the process environment into a map.
func Environ() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index >= 0 {
			env[entry[:index]] = entry[index+1:]
		}
	}
	return env
}

// Load builds the effective configuration.
func Load(options LoadOptions) (*Config, error) {
	env := options.Env
	if env == nil {
		env = Environ()
	}

	defaults := Default()
	defaultBytes, err := json.Marshal(defaults)
	if err != nil {
		return nil, fmt.Errorf("internal configuration error: %v", err)
	}
	var merged map[string]any
	if err := json.Unmarshal(defaultBytes, &merged); err != nil {
		return nil, fmt.Errorf("internal configuration error: %v", err)
	}

	configPath := options.ConfigPath
	if configPath == "" {
		if value := env["RELAY_CONFIG"]; value != "" {
			configPath = value
		}
	}
	if configPath != "" {
		fileConfig, err := readJSONObject(configPath)
		if err != nil {
			return nil, err
		}
		merged = deepMerge(merged, fileConfig)
	}

	envConfig, err := EnvOverrides(env)
	if err != nil {
		return nil, err
	}
	merged = deepMerge(merged, envConfig)
	if options.Overrides != nil {
		merged = deepMerge(merged, options.Overrides)
	}

	encoded, err := json.Marshal(merged)
	if err != nil {
		return nil, fmt.Errorf("invalid configuration: %v", err)
	}
	var cfg Config
	if err := json.Unmarshal(encoded, &cfg); err != nil {
		return nil, fmt.Errorf("invalid configuration: %v", err)
	}
	if err := Validate(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func readJSONObject(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read config file %s: %v", path, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("invalid JSON in %s: %v", path, err)
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("config file %s must contain a JSON object", path)
	}
	return object, nil
}

// deepMerge merges override into base recursively. Arrays and scalars replace;
// unknown keys are preserved.
func deepMerge(base, override map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(override))
	for key, value := range base {
		out[key] = value
	}
	for key, value := range override {
		if baseMap, ok := out[key].(map[string]any); ok {
			if overrideMap, ok := value.(map[string]any); ok {
				out[key] = deepMerge(baseMap, overrideMap)
				continue
			}
		}
		out[key] = value
	}
	return out
}

// ParseBool parses the boolean forms accepted by the Node relay.
func ParseBool(value, name string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean for %s: %s", name, value)
	}
}

// ParseList parses a comma-separated list or a JSON string array.
func ParseList(value string) ([]string, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return []string{}, nil
	}
	if strings.HasPrefix(text, "[") {
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		var items []any
		if err := decoder.Decode(&items); err != nil {
			return nil, fmt.Errorf("expected a JSON array: %v", err)
		}
		out := make([]string, 0, len(items))
		for _, item := range items {
			var rendered string
			switch value := item.(type) {
			case string:
				rendered = value
			case json.Number:
				rendered = value.String()
			case nil:
				rendered = ""
			default:
				rendered = fmt.Sprintf("%v", value)
			}
			if trimmed := strings.TrimSpace(rendered); trimmed != "" {
				out = append(out, trimmed)
			}
		}
		return out, nil
	}
	parts := strings.Split(text, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out, nil
}

func parseNumber(value, name string) (json.Number, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return "", fmt.Errorf("invalid number for %s: %q", name, value)
	}
	if _, err := strconv.ParseFloat(text, 64); err != nil {
		return "", fmt.Errorf("invalid number for %s: %s", name, value)
	}
	return json.Number(text), nil
}

// EnvOverrides translates RELAY_* / ALLOW_PRIVATE environment variables into
// config overrides, mirroring envOverrides() in config.mjs.
func EnvOverrides(env map[string]string) (map[string]any, error) {
	out := make(map[string]any)
	get := func(name string) (string, bool) {
		value, ok := env[name]
		return value, ok
	}

	if value, ok := get("RELAY_NAME"); ok {
		out["name"] = value
	}
	if value, ok := get("RELAY_REGION"); ok {
		out["region"] = value
	}
	if value, ok := get("RELAY_HOST"); ok && value != "" {
		out["host"] = value
	}
	if value, ok := get("RELAY_PORT"); ok && value != "" {
		number, err := parseNumber(value, "RELAY_PORT")
		if err != nil {
			return nil, err
		}
		out["port"] = number
	}
	if value, ok := get("RELAY_UDP_PATH"); ok && value != "" {
		out["udpPath"] = value
	}
	if value, ok := get("RELAY_LOG_LEVEL"); ok && value != "" {
		out["logLevel"] = value
	}
	if value, ok := get("RELAY_TRUST_PROXY"); ok {
		parsed, err := ParseBool(value, "RELAY_TRUST_PROXY")
		if err != nil {
			return nil, err
		}
		out["trustProxy"] = parsed
	}

	authOverrides := make(map[string]any)
	if value, ok := get("RELAY_TOKENS"); ok {
		tokens, err := ParseList(value)
		if err != nil {
			return nil, err
		}
		authOverrides["tokens"] = tokens
	} else if value, ok := get("RELAY_TOKEN"); ok {
		tokens, err := ParseList(value)
		if err != nil {
			return nil, err
		}
		authOverrides["tokens"] = tokens
	}
	if value, ok := get("RELAY_ORIGINS"); ok {
		origins, err := ParseList(value)
		if err != nil {
			return nil, err
		}
		authOverrides["originAllowlist"] = origins
	} else if value, ok := get("RELAY_ORIGIN_ALLOWLIST"); ok {
		origins, err := ParseList(value)
		if err != nil {
			return nil, err
		}
		authOverrides["originAllowlist"] = origins
	}
	if value, ok := get("RELAY_ALLOW_NO_ORIGIN"); ok {
		parsed, err := ParseBool(value, "RELAY_ALLOW_NO_ORIGIN")
		if err != nil {
			return nil, err
		}
		authOverrides["allowNoOrigin"] = parsed
	}
	if len(authOverrides) > 0 {
		out["auth"] = authOverrides
	}

	securityOverrides := make(map[string]any)
	if value, ok := get("ALLOW_PRIVATE"); ok {
		parsed, err := ParseBool(value, "ALLOW_PRIVATE")
		if err != nil {
			return nil, err
		}
		securityOverrides["allowPrivate"] = parsed
	}
	if value, ok := get("RELAY_ALLOWLIST"); ok {
		allowlist, err := ParseList(value)
		if err != nil {
			return nil, err
		}
		securityOverrides["allowlist"] = allowlist
	}
	if value, ok := get("RELAY_DNS_TIMEOUT_MS"); ok && value != "" {
		number, err := parseNumber(value, "RELAY_DNS_TIMEOUT_MS")
		if err != nil {
			return nil, err
		}
		securityOverrides["dnsTimeoutMs"] = number
	}
	if len(securityOverrides) > 0 {
		out["security"] = securityOverrides
	}

	limitEnv := map[string]string{
		"MAX_CONNS_PER_IP":      "maxConnectionsPerIp",
		"MAX_CONNECTIONS_TOTAL": "maxConnectionsTotal",
		"MAX_FRAME_BYTES":       "maxFrameBytes",
		"HARD_MAX_FRAME_BYTES":  "hardMaxFrameBytes",
		"MAX_PACKETS_PER_SEC":   "maxPacketsPerSecond",
		"PACKET_BURST":          "packetBurst",
		"MAX_BYTES_PER_SEC":     "maxBytesPerSecond",
		"BYTE_BURST":            "byteBurst",
		"IDLE_TIMEOUT_MS":       "idleTimeoutMs",
		"MAX_CONNECTION_MS":     "maxConnectionMs",
		"MAX_BUFFERED_BYTES":    "maxBufferedBytes",
		"PING_INTERVAL_MS":      "pingIntervalMs",
		"MAX_PENDING_PACKETS":   "maxPendingPackets",
	}
	limitOverrides := make(map[string]any)
	for envName, key := range limitEnv {
		if value, ok := get(envName); ok {
			number, err := parseNumber(value, envName)
			if err != nil {
				return nil, err
			}
			limitOverrides[key] = number
		}
	}
	if len(limitOverrides) > 0 {
		out["limits"] = limitOverrides
	}

	masterOverrides := make(map[string]any)
	if value, ok := get("RELAY_MASTER_ENABLED"); ok {
		parsed, err := ParseBool(value, "RELAY_MASTER_ENABLED")
		if err != nil {
			return nil, err
		}
		masterOverrides["enabled"] = parsed
	}
	if value, ok := get("RELAY_MASTER_DOMAIN"); ok {
		masterOverrides["domain"] = value
	}
	if value, ok := get("RELAY_MASTER_SCHEME"); ok && value != "" {
		masterOverrides["scheme"] = value
	}
	if value, ok := get("RELAY_MASTER_ADVERTISE_URL"); ok {
		masterOverrides["advertiseUrl"] = value
	}
	if value, ok := get("RELAY_MASTER_SIGNAL_URL"); ok {
		masterOverrides["signalUrl"] = value
	}
	if value, ok := get("RELAY_MASTER_TRANSPORTS"); ok && value != "" {
		transports, err := ParseList(value)
		if err != nil {
			return nil, err
		}
		masterOverrides["transports"] = transports
	}
	if value, ok := get("RELAY_MASTER_INTERVAL_MS"); ok && value != "" {
		number, err := parseNumber(value, "RELAY_MASTER_INTERVAL_MS")
		if err != nil {
			return nil, err
		}
		masterOverrides["intervalMs"] = number
	}
	if value, ok := get("RELAY_MASTER_TIMEOUT_MS"); ok && value != "" {
		number, err := parseNumber(value, "RELAY_MASTER_TIMEOUT_MS")
		if err != nil {
			return nil, err
		}
		masterOverrides["timeoutMs"] = number
	}
	if value, ok := get("RELAY_MASTER_SKIP_WHEN_TOKEN"); ok {
		parsed, err := ParseBool(value, "RELAY_MASTER_SKIP_WHEN_TOKEN")
		if err != nil {
			return nil, err
		}
		masterOverrides["skipWhenToken"] = parsed
	}
	if len(masterOverrides) > 0 {
		out["master"] = masterOverrides
	}

	if value, ok := get("RELAY_API_CORS"); ok {
		origins, err := ParseList(value)
		if err != nil {
			return nil, err
		}
		out["api"] = map[string]any{"corsOrigins": origins}
	}

	rtcOverrides := make(map[string]any)
	if value, ok := get("RTC_ENABLED"); ok {
		parsed, err := ParseBool(value, "RTC_ENABLED")
		if err != nil {
			return nil, err
		}
		rtcOverrides["enabled"] = parsed
	}
	rtcEnv := map[string]string{
		"RTC_MAX_PEERS":                    "maxPeers",
		"RTC_MAX_LIFETIME_MS":              "maxLifetimeMs",
		"RTC_MAX_OFFER_BYTES":              "maxOfferBytes",
		"RTC_MAX_OFFERS_PER_IP_PER_MINUTE": "maxOffersPerIpPerMinute",
		"RTC_OFFER_BURST":                  "offerBurst",
		"RTC_GATHER_TIMEOUT_MS":            "gatherTimeoutMs",
		"RTC_UDP_PORT":                     "udpPort",
	}
	for envName, key := range rtcEnv {
		if value, ok := get(envName); ok {
			number, err := parseNumber(value, envName)
			if err != nil {
				return nil, err
			}
			rtcOverrides[key] = number
		}
	}
	if value, ok := get("RTC_PUBLIC_IP"); ok {
		rtcOverrides["publicIp"] = strings.TrimSpace(value)
	}
	if value, ok := get("RTC_ICE_SERVERS"); ok {
		servers, err := ParseList(value)
		if err != nil {
			return nil, err
		}
		rtcOverrides["iceServers"] = servers
	}
	if len(rtcOverrides) > 0 {
		out["rtc"] = rtcOverrides
	}

	if value, ok := get("RELAY_SERVERS_FILE"); ok && value != "" {
		servers, err := LoadServersFile(value)
		if err != nil {
			return nil, err
		}
		out["servers"] = servers
	}
	return out, nil
}

// LoadServersFile reads a servers JSON file: either {"servers":[...]} or a bare
// array. Entries may be objects or "host:port" strings.
func LoadServersFile(path string) ([]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read servers file %s: %v", path, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("invalid JSON in %s: %v", path, err)
	}
	switch value := parsed.(type) {
	case []any:
		return value, nil
	case map[string]any:
		raw, ok := value["servers"]
		if !ok || raw == nil {
			return []any{}, nil
		}
		list, ok := raw.([]any)
		if !ok {
			return nil, fmt.Errorf("invalid servers file %s: servers must be an array", path)
		}
		return list, nil
	default:
		return nil, fmt.Errorf("invalid servers file %s: expected a JSON array or an object with a servers array", path)
	}
}

var iceServerPattern = regexp.MustCompile(`(?i)^(stun|turn|turns):\S+$`)

// Validate normalizes and validates the configuration, returning a descriptive
// error on failure.
func Validate(cfg *Config) error {
	cfg.Name = strings.TrimSpace(cfg.Name)
	if cfg.Name == "" {
		return errors.New("config.name must be a non-empty string")
	}
	if len(cfg.Name) > 120 {
		return errors.New("config.name must be at most 120 characters")
	}
	cfg.Region = strings.TrimSpace(cfg.Region)
	if cfg.Host == "" {
		return errors.New("config.host must be a non-empty string")
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return errors.New("config.port must be an integer between 0 and 65535")
	}
	if !strings.HasPrefix(cfg.UDPPath, "/") {
		return errors.New("config.udpPath must start with /")
	}
	if _, err := logx.ParseLevel(cfg.LogLevel); err != nil {
		return errors.New("config.logLevel must be one of debug, info, warn, error, silent")
	}

	cfg.Auth.Tokens = cleanStrings(cfg.Auth.Tokens)
	cfg.Auth.OriginAllowlist = cleanStrings(cfg.Auth.OriginAllowlist)
	if cfg.Security.DNSTimeoutMs < 1 {
		return errors.New("config.security.dnsTimeoutMs must be >= 1")
	}
	cfg.Security.Allowlist = cleanStrings(cfg.Security.Allowlist)

	if err := validateLimits(cfg); err != nil {
		return err
	}
	if cfg.API.CORSOrigins == nil {
		cfg.API.CORSOrigins = []string{}
	}
	cfg.API.CORSOrigins = cleanStrings(cfg.API.CORSOrigins)

	if cfg.RTC.UDPPort < 0 || cfg.RTC.UDPPort > 65535 {
		return fmt.Errorf("rtc.udpPort out of range: %d", cfg.RTC.UDPPort)
	}
	// A fixed UDP port shared by all WebRTC peers is required for a stable
	// entry. 0 means "same as the relay TCP port"; ephemeral-per-peer ports are
	// deliberately not supported.
	if cfg.RTC.Enabled && cfg.RTC.UDPPort == 0 {
		cfg.RTC.UDPPort = cfg.Port
	}
	if cfg.RTC.PublicIP != "" {
		if _, err := netip.ParseAddr(cfg.RTC.PublicIP); err != nil {
			return fmt.Errorf("rtc.publicIp is not a valid IP address: %s", cfg.RTC.PublicIP)
		}
	}
	if cfg.RTC.MaxPeers <= 0 {
		return errors.New("config.rtc.maxPeers must be a positive integer")
	}
	if cfg.RTC.MaxOfferBytes <= 0 {
		return errors.New("config.rtc.maxOfferBytes must be a positive integer")
	}
	if cfg.RTC.MaxOfferBytes > 8*1024*1024 {
		return errors.New("config.rtc.maxOfferBytes must be <= 8 MiB")
	}
	if cfg.RTC.OfferBurst <= 0 {
		return errors.New("config.rtc.offerBurst must be a positive integer")
	}
	if cfg.RTC.GatherTimeoutMs <= 0 {
		return errors.New("config.rtc.gatherTimeoutMs must be a positive integer")
	}
	if cfg.RTC.MaxLifetimeMs <= 0 {
		return errors.New("config.rtc.maxLifetimeMs must be a positive number")
	}
	if cfg.RTC.MaxOffersPerIPPerMinute <= 0 {
		return errors.New("config.rtc.maxOffersPerIpPerMinute must be a positive number")
	}
	cfg.RTC.ICEServers = cleanStrings(cfg.RTC.ICEServers)
	for _, entry := range cfg.RTC.ICEServers {
		if !iceServerPattern.MatchString(entry) {
			return fmt.Errorf("invalid config.rtc.iceServers entry: %s", entry)
		}
	}

	if err := validateMaster(cfg); err != nil {
		return err
	}

	servers, err := NormalizeServers(cfg.Servers)
	if err != nil {
		return err
	}
	cfg.Servers = servers
	return nil
}

func validateLimits(cfg *Config) error {
	limits := cfg.Limits
	if limits.MaxConnectionsPerIP <= 0 {
		return errors.New("config.limits.maxConnectionsPerIp must be a positive integer")
	}
	if limits.MaxConnectionsTotal <= 0 {
		return errors.New("config.limits.maxConnectionsTotal must be a positive integer")
	}
	if limits.MaxFrameBytes <= 0 {
		return errors.New("config.limits.maxFrameBytes must be a positive integer")
	}
	if limits.HardMaxFrameBytes <= 0 {
		return errors.New("config.limits.hardMaxFrameBytes must be a positive integer")
	}
	if limits.MaxPacketsPerSecond <= 0 {
		return errors.New("config.limits.maxPacketsPerSecond must be a positive integer")
	}
	if limits.PacketBurst <= 0 {
		return errors.New("config.limits.packetBurst must be a positive integer")
	}
	if !(limits.MaxBytesPerSecond > 0) {
		return errors.New("config.limits.maxBytesPerSecond must be a positive number")
	}
	if !(limits.ByteBurst > 0) {
		return errors.New("config.limits.byteBurst must be a positive number")
	}
	if limits.IdleTimeoutMs < 0 {
		return errors.New("config.limits.idleTimeoutMs must be a non-negative number")
	}
	if limits.MaxConnectionMs < 0 {
		return errors.New("config.limits.maxConnectionMs must be a non-negative number")
	}
	if limits.MaxBufferedBytes < 0 {
		return errors.New("config.limits.maxBufferedBytes must be a non-negative number")
	}
	if limits.PingIntervalMs < 0 {
		return errors.New("config.limits.pingIntervalMs must be a non-negative number")
	}
	if limits.MaxPendingPackets < 0 {
		return errors.New("config.limits.maxPendingPackets must be a non-negative number")
	}
	if limits.MaxFrameBytes > limits.HardMaxFrameBytes {
		return errors.New("config.limits.maxFrameBytes must be <= config.limits.hardMaxFrameBytes")
	}
	if limits.MaxConnectionsPerIP > limits.MaxConnectionsTotal {
		return errors.New("config.limits.maxConnectionsPerIp must be <= config.limits.maxConnectionsTotal")
	}
	return nil
}

func cleanStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// NormalizeServers fills in name/host/port/address for every server entry and
// validates each host:port.
func NormalizeServers(servers []Server) ([]Server, error) {
	out := make([]Server, 0, len(servers))
	for index, entry := range servers {
		if entry.rawString != "" {
			target, err := urlparse.SplitHostPort(entry.rawString, urlparse.DefaultTargetPort)
			if err != nil {
				return nil, fmt.Errorf("config.servers[%d]: %v", index, err)
			}
			out = append(out, Server{
				Name:    entry.rawString,
				Host:    target.Host,
				Port:    target.Port,
				Address: target.String(),
				extra:   entry.extra,
			})
			continue
		}
		raw := strings.TrimSpace(entry.Address)
		if raw == "" {
			host := strings.TrimSpace(entry.Host)
			if host == "" {
				return nil, fmt.Errorf("config.servers[%d] needs host/port or address", index)
			}
			port := entry.Port
			if port == 0 {
				port = urlparse.DefaultTargetPort
			}
			raw = urlparse.FormatTarget(host, port)
		}
		target, err := urlparse.SplitHostPort(raw, urlparse.DefaultTargetPort)
		if err != nil {
			return nil, fmt.Errorf("config.servers[%d]: %v", index, err)
		}
		name := strings.TrimSpace(entry.Name)
		if name == "" {
			name = target.String()
		}
		out = append(out, Server{
			Name:    name,
			Host:    target.Host,
			Port:    target.Port,
			Address: target.String(),
			Note:    strings.TrimSpace(entry.Note),
			extra:   entry.extra,
		})
	}
	return out, nil
}

// Printable returns the effective configuration for troubleshooting, never
// including token values (matches printableConfig() in config.mjs).
func Printable(cfg *Config) map[string]any {
	servers := make([]map[string]any, 0, len(cfg.Servers))
	for _, entry := range cfg.Servers {
		item := map[string]any{"name": entry.Name, "address": entry.Address}
		if entry.Note != "" {
			item["note"] = entry.Note
		}
		servers = append(servers, item)
	}
	return map[string]any{
		"name":       cfg.Name,
		"region":     cfg.Region,
		"host":       cfg.Host,
		"port":       cfg.Port,
		"udpPath":    cfg.UDPPath,
		"logLevel":   cfg.LogLevel,
		"trustProxy": cfg.TrustProxy,
		"auth": map[string]any{
			"tokensConfigured": len(cfg.Auth.Tokens),
			"originAllowlist":  append([]string{}, cfg.Auth.OriginAllowlist...),
			"allowNoOrigin":    cfg.Auth.AllowNoOrigin,
			"tokenHeader":      cfg.Auth.TokenHeader,
		},
		"security": map[string]any{
			"allowPrivate": cfg.Security.AllowPrivate,
			"allowlist":    append([]string{}, cfg.Security.Allowlist...),
			"dnsTimeoutMs": cfg.Security.DNSTimeoutMs,
		},
		"limits": map[string]any{
			"maxConnectionsPerIp": cfg.Limits.MaxConnectionsPerIP,
			"maxConnectionsTotal": cfg.Limits.MaxConnectionsTotal,
			"maxFrameBytes":       cfg.Limits.MaxFrameBytes,
			"hardMaxFrameBytes":   cfg.Limits.HardMaxFrameBytes,
			"maxPacketsPerSecond": cfg.Limits.MaxPacketsPerSecond,
			"packetBurst":         cfg.Limits.PacketBurst,
			"maxBytesPerSecond":   cfg.Limits.MaxBytesPerSecond,
			"byteBurst":           cfg.Limits.ByteBurst,
			"idleTimeoutMs":       cfg.Limits.IdleTimeoutMs,
			"maxConnectionMs":     cfg.Limits.MaxConnectionMs,
			"maxBufferedBytes":    cfg.Limits.MaxBufferedBytes,
			"pingIntervalMs":      cfg.Limits.PingIntervalMs,
			"maxPendingPackets":   cfg.Limits.MaxPendingPackets,
		},
		"api": map[string]any{
			"statsEnabled":   cfg.API.StatsEnabled,
			"serversEnabled": cfg.API.ServersEnabled,
			"corsOrigins":    append([]string{}, cfg.API.CORSOrigins...),
		},
		"rtc": map[string]any{
			"enabled":                 cfg.RTC.Enabled,
			"maxPeers":                cfg.RTC.MaxPeers,
			"maxLifetimeMs":           cfg.RTC.MaxLifetimeMs,
			"maxOfferBytes":           cfg.RTC.MaxOfferBytes,
			"maxOffersPerIpPerMinute": cfg.RTC.MaxOffersPerIPPerMinute,
			"offerBurst":              cfg.RTC.OfferBurst,
			"gatherTimeoutMs":         cfg.RTC.GatherTimeoutMs,
			"iceServers":              append([]string{}, cfg.RTC.ICEServers...),
			"udpPort":                 cfg.RTC.UDPPort,
			"publicIp":                cfg.RTC.PublicIP,
		},
		"master": map[string]any{
			"enabled":       cfg.Master.Enabled,
			"domain":        cfg.Master.Domain,
			"scheme":        cfg.Master.Scheme,
			"advertiseUrl":  cfg.Master.AdvertiseURL,
			"intervalMs":    cfg.Master.IntervalMs,
			"timeoutMs":     cfg.Master.TimeoutMs,
			"skipWhenToken": cfg.Master.SkipWhenToken,
		},
		"servers": servers,
	}
}

// Describe returns the compact, log-safe configuration summary.
func Describe(cfg *Config) map[string]any {
	return map[string]any{
		"name":       cfg.Name,
		"region":     cfg.Region,
		"host":       cfg.Host,
		"port":       cfg.Port,
		"udpPath":    cfg.UDPPath,
		"logLevel":   cfg.LogLevel,
		"trustProxy": cfg.TrustProxy,
		"rtc": map[string]any{
			"enabled":       cfg.RTC.Enabled,
			"maxPeers":      cfg.RTC.MaxPeers,
			"maxLifetimeMs": cfg.RTC.MaxLifetimeMs,
		},
		"auth": map[string]any{
			"tokensConfigured":  len(cfg.Auth.Tokens),
			"originsConfigured": len(cfg.Auth.OriginAllowlist),
			"allowNoOrigin":     cfg.Auth.AllowNoOrigin,
		},
		"security": map[string]any{
			"allowPrivate":     cfg.Security.AllowPrivate,
			"allowlistEntries": len(cfg.Security.Allowlist),
			"dnsTimeoutMs":     cfg.Security.DNSTimeoutMs,
		},
		"limits":            Printable(cfg)["limits"],
		"api":               Printable(cfg)["api"],
		"serversConfigured": len(cfg.Servers),
		"master": map[string]any{
			"enabled":      cfg.Master.Enabled,
			"domain":       cfg.Master.Domain,
			"advertiseUrl": cfg.Master.AdvertiseURL,
		},
	}
}
