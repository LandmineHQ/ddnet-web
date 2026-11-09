// Package ssrf implements the relay's SSRF protection: every target host is
// either a literal IP or resolved once through DNS, all answers are classified,
// private/reserved answers are rejected unless the operator allows them, and the
// validated address is pinned so a second DNS answer can never redirect packets.
//
// The address categories and error messages mirror the legacy Node relay's
// ssrf.mjs.
package ssrf

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"

	"ddnet-relay-go/internal/relayerr"
)

// Classification is the result of classifyAddress.
type Classification struct {
	Valid     bool
	Address   netip.Addr
	Family    int
	Mapped    bool
	Forbidden bool
	Category  string
}

type prefixRule struct {
	category string
	prefix   netip.Prefix
}

func mustPrefix(value string) netip.Prefix {
	prefix, err := netip.ParsePrefix(value)
	if err != nil {
		panic("ssrf: invalid built-in prefix " + value + ": " + err.Error())
	}
	return prefix.Masked()
}

// Ordered so the first match wins. The order mirrors IPv4_CATEGORIES /
// IPv6_CATEGORIES in the Node relay.
var ipv4Rules = []prefixRule{
	{"unspecified", mustPrefix("0.0.0.0/8")},
	{"loopback", mustPrefix("127.0.0.0/8")},
	{"private", mustPrefix("10.0.0.0/8")},
	{"private", mustPrefix("172.16.0.0/12")},
	{"private", mustPrefix("192.168.0.0/16")},
	{"link_local", mustPrefix("169.254.0.0/16")},
	{"cgnat", mustPrefix("100.64.0.0/10")},
	{"broadcast", mustPrefix("255.255.255.255/32")},
	{"multicast", mustPrefix("224.0.0.0/4")},
	{"reserved", mustPrefix("192.0.0.0/24")},
	{"reserved", mustPrefix("192.0.2.0/24")},
	{"reserved", mustPrefix("192.88.99.0/24")},
	{"reserved", mustPrefix("198.18.0.0/15")},
	{"reserved", mustPrefix("198.51.100.0/24")},
	{"reserved", mustPrefix("203.0.113.0/24")},
	{"reserved", mustPrefix("240.0.0.0/4")},
}

var ipv6Rules = []prefixRule{
	{"unspecified", mustPrefix("::/128")},
	{"loopback", mustPrefix("::1/128")},
	{"ipv4_mapped", mustPrefix("::ffff:0:0/96")},
	{"private", mustPrefix("fc00::/7")},
	{"link_local", mustPrefix("fe80::/10")},
	{"multicast", mustPrefix("ff00::/8")},
	{"reserved", mustPrefix("100::/64")},
	{"reserved", mustPrefix("2001:db8::/32")},
	{"reserved", mustPrefix("64:ff9b:1::/48")},
	{"reserved", mustPrefix("3fff::/20")},
}

// stripZone removes an IPv6 zone index (%eth0) for classification purposes.
func stripZone(value string) string {
	if index := strings.IndexByte(value, '%'); index >= 0 {
		return value[:index]
	}
	return value
}

// NormalizeAddress parses an IP address, strips an IPv6 zone index and converts
// IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) into 4-byte IPv4 values.
func NormalizeAddress(raw string) (netip.Addr, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return netip.Addr{}, false
	}
	addr, err := netip.ParseAddr(stripZone(value))
	if err != nil {
		return netip.Addr{}, false
	}
	if addr.Is4In6() {
		addr = addr.Unmap()
	}
	return addr, true
}

func categoryFor(addr netip.Addr) string {
	rules := ipv4Rules
	if addr.Is6() {
		rules = ipv6Rules
	}
	for _, rule := range rules {
		if rule.prefix.Contains(addr) {
			return rule.category
		}
	}
	return "public"
}

// ClassifyAddress classifies an address as public or as one of the forbidden
// categories (unspecified, loopback, private, link_local, cgnat, broadcast,
// multicast, reserved, ipv4_mapped, invalid).
func ClassifyAddress(raw string) Classification {
	value := strings.TrimSpace(raw)
	mapped := false
	if parsed, err := netip.ParseAddr(stripZone(value)); err == nil && parsed.Is4In6() {
		mapped = true
	}
	addr, ok := NormalizeAddress(value)
	if !ok {
		return Classification{Valid: false, Forbidden: true, Category: "invalid"}
	}
	family := 4
	if addr.Is6() {
		family = 6
	}
	category := categoryFor(addr)
	return Classification{
		Valid:     true,
		Address:   addr,
		Family:    family,
		Mapped:    mapped,
		Forbidden: category != "public",
		Category:  category,
	}
}

// Policy is the operator SSRF allowlist: hostnames, literal IPs and CIDRs.
type Policy struct {
	AllowPrivate bool
	hosts        map[string]struct{}
	prefixes     []netip.Prefix
	addrs        map[netip.Addr]struct{}
	hasIPRules   bool
}

