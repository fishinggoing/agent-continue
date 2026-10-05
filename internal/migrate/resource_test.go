package migrate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestParseUploadRejectsOversizedBlankLineInput(t *testing.T) {
	data := bytes.Repeat([]byte{'\n'}, MaxUploadBytes+1)

	if _, err := ParseUpload("codex", "source.jsonl", data); err == nil || !strings.Contains(err.Error(), "16 MiB") {
		t.Fatalf("oversized blank-line upload error = %v, want the 16 MiB refusal", err)
	}
}

func TestParseUploadRejectsCompressedBlankLineExpansion(t *testing.T) {
	frame := bytes.Repeat([]byte{'\n'}, 1<<20)
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatalf("zstd encoder: %v", err)
	}
	compressed := make([]byte, 0)
	for decoded := 0; decoded < MaxUploadDecodedBytes+1; decoded += len(frame) {
		compressed = append(compressed, encoder.EncodeAll(frame, nil)...)
	}
	encoder.Close()
	if len(compressed) >= MaxUploadBytes {
		t.Fatalf("blank-line probe did not stay below upload limit: %d bytes", len(compressed))
	}

	if _, err := ParseUpload("dsh", "session.v4.jsonl.zstd", compressed); err == nil || !strings.Contains(err.Error(), "decoded source exceeds 32 MiB") {
		t.Fatalf("compressed blank-line expansion error = %v, want the 32 MiB decoded refusal", err)
	}
}

func TestC2DJSONStringifyWideObjectPreservesInsertionOrder(t *testing.T) {
	const keyCount = 20000
	var raw strings.Builder
	raw.Grow(keyCount * 18)
	raw.WriteByte('{')
	for index := keyCount - 1; index >= 0; index-- {
		if index < keyCount-1 {
			raw.WriteByte(',')
		}
		fmt.Fprintf(&raw, `"key-%05d":%d`, index, index)
	}
	raw.WriteByte('}')
	want := raw.String()

	source, err := ParseSource("codex", "source.jsonl", codexCustomInputData(t, want))
	if err != nil {
		t.Fatalf("parse wide custom input: %v", err)
	}
	got := c2dJSONStringify(obj(source.Records[1]["payload"])["input"])
	if got != want {
		t.Fatalf("wide JSON order/normalization changed (got %d bytes, want %d); got prefix %q, want prefix %q", len(got), len(want), got[:min(len(got), 96)], want[:min(len(want), 96)])
	}
}

func TestC2DJSONStringifyNestedLargeLeafAvoidsSubtreeCopies(t *testing.T) {
	const depth = 128
	const leafBytes = 128 << 10
	raw := json.RawMessage(strings.Repeat("[", depth) + `"` + strings.Repeat("x", leafBytes) + `"` + strings.Repeat("]", depth))
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	got := c2dJSONStringify(raw)
	runtime.ReadMemStats(&after)
	if got != string(raw) {
		t.Fatal("nested custom input changed during stringification")
	}
	// The former per-ancestor concatenation copied this 128 KiB leaf at
	// least 128 times (>16 MiB). Keep generous headroom for token decoding
	// and buffer growth while detecting that quadratic allocation pattern.
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 8<<20 {
		t.Fatalf("nested custom input allocated %d bytes, want at most 8 MiB", allocated)
	} else {
		t.Logf("nested custom input stringification allocated %d bytes", allocated)
	}
}

func TestParseUploadNestedCustomCallAvoidsSubtreeCopies(t *testing.T) {
	const depth = 128
	const leafBytes = 128 << 10
	input := `"` + strings.Repeat("x", leafBytes) + `"`
	data := codexCustomInputData(t, "null")
	data = data[:bytes.IndexByte(data, '\n')+1]
	payload := `{"replacement_history":` + strings.Repeat("[", depth) + `{"type":"custom_tool_call","input":` + input + `}` + strings.Repeat("]", depth) + `}`
	data = append(data, []byte(`{"timestamp":"2026-10-04T00:00:00.001Z","type":"compacted","payload":`+payload+"}\n")...)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	source, err := ParseUpload("codex", "source.jsonl", data)
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatalf("valid bounded nested upload was rejected: %v", err)
	}
	call := obj(source.Records[1]["payload"])["replacement_history"]
	for index := 0; index < depth; index++ {
		call = call.([]any)[0]
	}
	if got, ok := obj(call)["input"].(json.RawMessage); !ok || string(got) != input {
		t.Fatal("source reader did not retain nested custom input")
	}
	// Re-decoding every nested subtree previously copied the leaf at every
	// array level (>16 MiB); token traversal should stay well below that.
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 8<<20 {
		t.Fatalf("nested source reader allocated %d bytes, want at most 8 MiB", allocated)
	} else {
		t.Logf("nested source reader allocated %d bytes", allocated)
	}
}

