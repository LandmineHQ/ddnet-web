// Command relay is the DDNet WSS -> UDP relay backend: a single static binary
// with no dependencies outside the Go standard library.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"ddnet-relay-go/internal/config"
	"ddnet-relay-go/internal/logx"
	"ddnet-relay-go/internal/relay"
	"ddnet-relay-go/internal/relaymaster"
)

const usageText = `ddnet-ws-relay (Go) — WebSocket-to-UDP relay for the DDNet web client

Usage: relay [options]

Options:
  -c, --config <file>     JSON config file (default: RELAY_CONFIG env)
      --host <host>       Bind host (default 127.0.0.1; Docker image sets 0.0.0.0)
      --port <port>       Bind port (default 8390)
      --log-level <level> debug | info | warn | error | silent
      --token <token>     Add an accepted token (repeatable)
      --allow-private     Allow private/loopback/link-local UDP targets
      --allowlist <entry> Allow a hostname, IP or CIDR (repeatable)
      --servers <file>    JSON file with the recommended server list
      --master-domain <d> Master domain or base URL (default master.landmine.top)
      --master-scheme <s> http | https (default https)
      --master-advertise-url <url> Public ws(s) URL advertised to the master
      --master-interval-ms <ms> Heartbeat interval (default 30000)
      --master-timeout-ms <ms>  Registration timeout (default 5000)
      --no-master         Disable master registration
      --print-config      Print the effective config as JSON (no token values) and exit
      --version           Print the version and exit
  -h, --help              Show this help

Environment: RELAY_CONFIG, RELAY_HOST, RELAY_PORT, RELAY_TOKENS, RELAY_ORIGINS,
RELAY_ALLOW_NO_ORIGIN, ALLOW_PRIVATE, RELAY_ALLOWLIST, MAX_CONNS_PER_IP,
MAX_PACKETS_PER_SEC, MAX_BYTES_PER_SEC, IDLE_TIMEOUT_MS, MAX_CONNECTION_MS,
RELAY_SERVERS_FILE, RELAY_LOG_LEVEL, RELAY_TRUST_PROXY,
RELAY_MASTER_ENABLED, RELAY_MASTER_DOMAIN, RELAY_MASTER_SCHEME,
RELAY_MASTER_ADVERTISE_URL, RELAY_MASTER_SIGNAL_URL, RELAY_MASTER_TRANSPORTS,
RELAY_MASTER_INTERVAL_MS, RELAY_MASTER_TIMEOUT_MS,
RELAY_MASTER_SKIP_WHEN_TOKEN, ...

Endpoints:
  WS   /udp/<host>:<port>[?token=...]   (also /udp?target=host:port)
  HTTP GET /healthz /api/info /api/stats /api/servers
`

// stringList collects repeatable string flags.
type stringList []string

func (l *stringList) String() string { return strings.Join(*l, ",") }

func (l *stringList) Set(value string) error {
	*l = append(*l, value)
	return nil
}

type options struct {
	help            bool
	version         bool
	printConfig     bool
	configPath      string
	host            string
	portText        string
	logLevel        string
	tokens          stringList
	allowPrivate    bool
	allowlist       stringList
	serversFile     string
	masterDomain    string
	masterScheme    string
	masterAdvertise string
	masterInterval  string
	masterTimeout   string
	noMaster        bool
}

func parseOptions(args []string) (*options, error) {
	opts := &options{}
	flags := flag.NewFlagSet("relay", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&opts.help, "help", false, "show help")
	flags.BoolVar(&opts.help, "h", false, "show help")
	flags.BoolVar(&opts.version, "version", false, "show version")
	flags.BoolVar(&opts.printConfig, "print-config", false, "print effective config")
	flags.StringVar(&opts.configPath, "config", "", "config file")
	flags.StringVar(&opts.configPath, "c", "", "config file")
	flags.StringVar(&opts.host, "host", "", "bind host")
	flags.StringVar(&opts.portText, "port", "", "bind port")
	flags.StringVar(&opts.logLevel, "log-level", "", "log level")
	flags.Var(&opts.tokens, "token", "accepted relay token (repeatable)")
	flags.BoolVar(&opts.allowPrivate, "allow-private", false, "allow private targets")
	flags.Var(&opts.allowlist, "allowlist", "allowlisted host/IP/CIDR (repeatable)")
	flags.StringVar(&opts.serversFile, "servers", "", "servers JSON file")
	flags.StringVar(&opts.masterDomain, "master-domain", "", "master domain or base URL")
	flags.StringVar(&opts.masterScheme, "master-scheme", "", "master scheme (http/https)")
	flags.StringVar(&opts.masterAdvertise, "master-advertise-url", "", "public relay URL advertised to master")
	flags.StringVar(&opts.masterInterval, "master-interval-ms", "", "master heartbeat interval")
	flags.StringVar(&opts.masterTimeout, "master-timeout-ms", "", "master registration timeout")
	flags.BoolVar(&opts.noMaster, "no-master", false, "disable master registration")
	if err := flags.Parse(args); err != nil {
		return nil, err
	}
	if flags.NArg() > 0 {
		return nil, fmt.Errorf("unexpected argument: %s", flags.Arg(0))
	}
	return opts, nil
}

