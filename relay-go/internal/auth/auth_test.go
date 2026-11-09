package auth

import "testing"

func TestSafeEqual(t *testing.T) {
	if !SafeEqual("token", "token") {
		t.Fatal("identical strings not equal")
	}
	if SafeEqual("token", "tokeN") {
		t.Fatal("different strings equal")
	}
	if SafeEqual("token", "token ") {
		t.Fatal("different lengths equal")
	}
	if SafeEqual("", "x") || SafeEqual("x", "") {
		t.Fatal("empty/non-empty equal")
	}
}

func TestCheckToken(t *testing.T) {
	result := CheckToken("anything", nil)
	if !result.OK || !result.Anonymous {
		t.Fatalf("empty token list should be anonymous: %+v", result)
	}
	result = CheckToken("", []string{"", ""})
	if !result.OK || !result.Anonymous {
		t.Fatalf("blank token list should be anonymous: %+v", result)
	}
	// A whitespace-only entry is a real configured token (Node parity); the
	// config loader trims entries before they reach this function.
	result = CheckToken("", []string{"  "})
	if result.OK || result.Reason != "missing_token" {
		t.Fatalf("whitespace token should count as configured: %+v", result)
	}
	result = CheckToken("", []string{"secret"})
	if result.OK || result.Reason != "missing_token" {
		t.Fatalf("missing token: %+v", result)
	}
	result = CheckToken("wrong", []string{"secret", "other"})
	if result.OK || result.Reason != "invalid_token" {
		t.Fatalf("invalid token: %+v", result)
	}
	result = CheckToken("other", []string{"secret", "other"})
	if !result.OK {
		t.Fatalf("valid token rejected: %+v", result)
	}
}

func TestCheckOrigin(t *testing.T) {
	if result := CheckOrigin("", nil, true); !result.OK || result.Reason != "no_origin" {
		t.Fatalf("missing origin with allowMissing: %+v", result)
	}
	if result := CheckOrigin("", nil, false); result.OK || result.Reason != "missing_origin" {
		t.Fatalf("missing origin without allowMissing: %+v", result)
	}
	if result := CheckOrigin("https://evil.example.com", nil, false); !result.OK {
		t.Fatalf("empty allowlist should be open: %+v", result)
	}
	allowlist := []string{"https://relay.example.com", "https://*.ddnet.example"}
	if result := CheckOrigin("https://relay.example.com", allowlist, false); !result.OK {
		t.Fatalf("exact origin rejected: %+v", result)
	}
	if result := CheckOrigin("HTTPS://RELAY.EXAMPLE.COM", allowlist, false); !result.OK {
		t.Fatalf("origin match should be case-insensitive: %+v", result)
	}
	if result := CheckOrigin("https://cdn.ddnet.example", allowlist, false); !result.OK {
		t.Fatalf("wildcard origin rejected: %+v", result)
	}
	if result := CheckOrigin("https://evil.example.com", allowlist, false); result.OK || result.Reason != "origin_not_allowed" {
		t.Fatalf("unknown origin accepted: %+v", result)
	}
	if result := CheckOrigin("https://anything.example", []string{"*"}, false); !result.OK {
		t.Fatalf("star allowlist rejected: %+v", result)
	}
}

func TestRedactToken(t *testing.T) {
	if got := RedactToken(""); got != "" {
		t.Fatalf("RedactToken('') = %q", got)
	}
	if got := RedactToken("abcd"); got != "***" {
		t.Fatalf("RedactToken(abcd) = %q", got)
	}
	if got := RedactToken("abcdefgh"); got != "ab***gh" {
		t.Fatalf("RedactToken(abcdefgh) = %q", got)
	}
}
