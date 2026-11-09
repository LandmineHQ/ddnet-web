// Package auth implements relay token authentication and Origin allowlist
// checks with the same semantics as the legacy Node relay's auth.mjs.
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"strings"
)

// TokenResult is the outcome of a token check.
type TokenResult struct {
	OK        bool
	Anonymous bool
	Reason    string
}

// OriginResult is the outcome of an Origin allowlist check.
type OriginResult struct {
	OK     bool
	Reason string
}

// SafeEqual compares two secrets in constant time. Both values are hashed
// first so the comparison time does not depend on the shared prefix.
func SafeEqual(a, b string) bool {
	left := sha256.Sum256([]byte(a))
	right := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(left[:], right[:]) == 1 && len(a) == len(b)
}

// CheckToken validates a provided token against the configured token list. An
// empty list means the relay is open (anonymous access). Every configured
// token is evaluated; there is no early exit.
func CheckToken(provided string, tokens []string) TokenResult {
	list := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if token != "" {
			list = append(list, token)
		}
	}
	if len(list) == 0 {
		return TokenResult{OK: true, Anonymous: true}
	}
	if provided == "" {
		return TokenResult{Reason: "missing_token"}
	}
	matched := false
	for _, token := range list {
		if SafeEqual(provided, token) {
			matched = true
		}
	}
	if matched {
		return TokenResult{OK: true}
	}
	return TokenResult{Reason: "invalid_token"}
}

// CheckOrigin validates a browser Origin against the allowlist. Missing Origin
// is controlled by allowMissing (browsers always send one). An empty allowlist
// leaves the relay open.
func CheckOrigin(origin string, allowlist []string, allowMissing bool) OriginResult {
	if origin == "" {
		if allowMissing {
			return OriginResult{OK: true, Reason: "no_origin"}
		}
		return OriginResult{Reason: "missing_origin"}
	}
	list := make([]string, 0, len(allowlist))
	for _, entry := range allowlist {
		if strings.TrimSpace(entry) != "" {
			list = append(list, entry)
		}
	}
	if len(list) == 0 {
		return OriginResult{OK: true}
	}
	value := strings.ToLower(strings.TrimSpace(origin))
	for _, entry := range list {
		allowed := strings.ToLower(strings.TrimSpace(entry))
		if allowed == "*" || allowed == value {
			return OriginResult{OK: true}
		}
		if strings.Contains(allowed, "*") && wildcardMatch(allowed, value) {
			return OriginResult{OK: true}
		}
	}
	return OriginResult{Reason: "origin_not_allowed"}
}

// wildcardMatch matches value against a pattern where '*' matches any run of
// characters (including none). Everything else is literal.
func wildcardMatch(pattern, value string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == value
	}
	if !strings.HasPrefix(value, parts[0]) {
		return false
	}
	position := len(parts[0])
	for _, part := range parts[1 : len(parts)-1] {
		index := strings.Index(value[position:], part)
		if index < 0 {
			return false
		}
		position += index + len(part)
	}
	last := parts[len(parts)-1]
	return len(value) >= position && strings.HasSuffix(value[position:], last)
}

// RedactToken returns a redacted representation of a token for logs.
func RedactToken(token string) string {
	if token == "" {
		return ""
	}
	if len(token) <= 4 {
		return "***"
	}
	return token[:2] + "***" + token[len(token)-2:]
}
