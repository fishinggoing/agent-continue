// Package migrate implements native session conversion without invoking a model.
package migrate

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Object = map[string]any
type Tally struct {
	Mapped  int    `json:"mapped"`
	Dropped int    `json:"dropped"`
	Reason  string `json:"reason,omitempty"`
}
type Conversion struct {
	Header  Object            `json:"header,omitempty"`
	Events  []Object          `json:"events,omitempty"`
	Drafts  []Object          `json:"drafts,omitempty"`
	Tallies map[string]*Tally `json:"tallies"`
	Losses  []string          `json:"losses"`
}

const Unknown = "TOOL_OUTCOME_UNKNOWN"
const UnknownText = "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly."

func obj(v any) Object {
	if x, ok := v.(map[string]any); ok && x != nil {
		return x
	}
	return Object{}
}
func arr(v any) []any {
	if x, ok := v.([]any); ok {
		return x
	}
	if x, ok := v.([]Object); ok {
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = v
		}
		return a
	}
	return nil
}
func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	}
	return 0
}
func isNum(v any) bool {
	switch v.(type) {
	case float64, int, int64, json.Number:
		return true
	}
	return false
}
func safeInt(v any) bool {
	return isNum(v) && math.Abs(num(v)) <= 9007199254740991 && math.Trunc(num(v)) == num(v)
}
func present(o Object, key string) bool { v, ok := o[key]; return ok && v != nil }
func coalesce(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
func jsString(v any) string {
	if v == nil {
		return "undefined"
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
func clone(o Object) Object {
	b, _ := json.Marshal(o)
	var c Object
	_ = json.Unmarshal(b, &c)
	return c
}
func jsonText(v any) string { b, _ := json.Marshal(v); return string(b) }
func uuid() string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func NewID() string { return uuid() }
func IsAbsolute(p string) bool {
	return strings.HasPrefix(p, "/") || filepath.IsAbs(p) || regexp.MustCompile(`^[a-zA-Z]:[\\/]`).MatchString(p) || strings.HasPrefix(p, `\\`)
}
func isAbsolute(p string) bool { return IsAbsolute(p) }
func iso(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}
func parseTime(s string) float64 {
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return 0
	}
	return float64(t.UnixMilli())
}

func PendingOutcomes(v any) ([]Object, error) {
	o := obj(v)
	if o["recovery"] != Unknown {
		if o["kind"] == "agent-continue-unknown-outcomes" {
			return nil, fmt.Errorf("Refusing migration: unknown-outcome notice lacks a machine-readable recovery marker; reimport its original source")
		}
		return nil, nil
	}
	operations := arr(coalesce(o["pendingOperations"], o["pending_operations"]))
	if len(operations) == 0 {
		return nil, fmt.Errorf("Refusing migration: unknown-outcome context is missing machine-readable pending operations")
	}
	result := []Object{}
	for _, v := range operations {
		o := obj(v)
		if str(o["callId"]) == "" || str(o["name"]) == "" || o["state"] != "unknown" {
			return nil, fmt.Errorf("Refusing migration: malformed pending operation identity or state")
		}
		result = append(result, Object{"callId": o["callId"], "name": o["name"], "state": "unknown"})
	}
	return result, nil
}
