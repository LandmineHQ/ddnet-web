// Package ratelimit implements the token buckets, per-IP connection counter and
// frame guard used by the relay. All time values are Unix milliseconds so tests
// can drive the clock deterministically.
package ratelimit

import (
	"sync"
)

// TokenBucket is a classic token bucket refilled continuously (per second).
type TokenBucket struct {
	mu           sync.Mutex
	ratePerSec   float64
	capacity     float64
	tokens       float64
	lastRefillMS int64
}

// NewTokenBucket returns a full bucket. It returns an error when rate/burst are
// not positive (configuration validation normally catches this first).
func NewTokenBucket(ratePerSecond, burst float64, nowMS int64) (*TokenBucket, error) {
	if !(ratePerSecond > 0) {
		return nil, &BucketError{Field: "ratePerSecond"}
	}
	if !(burst > 0) {
		return nil, &BucketError{Field: "burst"}
	}
	return &TokenBucket{ratePerSec: ratePerSecond, capacity: burst, tokens: burst, lastRefillMS: nowMS}, nil
}

// BucketError reports an invalid token bucket configuration.
type BucketError struct{ Field string }

func (e *BucketError) Error() string { return "ratelimit: " + e.Field + " must be > 0" }

func (b *TokenBucket) refill(nowMS int64) {
	if nowMS > b.lastRefillMS {
		elapsedSeconds := float64(nowMS-b.lastRefillMS) / 1000
		b.tokens += elapsedSeconds * b.ratePerSec
		if b.tokens > b.capacity {
			b.tokens = b.capacity
		}
		b.lastRefillMS = nowMS
	}
}

// TryRemove removes amount tokens, returning false when the bucket is empty.
func (b *TokenBucket) TryRemove(amount float64, nowMS int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill(nowMS)
	if b.tokens >= amount {
		b.tokens -= amount
		return true
	}
	return false
}

// Tokens returns the current token count (after refilling to nowMS).
func (b *TokenBucket) Tokens(nowMS int64) float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill(nowMS)
	return b.tokens
}

// ConnectionRateLimiter enforces per-connection packet and byte rates. Both
// buckets are charged even when one of them is exhausted, mirroring the Node
// implementation.
type ConnectionRateLimiter struct {
	packets *TokenBucket
	bytes   *TokenBucket
}

// NewConnectionRateLimiter builds a limiter from config limits.
func NewConnectionRateLimiter(packetsPerSecond, packetBurst, bytesPerSecond, byteBurst float64, nowMS int64) (*ConnectionRateLimiter, error) {
	packets, err := NewTokenBucket(packetsPerSecond, packetBurst, nowMS)
	if err != nil {
		return nil, err
	}
	bytesBucket, err := NewTokenBucket(bytesPerSecond, byteBurst, nowMS)
	if err != nil {
		return nil, err
	}
	return &ConnectionRateLimiter{packets: packets, bytes: bytesBucket}, nil
}

// AllowPacket charges one packet + bytes. It returns a drop reason when the
// budget is exhausted: "packet_rate" or "byte_rate".
func (l *ConnectionRateLimiter) AllowPacket(bytes int, nowMS int64) (bool, string) {
	if bytes <= 0 {
		return true, ""
	}
	packetOK := l.packets.TryRemove(1, nowMS)
	byteOK := l.bytes.TryRemove(float64(bytes), nowMS)
	if !packetOK || !byteOK {
		if !packetOK {
			return false, "packet_rate"
		}
		return false, "byte_rate"
	}
	return true, ""
}

// IPConnectionLimiter counts concurrent connections per client IP.
type IPConnectionLimiter struct {
	mu       sync.Mutex
	maxPerIP int
	counts   map[string]int
}

// NewIPConnectionLimiter creates a limiter with a per-IP cap.
func NewIPConnectionLimiter(maxPerIP int) *IPConnectionLimiter {
	return &IPConnectionLimiter{maxPerIP: maxPerIP, counts: make(map[string]int)}
}

// Acquire reserves a connection slot for ip, returning false at the limit.
func (l *IPConnectionLimiter) Acquire(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	count := l.counts[ip]
	if l.maxPerIP > 0 && count >= l.maxPerIP {
		return false
	}
	l.counts[ip] = count + 1
	return true
}

// Release returns a connection slot for ip.
func (l *IPConnectionLimiter) Release(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	count := l.counts[ip]
	if count <= 1 {
		delete(l.counts, ip)
		return
	}
	l.counts[ip] = count - 1
}

// Count returns the number of active connections for ip.
func (l *IPConnectionLimiter) Count(ip string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.counts[ip]
}

// Size returns the number of tracked IPs.
func (l *IPConnectionLimiter) Size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.counts)
}

// FrameGuard drops oversized frames without closing the session (the hard limit
// is enforced by the WebSocket layer instead).
type FrameGuard struct {
	MaxFrameBytes     int
	HardMaxFrameBytes int
}

// Check validates a frame size. Reason is one of invalid_size, hard_limit,
// too_large (matching the Node drop reasons frame_<reason>).
func (g FrameGuard) Check(bytes int) (bool, string) {
	if bytes < 0 {
		return false, "invalid_size"
	}
	if g.HardMaxFrameBytes > 0 && bytes > g.HardMaxFrameBytes {
		return false, "hard_limit"
	}
	if g.MaxFrameBytes > 0 && bytes > g.MaxFrameBytes {
		return false, "too_large"
	}
	return true, ""
}