// NewPolicy compiles an allowlist. It fails on invalid CIDR entries, exactly
// like the Node relay fails at startup.
func NewPolicy(allowPrivate bool, allowlist []string) (*Policy, error) {
	policy := &Policy{
		AllowPrivate: allowPrivate,
		hosts:        make(map[string]struct{}),
		addrs:        make(map[netip.Addr]struct{}),
	}
	for _, raw := range allowlist {
		entry := strings.ToLower(strings.TrimSpace(raw))
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			prefix, err := netip.ParsePrefix(entry)
			if err != nil {
				return nil, fmt.Errorf("invalid allowlist CIDR entry: %s", entry)
			}
			if prefix.Addr().Is4In6() {
				bits := prefix.Bits() - 96
				if bits < 0 {
					return nil, fmt.Errorf("invalid allowlist CIDR entry: %s", entry)
				}
				prefix = netip.PrefixFrom(prefix.Addr().Unmap(), bits)
			}
			policy.prefixes = append(policy.prefixes, prefix.Masked())
			policy.hasIPRules = true
			continue
		}
		if addr, ok := NormalizeAddress(entry); ok {
			policy.addrs[addr] = struct{}{}
			policy.hasIPRules = true
			continue
		}
		policy.hosts[entry] = struct{}{}
	}
	return policy, nil
}

// HostAllowed reports whether hostname is allowlisted (case-insensitive).
func (p *Policy) HostAllowed(host string) bool {
	if p == nil {
		return false
	}
	_, ok := p.hosts[strings.ToLower(strings.TrimSpace(host))]
	return ok
}

// IPAllowed reports whether addr matches an allowlisted IP/CIDR.
func (p *Policy) IPAllowed(addr netip.Addr) bool {
	if p == nil || !p.hasIPRules {
		return false
	}
	addr = addr.Unmap()
	if _, ok := p.addrs[addr]; ok {
		return true
	}
	for _, prefix := range p.prefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// Evaluate validates one address against the policy. It returns a
// target_not_allowed relay error for private/reserved addresses.
func Evaluate(ip string, host string, policy *Policy) (Classification, error) {
	classification := ClassifyAddress(ip)
	if !classification.Valid {
		return classification, relayerr.New(relayerr.TargetNotAllowed, "Invalid target address: "+ip, 403)
	}
	bypass := policy != nil && (policy.AllowPrivate || policy.HostAllowed(host) || policy.IPAllowed(classification.Address))
	if classification.Forbidden && !bypass {
		message := fmt.Sprintf(
			"Target %s resolves to a blocked %s address (%s); set ALLOW_PRIVATE=true or add an allowlist entry to permit it",
			host, classification.Category, classification.Address.String(),
		)
		return classification, relayerr.New(relayerr.TargetNotAllowed, message, 403).WithDetails(map[string]any{
			"category": classification.Category,
			"address":  classification.Address.String(),
		})
	}
	return classification, nil
}

// LookupFunc resolves a hostname to IP addresses. It is injectable for tests.
type LookupFunc func(ctx context.Context, host string) ([]netip.Addr, error)

// DefaultLookup resolves through the system resolver.
func DefaultLookup(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// Resolved is a validated, pinned target address.
type Resolved struct {
	Host      string
	Address   netip.Addr
	Family    int
	Addresses []netip.Addr
}

func dnsFailureReason(err error) string {
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		if dnsError.IsNotFound {
			return "ENOTFOUND"
		}
		if dnsError.IsTimeout {
			return "ETIMEDOUT"
		}
		if dnsError.Err != "" {
			return dnsError.Err
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "ETIMEDOUT"
	}
	return "lookup_failed"
}

// ResolveTarget resolves and validates a target host. Literal IPs are checked
// directly; hostnames go through lookup once and every answer is validated.
// The first IPv4 answer is pinned (otherwise the first answer).
func ResolveTarget(ctx context.Context, host string, policy *Policy, lookup LookupFunc, timeout time.Duration) (Resolved, error) {
	if policy == nil {
		var err error
		policy, err = NewPolicy(false, nil)
		if err != nil {
			return Resolved{}, err
		}
	}
	if addr, ok := NormalizeAddress(host); ok {
		classification, err := Evaluate(addr.String(), host, policy)
		if err != nil {
			return Resolved{}, err
		}
		return Resolved{Host: host, Address: classification.Address, Family: classification.Family, Addresses: []netip.Addr{classification.Address}}, nil
	}
	if lookup == nil {
		lookup = DefaultLookup
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	answers, err := lookup(ctx, host)
	if err != nil {
		return Resolved{}, relayerr.New(
			relayerr.DNSFailed,
			fmt.Sprintf("DNS lookup failed for %s: %s", host, dnsFailureReason(err)),
			502,
		)
	}
	if len(answers) == 0 {
		return Resolved{}, relayerr.New(relayerr.DNSFailed, fmt.Sprintf("DNS lookup returned no addresses for %s", host), 502)
	}
	examined := make([]Classification, 0, len(answers))
	addresses := make([]netip.Addr, 0, len(answers))
	for _, answer := range answers {
		classification, err := Evaluate(answer.String(), host, policy)
		if err != nil {
			return Resolved{}, err
		}
		examined = append(examined, classification)
		addresses = append(addresses, classification.Address)
	}
	pinned := examined[0]
	for _, classification := range examined {
		if classification.Family == 4 {
			pinned = classification
			break
		}
	}
	return Resolved{Host: host, Address: pinned.Address, Family: pinned.Family, Addresses: addresses}, nil
}
