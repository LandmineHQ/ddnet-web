// Command master is the DDNet relay master: relays register themselves with a
// WebSocket URL, the master verifies the URL over WebSocket, periodically
// checks liveness, and clients fetch the active relay node list.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"ddnet-relay-go/internal/logx"
	"ddnet-relay-go/internal/master"
)

const version = "1.0.0"

const usageText = `ddnet-relay-master — relay node registry for the DDNet web client

Usage: master [options]

Options:
      --host <host>                 Bind host (default 0.0.0.0)
      --port <port>                 Bind port (default 8391)
      --probe-interval-ms <ms>      Liveness WebSocket probe interval (default 900000 = 15m)
      --probe-timeout-ms <ms>       Per-relay probe timeout (default 5000)
      --heartbeat-ms <ms>           Suggested relay re-register interval (default 30000)
      --cors <origins>              Comma-separated CORS origins or * (default *)
      --trust-proxy                 Trust X-Forwarded-For (default true)
      --max-nodes <n>               Maximum registered relays (default 1000)
      --register-per-minute <n>     Registrations per IP per minute (default 30)
      --log-level <level>           debug | info | warn | error | silent
      --print-config                Print effective config and exit
      --version                     Print version and exit
  -h, --help                        Show this help

Environment: MASTER_HOST, MASTER_PORT, MASTER_PROBE_INTERVAL_MS,
MASTER_PROBE_TIMEOUT_MS, MASTER_HEARTBEAT_MS, MASTER_CORS_ORIGINS,
MASTER_TRUST_PROXY, MASTER_MAX_NODES, MASTER_REGISTER_PER_MINUTE,
MASTER_LOG_LEVEL

Endpoints:
  POST /v1/register     relay registration; master probes <url>/ws before accepting
  POST /v1/unregister   remove a relay {url}
  GET  /v1/serverlist   verified, healthy relay nodes
  GET  /healthz         health check
  GET  /api/stats       registry counters
`

type config struct {
	Host              string   `json:"host"`
	Port              int      `json:"port"`
	ProbeIntervalMs   int64    `json:"probeIntervalMs"`
	ProbeTimeoutMs    int64    `json:"probeTimeoutMs"`
	HeartbeatMs       int64    `json:"heartbeatMs"`
	CORSOrigins       []string `json:"corsOrigins"`
	TrustProxy        bool     `json:"trustProxy"`
	MaxNodes          int      `json:"maxNodes"`
	RegisterPerMinute int      `json:"registerPerMinute"`
	LogLevel          string   `json:"logLevel"`
}

func defaultConfig() config {
	return config{
		Host:              "0.0.0.0",
		Port:              8391,
		ProbeIntervalMs:   15 * 60 * 1000,
		ProbeTimeoutMs:    5000,
		HeartbeatMs:       30000,
		CORSOrigins:       []string{"*"},
		TrustProxy:        true,
		MaxNodes:          1000,
		RegisterPerMinute: 30,
		LogLevel:          "info",
	}
}

func envString(env map[string]string, name string) (string, bool) {
	value, ok := env[name]
	return value, ok
}

func parseBool(value, name string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean for %s: %s", name, value)
	}
}

func applyEnv(cfg *config, env map[string]string) error {
	if value, ok := envString(env, "MASTER_HOST"); ok && value != "" {
		cfg.Host = value
	}
	if value, ok := envString(env, "MASTER_PORT"); ok && value != "" {
		number, err := strconv.Atoi(value)
		if err != nil || number < 0 || number > 65535 {
			return fmt.Errorf("invalid MASTER_PORT: %s", value)
		}
		cfg.Port = number
	}
	if value, ok := envString(env, "MASTER_PROBE_INTERVAL_MS"); ok && value != "" {
		number, err := strconv.ParseInt(value, 10, 64)
		if err != nil || number < 1000 {
			return fmt.Errorf("invalid MASTER_PROBE_INTERVAL_MS: %s", value)
		}
		cfg.ProbeIntervalMs = number
	}
	if value, ok := envString(env, "MASTER_PROBE_TIMEOUT_MS"); ok && value != "" {
		number, err := strconv.ParseInt(value, 10, 64)
		if err != nil || number < 100 {
			return fmt.Errorf("invalid MASTER_PROBE_TIMEOUT_MS: %s", value)
		}
		cfg.ProbeTimeoutMs = number
	}
	if value, ok := envString(env, "MASTER_HEARTBEAT_MS"); ok && value != "" {
		number, err := strconv.ParseInt(value, 10, 64)
		if err != nil || number < 1000 {
			return fmt.Errorf("invalid MASTER_HEARTBEAT_MS: %s", value)
		}
		cfg.HeartbeatMs = number
	}
	if value, ok := envString(env, "MASTER_CORS_ORIGINS"); ok {
		cfg.CORSOrigins = splitList(value)
	}
	if value, ok := envString(env, "MASTER_TRUST_PROXY"); ok {
		parsed, err := parseBool(value, "MASTER_TRUST_PROXY")
		if err != nil {
			return err
		}
		cfg.TrustProxy = parsed
	}
	if value, ok := envString(env, "MASTER_MAX_NODES"); ok && value != "" {
		number, err := strconv.Atoi(value)
		if err != nil || number < 1 {
			return fmt.Errorf("invalid MASTER_MAX_NODES: %s", value)
		}
		cfg.MaxNodes = number
	}
	if value, ok := envString(env, "MASTER_REGISTER_PER_MINUTE"); ok && value != "" {
		number, err := strconv.Atoi(value)
		if err != nil || number < 0 {
			return fmt.Errorf("invalid MASTER_REGISTER_PER_MINUTE: %s", value)
		}
		cfg.RegisterPerMinute = number
	}
	if value, ok := envString(env, "MASTER_LOG_LEVEL"); ok && value != "" {
		cfg.LogLevel = value
	}
	return nil
}

