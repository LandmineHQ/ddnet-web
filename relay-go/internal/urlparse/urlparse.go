// Package urlparse parses relay requests: /udp/<host>:<port>[?token=...] and
// /udp?target=<host>:<port>. It is a faithful port of the legacy Node relay's
// url.mjs, including its quirks, so existing clients keep working unchanged.
package urlparse

import (
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"ddnet-relay-go/internal/relayerr"
)

// DefaultTargetPort is used when the target has no explicit port.
const DefaultTargetPort = 8303

var (
	hostPattern   = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	bearerPattern = regexp.MustCompile(`(?i)^bearer\s+(.+)$`)
)

// Target is a validated UDP target (host + port).
type Target struct {
	Host string
	Port int
	Raw  string
}

// String formats the target, bracketing IPv6 addresses.
func (t Target) String() string {
	if addr, err := netip.ParseAddr(t.Host); err == nil && addr.Is6() {
		return "[" + t.Host + "]:" + strconv.Itoa(t.Port)
	}
	return t.Host + ":" + strconv.Itoa(t.Port)
}

// Request is a parsed relay WebSocket request.
type Request struct {
	Target   Target
	Token    string
	URL      *url.URL
	Pathname string
	Origin   string
}

// ParsePort parses a decimal port, rejecting anything outside 1..65535.
func ParsePort(value string) (int, error) {
	text := strings.TrimSpace(value)
	if len(text) < 1 || len(text) > 5 || !allDigits(text) {
		display := text
		if display == "" {
			display = "(empty)"
		}
		return 0, relayerr.New(relayerr.BadPort, "Invalid target port: "+display, 400)
	}
	port, err := strconv.Atoi(text)
	if err != nil || port < 1 || port > 65535 {
		return 0, relayerr.New(relayerr.BadPort, "Target port out of range: "+text, 400)
	}
	return port, nil
}

func allDigits(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// ValidateHost validates and lowercases a target hostname or IP literal.
func ValidateHost(host string) (string, error) {
	value := strings.TrimSpace(host)
	if value == "" {
		return "", relayerr.New(relayerr.BadTarget, "Target host is empty", 400)
	}
	if len(value) > 253 {
		return "", relayerr.New(relayerr.BadTarget, "Target host is too long", 400)
	}
	if strings.HasPrefix(value, "[") || strings.HasSuffix(value, "]") {
		return "", relayerr.New(relayerr.BadTarget, "Target host must not contain brackets", 400)
	}
	if _, err := netip.ParseAddr(value); err == nil {
		return strings.ToLower(value), nil
	}
	if !hostPattern.MatchString(value) || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") || strings.Contains(value, "..") {
		return "", relayerr.New(relayerr.BadTarget, "Invalid target host: "+value, 400)
	}
	return strings.ToLower(value), nil
}

// SplitHostPort parses "host:port", "[v6]:port", "host" (default port) and a
// bare "v6" address (default port).
func SplitHostPort(input string, defaultPort int) (Target, error) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return Target{}, relayerr.New(relayerr.BadTarget, "Target is empty", 400)
	}
	if defaultPort <= 0 {
		defaultPort = DefaultTargetPort
	}

	if strings.HasPrefix(raw, "[") {
		end := strings.Index(raw, "]")
		if end == -1 {
			return Target{}, relayerr.New(relayerr.BadTarget, "Unterminated IPv6 bracket in target", 400)
		}
		host, err := ValidateHost(raw[1:end])
		if err != nil {
			return Target{}, err
		}
		addr, addrErr := netip.ParseAddr(host)
		if addrErr != nil || !addr.Is6() {
			return Target{}, relayerr.New(relayerr.BadTarget, "Bracketed target is not an IPv6 address", 400)
		}
		rest := raw[end+1:]
		if rest == "" {
			return Target{Host: host, Port: defaultPort, Raw: raw}, nil
		}
		if !strings.HasPrefix(rest, ":") {
			return Target{}, relayerr.New(relayerr.BadTarget, "Invalid target after IPv6 address", 400)
		}
		port, err := ParsePort(rest[1:])
		if err != nil {
			return Target{}, err
		}
		return Target{Host: host, Port: port, Raw: raw}, nil
	}

	colons := strings.Count(raw, ":")
	if colons == 0 {
		host, err := ValidateHost(raw)
		if err != nil {
			return Target{}, err
		}
		return Target{Host: host, Port: defaultPort, Raw: raw}, nil
	}
	if colons > 1 {
		if addr, err := netip.ParseAddr(raw); err == nil && addr.Is6() {
			return Target{Host: strings.ToLower(raw), Port: defaultPort, Raw: raw}, nil
		}
		return Target{}, relayerr.New(relayerr.BadTarget, "IPv6 targets must be written as [address]:port", 400)
	}
	index := strings.LastIndex(raw, ":")
	host, err := ValidateHost(raw[:index])
	if err != nil {
		return Target{}, err
	}
	port, err := ParsePort(raw[index+1:])
	if err != nil {
		return Target{}, err
	}
	return Target{Host: host, Port: port, Raw: raw}, nil
}

