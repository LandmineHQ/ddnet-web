package urlparse

import (
	"net/http"
	"strings"
	"testing"

	"ddnet-relay-go/internal/relayerr"
)

func TestParsePort(t *testing.T) {
	cases := []struct {
		input string
		want  int
		ok    bool
	}{
		{"8303", 8303, true},
		{"1", 1, true},
		{"65535", 65535, true},
		{"0", 0, false},
		{"65536", 0, false},
		{"", 0, false},
		{"abc", 0, false},
		{"123456", 0, false},
		{"12.5", 0, false},
		{"-1", 0, false},
	}
	for _, testCase := range cases {
		port, err := ParsePort(testCase.input)
		if testCase.ok {
			if err != nil || port != testCase.want {
				t.Fatalf("ParsePort(%q) = %d, %v; want %d", testCase.input, port, err, testCase.want)
			}
		} else if err == nil {
			t.Fatalf("ParsePort(%q) unexpectedly succeeded with %d", testCase.input, port)
		}
	}
}

func TestValidateHost(t *testing.T) {
	valid := []string{"example.org", "127.0.0.1", "::1", "teeworlds.example", "_srv.example.com", "A.Example.COM"}
	for _, host := range valid {
		value, err := ValidateHost(host)
		if err != nil {
			t.Fatalf("ValidateHost(%q) failed: %v", host, err)
		}
		if value != strings.ToLower(host) {
			t.Fatalf("ValidateHost(%q) = %q; want lowercase", host, value)
		}
	}
	invalid := []string{"", " ", "a b", "host/../x", ".example.com", "example.com.", "a..b", "[::1]", "host@example.com"}
	for _, host := range invalid {
		if _, err := ValidateHost(host); err == nil {
			t.Fatalf("ValidateHost(%q) unexpectedly succeeded", host)
		}
	}
}

func TestSplitHostPort(t *testing.T) {
	cases := []struct {
		input   string
		host    string
		port    int
		wantErr bool
	}{
		{"127.0.0.1:8313", "127.0.0.1", 8313, false},
		{"example.org", "example.org", DefaultTargetPort, false},
		{"example.org:8303", "example.org", 8303, false},
		{"[::1]:8313", "::1", 8313, false},
		{"[::1]", "::1", DefaultTargetPort, false},
		{"2001:db8::1", "2001:db8::1", DefaultTargetPort, false},
		{"[127.0.0.1]:8303", "", 0, true},
		{"[::1]:0", "", 0, true},
		{"[::1", "", 0, true},
		{"[::1]extra", "", 0, true},
		{"", "", 0, true},
		{":8303", "", 0, true},
		{"host:", "", 0, true},
		{"host:99999", "", 0, true},
		{"2001:db8::1:8303", "2001:db8::1:8303", DefaultTargetPort, false},
	}
	for _, testCase := range cases {
		target, err := SplitHostPort(testCase.input, DefaultTargetPort)
		if testCase.wantErr {
			if err == nil {
				t.Fatalf("SplitHostPort(%q) unexpectedly succeeded: %+v", testCase.input, target)
			}
			continue
		}
		if err != nil {
			t.Fatalf("SplitHostPort(%q) failed: %v", testCase.input, err)
		}
		if target.Host != testCase.host || target.Port != testCase.port {
			t.Fatalf("SplitHostPort(%q) = %s:%d; want %s:%d", testCase.input, target.Host, target.Port, testCase.host, testCase.port)
		}
	}
}

func TestTargetString(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:8303":   "127.0.0.1:8303",
		"example.org:8303": "example.org:8303",
	}
	for input, want := range cases {
		target, err := SplitHostPort(input, DefaultTargetPort)
		if err != nil {
			t.Fatalf("SplitHostPort(%q): %v", input, err)
		}
		if got := target.String(); got != want {
			t.Fatalf("Target.String() = %q; want %q", got, want)
		}
	}
	target, err := SplitHostPort("[2001:db8::1]:8303", DefaultTargetPort)
	if err != nil {
		t.Fatalf("SplitHostPort v6: %v", err)
	}
	if got := target.String(); got != "[2001:db8::1]:8303" {
		t.Fatalf("Target.String() = %q; want bracketed IPv6", got)
	}
}

