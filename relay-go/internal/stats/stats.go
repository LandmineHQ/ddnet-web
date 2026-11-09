// Package stats aggregates relay counters exposed by GET /api/stats. It is a
// port of the legacy Node relay's stats.mjs.
package stats

import (
	"encoding/json"
	"math"
	"sort"
	"sync"
	"time"
)

// Target holds per-target counters.
type Target struct {
	Target            string `json:"target"`
	Connections       int64  `json:"connections"`
	ActiveConnections int64  `json:"activeConnections"`
	PacketsToTarget   int64  `json:"packetsToTarget"`
	PacketsFromTarget int64  `json:"packetsFromTarget"`
	BytesToTarget     int64  `json:"bytesToTarget"`
	BytesFromTarget   int64  `json:"bytesFromTarget"`
	LastClientIP      string `json:"lastClientIp,omitempty"`
}

// Snapshot is the JSON shape of GET /api/stats (before extra fields).
type Snapshot struct {
	StartedAt         string           `json:"startedAt"`
	UptimeSec         int64            `json:"uptimeSec"`
	ActiveConnections int64            `json:"activeConnections"`
	TotalConnections  int64            `json:"totalConnections"`
	ClosedConnections int64            `json:"closedConnections"`
	BytesToTarget     int64            `json:"bytesToTarget"`
	BytesFromTarget   int64            `json:"bytesFromTarget"`
	PacketsToTarget   int64            `json:"packetsToTarget"`
	PacketsFromTarget int64            `json:"packetsFromTarget"`
	DroppedFrames     int64            `json:"droppedFrames"`
	DropsByReason     map[string]int64 `json:"dropsByReason"`
	CloseReasons      map[string]int64 `json:"closeReasons"`
	AuthFailures      int64            `json:"authFailures"`
	TargetRejections  int64            `json:"targetRejections"`
	Targets           []Target         `json:"targets"`
}

// Stats is the aggregate in-memory statistics store. It is safe for concurrent
// use.
type Stats struct {
	mu      sync.Mutex
	now     func() time.Time
	started time.Time

	activeConnections int64
	totalConnections  int64
	closedConnections int64
	bytesToTarget     int64
	bytesFromTarget   int64
	packetsToTarget   int64
	packetsFromTarget int64
	droppedFrames     int64
	dropsByReason     map[string]int64
	closeReasons      map[string]int64
	authFailures      int64
	targetRejections  int64
	targets           map[string]*Target
}

// New returns an empty stats store. now is injectable for tests.
func New() *Stats {
	return &Stats{
		now:           time.Now,
		started:       time.Now(),
		dropsByReason: make(map[string]int64),
		closeReasons:  make(map[string]int64),
		targets:       make(map[string]*Target),
	}
}

// SetClock replaces the clock (tests only).
func (s *Stats) SetClock(now func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = now
	s.started = now()
}

// StartedAt returns the process start time.
func (s *Stats) StartedAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// UptimeSec returns the rounded uptime in seconds.
func (s *Stats) UptimeSec() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.uptimeLocked()
}

func (s *Stats) uptimeLocked() int64 {
	return int64(math.Round(s.now().Sub(s.started).Seconds()))
}

func (s *Stats) targetLocked(name string) *Target {
	entry, ok := s.targets[name]
	if !ok {
		entry = &Target{Target: name}
		s.targets[name] = entry
	}
	return entry
}

// OnConnectionOpen records a new session.
func (s *Stats) OnConnectionOpen(target, clientIP string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activeConnections++
	s.totalConnections++
	entry := s.targetLocked(target)
	entry.Connections++
	entry.ActiveConnections++
	if clientIP != "" {
		entry.LastClientIP = clientIP
	}
}

// OnConnectionClose records a closed session.
func (s *Stats) OnConnectionClose(target, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeConnections > 0 {
		s.activeConnections--
	}
	s.closedConnections++
	s.closeReasons[reason]++
	if target != "" {
		entry := s.targetLocked(target)
		if entry.ActiveConnections > 0 {
			entry.ActiveConnections--
		}
	}
}

// OnPacketToTarget records one packet forwarded to the target.
func (s *Stats) OnPacketToTarget(target string, bytes int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.packetsToTarget++
	s.bytesToTarget += bytes
	entry := s.targetLocked(target)
	entry.PacketsToTarget++
	entry.BytesToTarget += bytes
}

// OnPacketFromTarget records one datagram received from the target.
func (s *Stats) OnPacketFromTarget(target string, bytes int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.packetsFromTarget++
	s.bytesFromTarget += bytes
	entry := s.targetLocked(target)
	entry.PacketsFromTarget++
	entry.BytesFromTarget += bytes
}

// OnDrop records a dropped frame or packet.
func (s *Stats) OnDrop(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.droppedFrames++
	s.dropsByReason[reason]++
}

// OnAuthFailure records an authentication rejection.
func (s *Stats) OnAuthFailure(reason string) {
	if reason == "" {
		reason = "unauthorized"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authFailures++
	s.dropsByReason["auth_"+reason]++
}

// OnTargetRejected records a rejected target/connection.
func (s *Stats) OnTargetRejected(reason string) {
	if reason == "" {
		reason = "blocked"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.targetRejections++
	s.dropsByReason["target_"+reason]++
}

// ActiveConnections returns the number of open sessions.
func (s *Stats) ActiveConnections() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activeConnections
}

// ClosedConnections returns the number of closed sessions.
func (s *Stats) ClosedConnections() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closedConnections
}

// Snapshot returns a consistent copy of all counters.
func (s *Stats) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	targetList := make([]Target, 0, len(s.targets))
	for _, entry := range s.targets {
		targetList = append(targetList, *entry)
	}
	sort.Slice(targetList, func(i, j int) bool {
		left := targetList[i].PacketsFromTarget + targetList[i].PacketsToTarget
		right := targetList[j].PacketsFromTarget + targetList[j].PacketsToTarget
		if left == right {
			return targetList[i].Target < targetList[j].Target
		}
		return left > right
	})
	if len(targetList) > 50 {
		targetList = targetList[:50]
	}
	drops := make(map[string]int64, len(s.dropsByReason))
	for key, value := range s.dropsByReason {
		drops[key] = value
	}
	reasons := make(map[string]int64, len(s.closeReasons))
	for key, value := range s.closeReasons {
		reasons[key] = value
	}
	return Snapshot{
		StartedAt:         s.started.UTC().Format("2006-01-02T15:04:05.000Z"),
		UptimeSec:         s.uptimeLocked(),
		ActiveConnections: s.activeConnections,
		TotalConnections:  s.totalConnections,
		ClosedConnections: s.closedConnections,
		BytesToTarget:     s.bytesToTarget,
		BytesFromTarget:   s.bytesFromTarget,
		PacketsToTarget:   s.packetsToTarget,
		PacketsFromTarget: s.packetsFromTarget,
		DroppedFrames:     s.droppedFrames,
		DropsByReason:     drops,
		CloseReasons:      reasons,
		AuthFailures:      s.authFailures,
		TargetRejections:  s.targetRejections,
		Targets:           targetList,
	}
}

// Map returns the snapshot as a generic map merged with extra top-level fields.
func (s *Stats) Map(extra map[string]any) map[string]any {
	snapshot := s.Snapshot()
	data, err := json.Marshal(snapshot)
	if err != nil {
		return map[string]any{"error": "internal_error"}
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return map[string]any{"error": "internal_error"}
	}
	for key, value := range extra {
		out[key] = value
	}
	return out
}
