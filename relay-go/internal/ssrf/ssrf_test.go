package ssrf

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"

	"ddnet-relay-go/internal/relayerr"
)

func TestNormalizeAddress(t *testing.T) {
	cases := []struct {
		input string
		want  string
		ok    bool
	}{
		{"127.0.0.1", "127.0.0.1", true},
		{"::1", "::1", true},
		{"::ffff:127.0.0.1", "127.0.0.1", true},
		{"fe80::1%eth0", "fe80::1", true},
		{" 10.0.0.1 ", "10.0.0.1", true},
		{"example.org", "", false},
		{"999.1.1.1", "", false},
		{"", "", false},
	}
	for _, testCase := range cases {
		addr, ok := NormalizeAddress(testCase.input)
		if ok != testCase.ok {
			t.Fatalf("NormalizeAddress(%q) ok = %v; want %v", testCase.input, ok, testCase.ok)
		}
		if ok && addr.String() != testCase.want {
			t.Fatalf("NormalizeAddress(%q) = %s; want %s", testCase.input, addr, testCase.want)
		}
	}
}

func TestClassifyAddress(t *testing.T) {
	cases := []struct {
		ip        string
		category  string
		forbidden bool
		family    int
	}{
		{"127.0.0.1", "loopback", true, 4},
		{"10.1.2.3", "private", true, 4},
		{"172.16.0.1", "private", true, 4},
		{"172.31.255.255", "private", true, 4},
		{"192.168.1.1", "private", true, 4},
		{"169.254.169.254", "link_local", true, 4},
		{"100.64.0.1", "cgnat", true, 4},
		{"224.0.0.1", "multicast", true, 4},
		{"255.255.255.255", "broadcast", true, 4},
		{"192.0.2.1", "reserved", true, 4},
		{"0.0.0.0", "unspecified", true, 4},
		{"8.8.8.8", "public", false, 4},
		{"1.1.1.1", "public", false, 4},
		{"::1", "loopback", true, 6},
		{"fc00::1", "private", true, 6},
		{"fd12:3456::1", "private", true, 6},
		{"fe80::1", "link_local", true, 6},
		{"ff02::1", "multicast", true, 6},
		{"2001:db8::1", "reserved", true, 6},
		{"2001:4860:4860::8888", "public", false, 6},
		{"not-an-ip", "invalid", true, 0},
	}
	for _, testCase := range cases {
		classification := ClassifyAddress(testCase.ip)
		if classification.Category != testCase.category || classification.Forbidden != testCase.forbidden {
			t.Fatalf("ClassifyAddress(%q) = category %q forbidden %v; want %q %v",
				testCase.ip, classification.Category, classification.Forbidden, testCase.category, testCase.forbidden)
		}
		if classification.Valid && classification.Family != testCase.family {
			t.Fatalf("ClassifyAddress(%q) family = %d; want %d", testCase.ip, classification.Family, testCase.family)
		}
	}
}

func TestPolicyAllowlist(t *testing.T) {
	policy, err := NewPolicy(false, []string{"127.0.0.1/32", "10.0.0.0/8", "::1", "lan.example"})
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}
	if !policy.HostAllowed("LAN.example") {
		t.Fatal("hostname allowlist is not case-insensitive")
	}
	if !policy.IPAllowed(netip.MustParseAddr("127.0.0.1")) {
		t.Fatal("literal IP allowlist entry ignored")
	}
	if !policy.IPAllowed(netip.MustParseAddr("10.20.30.40")) {
		t.Fatal("CIDR allowlist entry ignored")
	}
	if policy.IPAllowed(netip.MustParseAddr("11.0.0.1")) {
		t.Fatal("unrelated address allowed")
	}

	if _, err := NewPolicy(false, []string{"10.0.0.0/33"}); err == nil {
		t.Fatal("invalid CIDR accepted")
	}
	if _, err := NewPolicy(false, []string{"banana/cidr"}); err == nil {
		t.Fatal("invalid CIDR accepted")
	}
}