func TestParseUploadRejectsDeepCustomJSONInput(t *testing.T) {
	if _, err := ParseUpload("codex", "source.jsonl", codexCustomInputData(t, `{"ok":[0]}`)); err != nil {
		t.Fatalf("normal custom JSON input was rejected: %v", err)
	}

	const depth = 2000
	var input strings.Builder
	input.Grow(depth*2 + 1)
	input.WriteString(strings.Repeat("[", depth))
	input.WriteByte('0')
	input.WriteString(strings.Repeat("]", depth))

	data := codexCustomInputData(t, input.String())
	if _, err := ParseUpload("codex", "source.jsonl", data); err == nil || !strings.Contains(err.Error(), "nesting depth") {
		t.Fatalf("deep custom JSON upload error = %v, want the nesting-depth refusal", err)
	}
	source, err := ParseSource("codex", "source.jsonl", data)
	if err != nil {
		t.Fatalf("CLI source reader rejected valid deep custom input: %v", err)
	}
	got, ok := obj(source.Records[1]["payload"])["input"].(json.RawMessage)
	if !ok || string(got) != input.String() {
		t.Fatal("CLI source reader did not retain the valid deep custom input")
	}
}

func TestParseUploadRejectsCustomJSONTokenBudget(t *testing.T) {
	const keyCount = 600000
	var input strings.Builder
	input.Grow(keyCount * 12)
	input.WriteByte('{')
	for index := 0; index < keyCount; index++ {
		if index > 0 {
			input.WriteByte(',')
		}
		fmt.Fprintf(&input, `"k%d":0`, index)
	}
	input.WriteByte('}')
	data := codexCustomInputData(t, input.String())
	if len(data) >= MaxUploadBytes {
		t.Fatalf("token-budget probe exceeds upload limit: %d bytes", len(data))
	}

	if _, err := ParseUpload("codex", "source.jsonl", data); err == nil || !strings.Contains(err.Error(), "JSON token limit") {
		t.Fatalf("wide custom JSON upload error = %v, want the JSON token-budget refusal", err)
	}
}

func TestParseUploadSharesTokenBudgetAcrossRecords(t *testing.T) {
	const itemCount = 260000
	input := "[" + strings.Repeat("0,", itemCount-1) + "0]"
	data := codexCustomInputData(t, input)
	if _, err := ParseUpload("codex", "source.jsonl", data); err != nil {
		t.Fatalf("single record under the token budget was rejected: %v", err)
	}
	// Each custom call is under the budget; four together exceed the session budget.
	callLine := data[bytes.IndexByte(data, '\n')+1:]
	for index := 0; index < 3; index++ {
		data = append(data, callLine...)
	}
	if _, err := ParseUpload("codex", "source.jsonl", data); err == nil || !strings.Contains(err.Error(), "JSON token limit") {
		t.Fatalf("multi-record JSON upload error = %v, want the shared token-budget refusal", err)
	}
}

func TestParseSourcePreservesNestedCustomInputOrder(t *testing.T) {
	const want = `{"z":1,"a":2}`
	for _, payload := range []string{
		`{"type":"custom_tool_call","input": {"obsolete":0},"input": ` + want + `}`,
		`{"replacement_history":[{"input": ` + want + `, "type":"custom_tool_call"}]}`,
	} {
		t.Run(payload, func(t *testing.T) {
			data := codexCustomInputData(t, "null")
			data = data[:bytes.IndexByte(data, '\n')+1]
			data = append(data, []byte(`{"timestamp":"2026-10-04T00:00:00.001Z","type":"compacted","payload":`+payload+"}\n")...)
			source, err := ParseSource("codex", "source.jsonl", data)
			if err != nil {
				t.Fatal(err)
			}
			call := obj(source.Records[1]["payload"])
			if nested, ok := call["replacement_history"].([]any); ok {
				call = obj(nested[0])
			}
			if got := c2dJSONStringify(call["input"]); got != want {
				t.Fatalf("nested custom arguments = %s, want %s", got, want)
			}
		})
	}
}

func codexCustomInputData(t *testing.T, input string) []byte {
	t.Helper()
	records := []Object{
		{"timestamp": "2026-10-04T00:00:00.000Z", "ordinal": 0, "type": "session_meta", "payload": Object{"id": "44444444-4444-4444-8444-444444444444", "cwd": "/web/project", "model_provider": "synthetic-provider"}},
		{"timestamp": "2026-10-04T00:00:00.001Z", "ordinal": 1, "type": "response_item", "payload": Object{"type": "custom_tool_call", "call_id": "budget-probe", "name": "inspect", "input": json.RawMessage(input)}},
	}
	var data bytes.Buffer
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatalf("marshal custom input record: %v", err)
		}
		data.Write(encoded)
		data.WriteByte('\n')
	}
	return data.Bytes()
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