func buildOverrides(opts *options) (map[string]any, error) {
	overrides := make(map[string]any)
	if opts.host != "" {
		overrides["host"] = opts.host
	}
	if opts.portText != "" {
		port, err := strconv.Atoi(opts.portText)
		if err != nil || port < 0 || port > 65535 {
			return nil, fmt.Errorf("invalid --port value: %s", opts.portText)
		}
		overrides["port"] = port
	}
	if opts.logLevel != "" {
		overrides["logLevel"] = opts.logLevel
	}
	if len(opts.tokens) > 0 {
		overrides["auth"] = map[string]any{"tokens": []string(opts.tokens)}
	}
	security := make(map[string]any)
	if opts.allowPrivate {
		security["allowPrivate"] = true
	}
	if len(opts.allowlist) > 0 {
		security["allowlist"] = []string(opts.allowlist)
	}
	if len(security) > 0 {
		overrides["security"] = security
	}
	if opts.serversFile != "" {
		servers, err := loadServersList(opts.serversFile)
		if err != nil {
			return nil, err
		}
		overrides["servers"] = servers
	}
	master := make(map[string]any)
	if opts.noMaster {
		master["enabled"] = false
	}
	if opts.masterDomain != "" {
		master["domain"] = opts.masterDomain
	}
	if opts.masterScheme != "" {
		master["scheme"] = opts.masterScheme
	}
	if opts.masterAdvertise != "" {
		master["advertiseUrl"] = opts.masterAdvertise
	}
	if opts.masterInterval != "" {
		number, err := strconv.ParseInt(opts.masterInterval, 10, 64)
		if err != nil || number < 1000 {
			return nil, fmt.Errorf("invalid --master-interval-ms: %s", opts.masterInterval)
		}
		master["intervalMs"] = number
	}
	if opts.masterTimeout != "" {
		number, err := strconv.ParseInt(opts.masterTimeout, 10, 64)
		if err != nil || number < 100 {
			return nil, fmt.Errorf("invalid --master-timeout-ms: %s", opts.masterTimeout)
		}
		master["timeoutMs"] = number
	}
	if len(master) > 0 {
		overrides["master"] = master
	}
	return overrides, nil
}

func loadServersList(path string) ([]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read servers file %s: %v", path, err)
	}
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
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

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	opts, err := parseOptions(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n\n%s", err, usageText)
		return 2
	}
	if opts.help {
		fmt.Fprint(os.Stdout, usageText)
		return 0
	}
	if opts.version {
		fmt.Fprintf(os.Stdout, "ddnet-ws-relay-go %s (protocol %s)\n", config.Version, config.Protocol)
		return 0
	}

	overrides, err := buildOverrides(opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n\n%s", err, usageText)
		return 2
	}
	cfg, err := config.Load(config.LoadOptions{ConfigPath: opts.configPath, Overrides: overrides})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Configuration error: %v\n", err)
		return 2
	}
	if opts.printConfig {
		encoded, err := json.MarshalIndent(config.Printable(cfg), "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to print config: %v\n", err)
			return 1
		}
		fmt.Println(string(encoded))
		return 0
	}

	level, err := logx.ParseLevel(cfg.LogLevel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Configuration error: %v\n", err)
		return 2
	}
	logger := logx.New(level, os.Stdout)
	server, err := relay.NewServer(cfg, relay.Options{Logger: logger})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Configuration error: %v\n", err)
		return 2
	}
	if err := server.Start(); err != nil {
		logger.Error("relay_start_failed", logx.F("error", err.Error()))
		fmt.Fprintf(os.Stderr, "Failed to start relay: %v\n", err)
		return 1
	}

	masterCtx, masterCancel := context.WithCancel(context.Background())
	masterClient := relaymaster.New(*cfg, logger)
	go masterClient.Run(masterCtx)

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	sig := <-signals
	signalName := "SIGTERM"
	if sig == syscall.SIGINT {
		signalName = "SIGINT"
	}
	logger.Info("shutdown_signal", logx.F("signal", signalName))
	go func() {
		<-signals
		logger.Warn("shutdown_forced", logx.F("signal", "second signal"))
		os.Exit(1)
	}()
	masterCancel()
	if err := server.Shutdown(context.Background()); err != nil {
		logger.Error("shutdown_failed", logx.F("error", err.Error()))
		return 1
	}
	return 0
}