func splitList(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return []string{"*"}
	}
	return out
}

func parseOptions(args []string, cfg *config) (bool, bool, error) {
	flags := flag.NewFlagSet("master", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var help, showVersion, printConfig bool
	var probeInterval, probeTimeout, heartbeat int64
	var cors string
	flags.BoolVar(&help, "help", false, "show help")
	flags.BoolVar(&help, "h", false, "show help")
	flags.BoolVar(&showVersion, "version", false, "show version")
	flags.BoolVar(&printConfig, "print-config", false, "print config")
	flags.StringVar(&cfg.Host, "host", cfg.Host, "bind host")
	flags.IntVar(&cfg.Port, "port", cfg.Port, "bind port")
	flags.Int64Var(&probeInterval, "probe-interval-ms", cfg.ProbeIntervalMs, "probe interval")
	flags.Int64Var(&probeTimeout, "probe-timeout-ms", cfg.ProbeTimeoutMs, "probe timeout")
	flags.Int64Var(&heartbeat, "heartbeat-ms", cfg.HeartbeatMs, "suggested heartbeat")
	flags.StringVar(&cors, "cors", strings.Join(cfg.CORSOrigins, ","), "CORS origins")
	flags.BoolVar(&cfg.TrustProxy, "trust-proxy", cfg.TrustProxy, "trust X-Forwarded-For")
	flags.IntVar(&cfg.MaxNodes, "max-nodes", cfg.MaxNodes, "max nodes")
	flags.IntVar(&cfg.RegisterPerMinute, "register-per-minute", cfg.RegisterPerMinute, "registrations per IP per minute")
	flags.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "log level")
	if err := flags.Parse(args); err != nil {
		return false, false, err
	}
	if flags.NArg() > 0 {
		return false, false, fmt.Errorf("unexpected argument: %s", flags.Arg(0))
	}
	cfg.ProbeIntervalMs = probeInterval
	cfg.ProbeTimeoutMs = probeTimeout
	cfg.HeartbeatMs = heartbeat
	cfg.CORSOrigins = splitList(cors)
	if cfg.Port < 0 || cfg.Port > 65535 {
		return false, false, fmt.Errorf("invalid port: %d", cfg.Port)
	}
	if cfg.ProbeIntervalMs < 1000 || cfg.ProbeTimeoutMs < 100 || cfg.HeartbeatMs < 1000 {
		return false, false, fmt.Errorf("probe interval/heartbeat must be >= 1000ms and probe timeout >= 100ms")
	}
	if cfg.MaxNodes < 1 {
		return false, false, fmt.Errorf("max-nodes must be positive")
	}
	return help, showVersion || printConfig, nil
}

func main() {
	cfg := defaultConfig()
	if err := applyEnv(&cfg, environ()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	help, infoOnly, err := parseOptions(os.Args[1:], &cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if help {
		fmt.Print(usageText)
		return
	}
	if infoOnly {
		if len(os.Args) > 1 && os.Args[1] == "--version" {
			fmt.Println(version)
			return
		}
		encoded, _ := json.MarshalIndent(cfg, "", "  ")
		fmt.Println(string(encoded))
		return
	}

	level, err := logx.ParseLevel(cfg.LogLevel)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	logger := logx.New(level, os.Stdout)
	registry := master.NewRegistry(cfg.MaxNodes)
	handler, err := master.NewHandler(master.Options{
		Registry:          registry,
		HeartbeatInterval: time.Duration(cfg.HeartbeatMs) * time.Millisecond,
		ProbeTimeout:      time.Duration(cfg.ProbeTimeoutMs) * time.Millisecond,
		ProbeInterval:     time.Duration(cfg.ProbeIntervalMs) * time.Millisecond,
		Version:           version,
		CORSOrigins:       cfg.CORSOrigins,
		TrustProxy:        cfg.TrustProxy,
		RegisterPerMinute: cfg.RegisterPerMinute,
		Logger:            logger,
	})
	if err != nil {
		logger.Error("master_start_failed", logx.F("error", err.Error()))
		os.Exit(1)
	}

	address := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	server := &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	probeDone := make(chan struct{})
	go func() {
		defer close(probeDone)
		ticker := time.NewTicker(time.Duration(cfg.ProbeIntervalMs) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				checked, removed := master.CheckAll(ctx, registry, time.Duration(cfg.ProbeTimeoutMs)*time.Millisecond, 8, logger)
				logger.Info("master_health_check", logx.F("checked", checked), logx.F("removed", removed), logx.F("nodes", registry.Count()))
			}
		}
	}()

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("master_start",
			logx.F("address", address),
			logx.F("probeIntervalMs", cfg.ProbeIntervalMs),
			logx.F("probeTimeoutMs", cfg.ProbeTimeoutMs),
			logx.F("heartbeatMs", cfg.HeartbeatMs),
			logx.F("cors", cfg.CORSOrigins),
		)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serverErr <- err
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("master_shutdown", logx.F("signal", "shutdown"))
	case err := <-serverErr:
		logger.Error("master_serve_failed", logx.F("error", err.Error()))
		os.Exit(1)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("master_shutdown_failed", logx.F("error", err.Error()))
	}
	<-probeDone
}

func environ() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index >= 0 {
			env[entry[:index]] = entry[index+1:]
		}
	}
	return env
}
