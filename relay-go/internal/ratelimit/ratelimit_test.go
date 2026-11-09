package ratelimit

import "testing"

func TestTokenBucket(t *testing.T) {
	bucket, err := NewTokenBucket(10, 5, 1000)
	if err != nil {
		t.Fatalf("NewTokenBucket: %v", err)
	}
	for i := 0; i < 5; i++ {
		if !bucket.TryRemove(1, 1000) {
			t.Fatalf("burst removal %d failed", i)
		}
	}
	if bucket.TryRemove(1, 1000) {
		t.Fatal("bucket did not empty")
	}
	// 250 ms at 10/s = 2.5 tokens.
	if !bucket.TryRemove(2, 1250) {
		t.Fatal("refill did not produce tokens")
	}
	if bucket.TryRemove(1, 1250) {
		t.Fatal("over-spent refilled tokens")
	}
	if _, err := NewTokenBucket(0, 1, 0); err == nil {
		t.Fatal("zero rate accepted")
	}
}

func TestConnectionRateLimiter(t *testing.T) {
	limiter, err := NewConnectionRateLimiter(1, 1, 1000, 1000, 0)
	if err != nil {
		t.Fatalf("NewConnectionRateLimiter: %v", err)
	}
	if ok, reason := limiter.AllowPacket(10, 0); !ok {
		t.Fatalf("first packet rejected: %s", reason)
	}
	if ok, reason := limiter.AllowPacket(10, 0); ok || reason != "packet_rate" {
		t.Fatalf("second packet not packet-rate limited: ok=%v reason=%s", ok, reason)
	}

	byteLimited, err := NewConnectionRateLimiter(100, 100, 100, 100, 0)
	if err != nil {
		t.Fatalf("NewConnectionRateLimiter: %v", err)
	}
	if ok, reason := byteLimited.AllowPacket(100, 0); !ok {
		t.Fatalf("byte bucket first packet rejected: %s", reason)
	}
	if ok, reason := byteLimited.AllowPacket(50, 0); ok || reason != "byte_rate" {
		t.Fatalf("byte limit not applied: ok=%v reason=%s", ok, reason)
	}
}

func TestIPConnectionLimiter(t *testing.T) {
	limiter := NewIPConnectionLimiter(2)
	if !limiter.Acquire("1.2.3.4") || !limiter.Acquire("1.2.3.4") {
		t.Fatal("acquire within limit failed")
	}
	if limiter.Acquire("1.2.3.4") {
		t.Fatal("acquire above limit succeeded")
	}
	if !limiter.Acquire("5.6.7.8") {
		t.Fatal("other IP rejected")
	}
	if limiter.Count("1.2.3.4") != 2 {
		t.Fatalf("count = %d", limiter.Count("1.2.3.4"))
	}
	limiter.Release("1.2.3.4")
	if limiter.Count("1.2.3.4") != 1 {
		t.Fatalf("count after release = %d", limiter.Count("1.2.3.4"))
	}
	limiter.Release("1.2.3.4")
	if limiter.Size() != 1 {
		t.Fatalf("size after releases = %d", limiter.Size())
	}
	if !limiter.Acquire("1.2.3.4") {
		t.Fatal("acquire after release failed")
	}
}

func TestFrameGuard(t *testing.T) {
	guard := FrameGuard{MaxFrameBytes: 2048, HardMaxFrameBytes: 65536}
	if ok, reason := guard.Check(2048); !ok {
		t.Fatalf("max frame size rejected: %s", reason)
	}
	if ok, reason := guard.Check(2049); ok || reason != "too_large" {
		t.Fatalf("oversized frame: ok=%v reason=%s", ok, reason)
	}
	if ok, reason := guard.Check(65537); ok || reason != "hard_limit" {
		t.Fatalf("hard limit frame: ok=%v reason=%s", ok, reason)
	}
	if ok, reason := guard.Check(-1); ok || reason != "invalid_size" {
		t.Fatalf("negative frame: ok=%v reason=%s", ok, reason)
	}
	if ok, _ := guard.Check(0); !ok {
		t.Fatal("empty frame should pass the guard")
	}
}
