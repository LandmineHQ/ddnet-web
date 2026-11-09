// Package logx implements the relay's structured JSON line logger. One JSON
// object per line, written to a single stream; field order is stable for
// readability (ts, level, event, then base/child fields, then call fields).
package logx

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"
	"time"
)

// Level is a log severity. Values match the legacy Node relay.
type Level int

const (
	Debug  Level = 10
	Info   Level = 20
	Warn   Level = 30
	Error  Level = 40
	Silent Level = 100
)

// ParseLevel converts a config/env level name into a Level.
func ParseLevel(value string) (Level, error) {
	switch value {
	case "debug":
		return Debug, nil
	case "info":
		return Info, nil
	case "warn":
		return Warn, nil
	case "error":
		return Error, nil
	case "silent":
		return Silent, nil
	default:
		return Info, fmt.Errorf("invalid log level %q", value)
	}
}

// Field is one structured log field.
type Field struct {
	Key   string
	Value any
}

// F builds a field.
func F(key string, value any) Field {
	return Field{Key: key, Value: value}
}

// Logger writes structured JSON lines. It is safe for concurrent use.
type Logger struct {
	level Level
	out   io.Writer
	now   func() time.Time
	base  []Field
	mu    *sync.Mutex
}

// New returns a logger writing to out (os.Stdout when out is nil).
func New(level Level, out io.Writer) *Logger {
	if out == nil {
		out = os.Stdout
	}
	return &Logger{level: level, out: out, now: time.Now, mu: &sync.Mutex{}}
}

// With returns a child logger with extra fields prepended to every line.
func (l *Logger) With(fields ...Field) *Logger {
	base := make([]Field, 0, len(l.base)+len(fields))
	base = append(base, l.base...)
	base = append(base, fields...)
	return &Logger{level: l.level, out: l.out, now: l.now, base: base, mu: l.mu}
}

// Enabled reports whether level would be emitted.
func (l *Logger) Enabled(level Level) bool {
	return level >= l.level && l.level != Silent
}

func (l *Logger) Debug(event string, fields ...Field) { l.write(Debug, event, fields) }
func (l *Logger) Info(event string, fields ...Field)  { l.write(Info, event, fields) }
func (l *Logger) Warn(event string, fields ...Field)  { l.write(Warn, event, fields) }
func (l *Logger) Error(event string, fields ...Field) { l.write(Error, event, fields) }

func (l *Logger) write(level Level, event string, fields []Field) {
	if !l.Enabled(level) {
		return
	}
	line := l.encode(level, event, fields)
	l.mu.Lock()
	_, _ = l.out.Write(line)
	l.mu.Unlock()
}

// encode builds one JSON object. Duplicate keys keep the last value but the
// position of the first occurrence (matches JS object assignment semantics).
func (l *Logger) encode(level Level, event string, fields []Field) []byte {
	type entry struct {
		key   string
		value any
	}
	entries := make([]entry, 0, 3+len(l.base)+len(fields))
	index := make(map[string]int, 3+len(l.base)+len(fields))
	add := func(key string, value any) {
		if value == nil {
			return
		}
		if i, ok := index[key]; ok {
			entries[i].value = value
			return
		}
		index[key] = len(entries)
		entries = append(entries, entry{key: key, value: value})
	}
	add("ts", l.now().UTC().Format("2006-01-02T15:04:05.000Z"))
	add("level", levelName(level))
	add("event", event)
	for _, field := range l.base {
		add(field.Key, field.Value)
	}
	for _, field := range fields {
		add(field.Key, field.Value)
	}

	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, item := range entries {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(marshalString(item.key))
		buf.WriteByte(':')
		buf.Write(marshalValue(item.value))
	}
	buf.WriteString("}\n")
	return buf.Bytes()
}

func levelName(level Level) string {
	switch level {
	case Debug:
		return "debug"
	case Info:
		return "info"
	case Warn:
		return "warn"
	case Error:
		return "error"
	default:
		return "info"
	}
}

func marshalString(value string) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		return []byte(`""`)
	}
	return data
}

func marshalValue(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		return marshalString(fmt.Sprintf("%v", value))
	}
	return data
}

// SortedKeys returns the sorted keys of a string-keyed map, used for stable
// JSON output in tests and logs.
func SortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
