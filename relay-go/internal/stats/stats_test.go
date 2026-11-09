package stats

import (
	"testing"
	"time"
)

func TestSnapshotCounters(t *testing.T) {
	store := New()
	store.SetClock(func() time.Time { return time.UnixMilli(1_700_000_000_000) })

	store.OnConnectionOpen("127.0.0.1:8303", "203.0.113.5")
	store.OnPacketToTarget("127.0.0.1:8303", 64)
	store.OnPacketFromTarget("127.0.0.1:8303", 128)
	store.OnDrop("frame_too_large")
	store.OnAuthFailure("invalid_token")
	store.OnTargetRejected("target_not_allowed")

	snapshot := store.Snapshot()
	if snapshot.ActiveConnections != 1 || snapshot.TotalConnections != 1 {
		t.Fatalf("connection counters = %+v", snapshot)
	}
	if snapshot.PacketsToTarget != 1 || snapshot.BytesToTarget != 64 {
		t.Fatalf("to-target counters = %+v", snapshot)
	}
	if snapshot.PacketsFromTarget != 1 || snapshot.BytesFromTarget != 128 {
		t.Fatalf("from-target counters = %+v", snapshot)
	}
	if snapshot.DroppedFrames != 1 {
		t.Fatalf("droppedFrames = %d", snapshot.DroppedFrames)
	}
	if snapshot.DropsByReason["frame_too_large"] != 1 || snapshot.DropsByReason["auth_invalid_token"] != 1 {
		t.Fatalf("dropsByReason = %v", snapshot.DropsByReason)
	}
	if snapshot.AuthFailures != 1 || snapshot.TargetRejections != 1 {
		t.Fatalf("rejection counters = %+v", snapshot)
	}
	if len(snapshot.Targets) != 1 {
		t.Fatalf("targets = %+v", snapshot.Targets)
	}
	entry := snapshot.Targets[0]
	if entry.Target != "127.0.0.1:8303" || entry.Connections != 1 || entry.ActiveConnections != 1 {
		t.Fatalf("target entry = %+v", entry)
	}
	if entry.LastClientIP != "203.0.113.5" {
		t.Fatalf("lastClientIp = %q", entry.LastClientIP)
	}

	store.OnConnectionClose("127.0.0.1:8303", "client_closed")
	closed := store.Snapshot()
	if closed.ActiveConnections != 0 || closed.ClosedConnections != 1 {
		t.Fatalf("post-close counters = %+v", closed)
	}
	if closed.CloseReasons["client_closed"] != 1 {
		t.Fatalf("closeReasons = %v", closed.CloseReasons)
	}
	if closed.Targets[0].ActiveConnections != 0 {
		t.Fatalf("target active = %d", closed.Targets[0].ActiveConnections)
	}
}

func TestMapMergesExtra(t *testing.T) {
	store := New()
	merged := store.Map(map[string]any{"service": "ddnet-ws-relay", "version": "1.0.0"})
	if merged["service"] != "ddnet-ws-relay" || merged["version"] != "1.0.0" {
		t.Fatalf("extra fields missing: %v", merged)
	}
	for _, key := range []string{"startedAt", "uptimeSec", "activeConnections", "totalConnections", "targets", "dropsByReason"} {
		if _, ok := merged[key]; !ok {
			t.Fatalf("snapshot key %q missing: %v", key, merged)
		}
	}
}

func TestTargetsSortedAndCapped(t *testing.T) {
	store := New()
	for i := 0; i < 60; i++ {
		target := "10.0.0." + itoa(i) + ":8303"
		store.OnConnectionOpen(target, "127.0.0.1")
		for j := 0; j <= i; j++ {
			store.OnPacketToTarget(target, 1)
		}
	}
	snapshot := store.Snapshot()
	if len(snapshot.Targets) != 50 {
		t.Fatalf("target list length = %d; want 50", len(snapshot.Targets))
	}
	if snapshot.Targets[0].PacketsToTarget != 60 {
		t.Fatalf("targets not sorted by traffic: %+v", snapshot.Targets[0])
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 4)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