// ExtractToken returns the relay token from, in order: ?token=, an
// Authorization: Bearer header, the configured token header, x-relay-token.
func ExtractToken(requestURL *url.URL, headers http.Header, tokenHeader string) string {
	if requestURL != nil {
		if token := requestURL.Query().Get("token"); token != "" {
			return token
		}
	}
	if authorization := headers.Get("Authorization"); authorization != "" {
		if match := bearerPattern.FindStringSubmatch(authorization); match != nil {
			if value := strings.TrimSpace(match[1]); value != "" {
				return value
			}
		}
	}
	if tokenHeader != "" {
		if value := strings.TrimSpace(headers.Get(tokenHeader)); value != "" {
			return value
		}
	}
	if value := strings.TrimSpace(headers.Get("x-relay-token")); value != "" {
		return value
	}
	return ""
}

// ExtractOrigin returns the trimmed Origin header ("" when absent).
func ExtractOrigin(headers http.Header) string {
	return strings.TrimSpace(headers.Get("Origin"))
}

// ParseRelayRequest parses the relay URL. Unknown query parameters (such as
// ?protocol=7) are ignored and never forwarded.
func ParseRelayRequest(rawURL string, headers http.Header, udpPath, tokenHeader string) (*Request, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, relayerr.New(relayerr.BadTarget, "Malformed request URL", 400)
	}
	pathname := parsed.EscapedPath()
	base := udpPath
	if strings.HasSuffix(base, "/") {
		base = base[:len(base)-1]
	}
	if pathname != base && !strings.HasPrefix(pathname, base+"/") {
		return nil, relayerr.New(relayerr.BadPath, "Unknown endpoint: "+pathname, 404)
	}

	var pathTarget *string
	if pathname != base && len(pathname) >= len(base)+1 {
		segment, unescapeErr := url.PathUnescape(pathname[len(base)+1:])
		if unescapeErr != nil {
			return nil, relayerr.New(relayerr.BadTarget, "Target contains invalid percent-encoding", 400)
		}
		if strings.Contains(segment, "/") {
			return nil, relayerr.New(relayerr.BadTarget, "Target must be a single host:port segment", 400)
		}
		if segment != "" {
			value := segment
			pathTarget = &value
		}
	}

	query := parsed.Query()
	queryValues, hasQueryTarget := query["target"]
	queryTarget := ""
	if hasQueryTarget && len(queryValues) > 0 {
		queryTarget = queryValues[0]
	}

	effectiveTarget := pathTarget
	switch {
	case hasQueryTarget && queryTarget != "":
		if pathTarget != nil && queryTarget != *pathTarget {
			return nil, relayerr.New(relayerr.TargetConflict, "Path target and ?target disagree", 400)
		}
		value := queryTarget
		effectiveTarget = &value
	case hasQueryTarget && queryTarget == "" && pathTarget == nil:
		return nil, relayerr.New(relayerr.BadTarget, "Empty ?target parameter", 400)
	}

	if effectiveTarget == nil || *effectiveTarget == "" {
		return nil, relayerr.New(relayerr.BadTarget, "Missing target; use /udp/host:port or ?target=host:port", 400)
	}

	target, err := SplitHostPort(*effectiveTarget, DefaultTargetPort)
	if err != nil {
		return nil, err
	}
	return &Request{
		Target:   target,
		Token:    ExtractToken(parsed, headers, tokenHeader),
		URL:      parsed,
		Pathname: pathname,
		Origin:   ExtractOrigin(headers),
	}, nil
}

// FormatTarget formats host:port, bracketing IPv6 literals.
func FormatTarget(host string, port int) string {
	return Target{Host: host, Port: port}.String()
}