func TestEvaluate(t *testing.T) {
	policy, err := NewPolicy(false, nil)
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}
	if _, err := Evaluate("127.0.0.1", "127.0.0.1", policy); err == nil {
		t.Fatal("loopback target allowed without allowlist")
	} else {
		if relayerr.CodeOf(err, "") != relayerr.TargetNotAllowed {
			t.Fatalf("code = %s", relayerr.CodeOf(err, ""))
		}
		if !strings.Contains(err.Error(), "loopback") {
			t.Fatalf("error message misses category: %v", err)
		}
	}
	if _, err := Evaluate("8.8.8.8", "dns.google", policy); err != nil {
		t.Fatalf("public target rejected: %v", err)
	}

	allowed, err := NewPolicy(false, []string{"127.0.0.1/32"})
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}
	if _, err := Evaluate("127.0.0.1", "127.0.0.1", allowed); err != nil {
		t.Fatalf("allowlisted loopback rejected: %v", err)
	}

	allowPrivate, err := NewPolicy(true, nil)
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}
	if _, err := Evaluate("192.168.1.10", "192.168.1.10", allowPrivate); err != nil {
		t.Fatalf("ALLOW_PRIVATE did not permit private target: %v", err)
	}

	hostAllowed, err := NewPolicy(false, []string{"metadata.example.com"})
	if err != nil {
		t.Fatalf("NewPolicy: %v", err)
	}
	if _, err := Evaluate("169.254.169.254", "metadata.example.com", hostAllowed); err != nil {
		t.Fatalf("allowlisted hostname rejected: %v", err)
	}
}

func TestResolveTargetLiteral(t *testing.T) {
	policy, _ := NewPolicy(false, []string{"127.0.0.1/32"})
	resolved, err := ResolveTarget(context.Background(), "127.0.0.1", policy, nil, time.Second)
	if err != nil {
		t.Fatalf("ResolveTarget: %v", err)
	}
	if resolved.Address.String() != "127.0.0.1" || resolved.Family != 4 {
		t.Fatalf("unexpected resolved target: %+v", resolved)
	}

	blocked, _ := NewPolicy(false, nil)
	if _, err := ResolveTarget(context.Background(), "127.0.0.1", blocked, nil, time.Second); err == nil {
		t.Fatal("loopback literal accepted")
	}
}

func TestResolveTargetDNS(t *testing.T) {
	policy, _ := NewPolicy(false, nil)
	lookup := func(ctx context.Context, host string) ([]netip.Addr, error) {
		return []netip.Addr{
			netip.MustParseAddr("2606:4700:4700::1111"),
			netip.MustParseAddr("1.1.1.1"),
		}, nil
	}
	resolved, err := ResolveTarget(context.Background(), "one.one.one.one", policy, lookup, time.Second)
	if err != nil {
		t.Fatalf("ResolveTarget: %v", err)
	}
	if resolved.Address.String() != "1.1.1.1" {
		t.Fatalf("expected IPv4 pinning, got %s", resolved.Address)
	}
	if len(resolved.Addresses) != 2 {
		t.Fatalf("expected both addresses, got %v", resolved.Addresses)
	}

	// Any blocked answer rejects the whole target (DNS rebinding defence).
	mixed := func(ctx context.Context, host string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("169.254.169.254")}, nil
	}
	if _, err := ResolveTarget(context.Background(), "mixed.example", policy, mixed, time.Second); err == nil {
		t.Fatal("target with a private DNS answer accepted")
	}

	failing := func(ctx context.Context, host string) ([]netip.Addr, error) {
		return nil, &netError{}
	}
	if _, err := ResolveTarget(context.Background(), "broken.example", policy, failing, time.Second); err == nil {
		t.Fatal("DNS failure accepted")
	} else if relayerr.CodeOf(err, "") != relayerr.DNSFailed {
		t.Fatalf("DNS error code = %s", relayerr.CodeOf(err, ""))
	}

	empty := func(ctx context.Context, host string) ([]netip.Addr, error) { return nil, nil }
	if _, err := ResolveTarget(context.Background(), "empty.example", policy, empty, time.Second); err == nil {
		t.Fatal("empty DNS answer accepted")
	}
}

type netError struct{}

func (e *netError) Error() string   { return "lookup failed" }
func (e *netError) Timeout() bool   { return false }
func (e *netError) Temporary() bool { return false }

var _ = errors.Is