func TestParseRelayRequestPath(t *testing.T) {
	headers := http.Header{"Origin": []string{"https://relay.example.com"}}

	request, err := ParseRelayRequest("/udp/127.0.0.1:8313?token=abc&protocol=7&sevenup=1", headers, "/udp", "x-relay-token")
	if err != nil {
		t.Fatalf("ParseRelayRequest failed: %v", err)
	}
	if request.Target.Host != "127.0.0.1" || request.Target.Port != 8313 {
		t.Fatalf("unexpected target: %+v", request.Target)
	}
	if request.Token != "abc" {
		t.Fatalf("token = %q; want abc", request.Token)
	}
	if request.Origin != "https://relay.example.com" {
		t.Fatalf("origin = %q", request.Origin)
	}

	// Percent-encoded colon in the path.
	request, err = ParseRelayRequest("/udp/127.0.0.1%3A8313", nil, "/udp", "x-relay-token")
	if err != nil {
		t.Fatalf("percent-encoded target failed: %v", err)
	}
	if request.Target.Port != 8313 {
		t.Fatalf("percent-encoded port = %d", request.Target.Port)
	}

	// Query target with an explicitly empty path segment.
	request, err = ParseRelayRequest("/udp/?target=example.org:8400", nil, "/udp", "x-relay-token")
	if err != nil {
		t.Fatalf("query target failed: %v", err)
	}
	if request.Target.String() != "example.org:8400" {
		t.Fatalf("query target = %s", request.Target.String())
	}

	// Path and query target must agree.
	if _, err := ParseRelayRequest("/udp/a.example:8303?target=b.example:8303", nil, "/udp", "x-relay-token"); err == nil {
		t.Fatal("conflicting targets were accepted")
	} else if relayerr.CodeOf(err, "") != relayerr.TargetConflict {
		t.Fatalf("conflict code = %s", relayerr.CodeOf(err, ""))
	}

	// Missing target.
	for _, raw := range []string{"/udp", "/udp/", "/udp?target="} {
		if _, err := ParseRelayRequest(raw, nil, "/udp", "x-relay-token"); err == nil {
			t.Fatalf("%q unexpectedly accepted", raw)
		}
	}

	// Multi-segment targets are rejected.
	if _, err := ParseRelayRequest("/udp/a%2Fb:8303", nil, "/udp", "x-relay-token"); err == nil {
		t.Fatal("multi-segment target accepted")
	}

	// Unknown path.
	if _, err := ParseRelayRequest("/healthz", nil, "/udp", "x-relay-token"); err == nil {
		t.Fatal("unknown path accepted")
	} else if relayerr.CodeOf(err, "") != relayerr.BadPath {
		t.Fatalf("bad path code = %s", relayerr.CodeOf(err, ""))
	}
}

func TestExtractTokenPrecedence(t *testing.T) {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer bearer-token")
	headers.Set("x-relay-token", "header-token")
	request, err := ParseRelayRequest("/udp/example.org:8303?token=query-token", headers, "/udp", "x-relay-token")
	if err != nil {
		t.Fatalf("ParseRelayRequest: %v", err)
	}
	if request.Token != "query-token" {
		t.Fatalf("query token not preferred: %q", request.Token)
	}

	request, err = ParseRelayRequest("/udp/example.org:8303", headers, "/udp", "x-relay-token")
	if err != nil {
		t.Fatalf("ParseRelayRequest: %v", err)
	}
	if request.Token != "bearer-token" {
		t.Fatalf("bearer token = %q", request.Token)
	}

	headers.Del("Authorization")
	request, err = ParseRelayRequest("/udp/example.org:8303", headers, "/udp", "x-relay-token")
	if err != nil {
		t.Fatalf("ParseRelayRequest: %v", err)
	}
	if request.Token != "header-token" {
		t.Fatalf("header token = %q", request.Token)
	}

	if token := ExtractToken(nil, http.Header{}, "x-relay-token"); token != "" {
		t.Fatalf("expected empty token, got %q", token)
	}
}

func TestMalformedURL(t *testing.T) {
	if _, err := ParseRelayRequest("http://[::1", nil, "/udp", "x-relay-token"); err == nil {
		t.Fatal("malformed URL accepted")
	}
}
