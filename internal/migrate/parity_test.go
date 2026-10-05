package migrate

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// parityFixture is intentionally decoded into the same Object shape accepted
// by the public Go API.  This keeps the test from depending on private Go
// converter structs while the JSON files remain usable by other harnesses.
type parityFixture struct {
	Name          string          `json:"name"`
	Direction     string          `json:"direction"`
	Input         parityInput     `json:"input"`
	Expected      json.RawMessage `json:"expected"`
	ExpectedError string          `json:"expectedError"`
}

type parityInput struct {
	Records []Object `json:"records"`
	Options Object   `json:"options"`
	Header  Object   `json:"header"`
	Events  []Object `json:"events"`
}

var uuidPattern = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`)

// Embed comparison data so cross-compiled tests do not depend on build-host paths.
//
//go:embed testdata/*.json
var goldenCases embed.FS

func TestParityAgainstTypeScriptGoldenCases(t *testing.T) {
	files, err := fs.Glob(goldenCases, "testdata/*.json")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	if len(files) < 20 {
		t.Fatalf("expected a broad synthetic parity corpus, found %d fixtures", len(files))
	}

	for _, file := range files {
		file := file
		t.Run(filepath.Base(file), func(t *testing.T) {
			fixture := readParityFixture(t, file)
			var got Conversion
			switch fixture.Direction {
			case "codex-to-dsh":
				got, err = CodexToDsh(fixture.Input.Records, fixture.Input.Options)
			case "dsh-to-codex":
				got, err = DshToCodex(fixture.Input.Header, fixture.Input.Events, fixture.Input.Options)
			default:
				t.Fatalf("unknown parity direction %q", fixture.Direction)
			}

			if fixture.ExpectedError != "" {
				if err == nil {
					t.Fatalf("expected refusal %q, conversion succeeded: %s", fixture.ExpectedError, conversionJSON(t, got))
				}
				if err.Error() != fixture.ExpectedError {
					t.Fatalf("refusal mismatch\nwant: %s\n got: %s", fixture.ExpectedError, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected conversion error: %v", err)
			}

			want := decodeJSON(t, fixture.Expected)
			gotValue := decodeJSON(t, mustJSON(t, got))
			want = normalizeParityJSON(want)
			gotValue = normalizeParityJSON(gotValue)
			if !reflect.DeepEqual(gotValue, want) {
				t.Fatalf("semantic parity mismatch\nwant:\n%s\n got:\n%s", prettyJSON(t, want), prettyJSON(t, gotValue))
			}
			validateRelationships(t, fixture.Direction, got)
		})
	}
}

func readParityFixture(t *testing.T, file string) parityFixture {
	t.Helper()
	b, err := goldenCases.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var fixture parityFixture
	if err := json.Unmarshal(b, &fixture); err != nil {
		t.Fatalf("decode %s: %v", file, err)
	}
	var source struct {
		Input struct {
			Records []json.RawMessage `json:"records"`
		} `json:"input"`
	}
	if err := json.Unmarshal(b, &source); err != nil {
		t.Fatal(err)
	}
	for i, record := range fixture.Input.Records {
		preserveCustomInputs(record, source.Input.Records[i])
	}
	if fixture.Name == "" || fixture.Direction == "" {
		t.Fatalf("fixture %s has no name or direction", file)
	}
	return fixture
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal conversion: %v", err)
	}
	return b
}

func conversionJSON(t *testing.T, value Conversion) string {
	t.Helper()
	return string(mustJSON(t, value))
}

func decodeJSON(t *testing.T, b []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	return value
}

// normalizeParityJSON gives independent runs the same names for generated
// UUIDs while retaining equality relationships (the same UUID is always given
// the same marker within one conversion).  Loss order is a report detail and
// is compared as a set so map traversal cannot make a valid port flaky.
func normalizeParityJSON(value any) any {
	ids := make(map[string]string)
	nextID := 1
	var walk func(any, string) any
	walk = func(current any, key string) any {
		switch x := current.(type) {
		case map[string]any:
			out := make(map[string]any, len(x))
			keys := make([]string, 0, len(x))
			for childKey := range x {
				keys = append(keys, childKey)
			}
			sort.Strings(keys)
			for _, childKey := range keys {
				child := x[childKey]
				out[childKey] = walk(child, childKey)
			}
			return out
		case []any:
			out := make([]any, len(x))
			for i, child := range x {
				out[i] = walk(child, key)
			}
			if key == "losses" {
				sort.Slice(out, func(i, j int) bool { return fmt.Sprint(out[i]) < fmt.Sprint(out[j]) })
			}
			return out
		case string:
			return uuidPattern.ReplaceAllStringFunc(x, func(id string) string {
				if marker, ok := ids[id]; ok {
					return marker
				}
				marker := fmt.Sprintf("<uuid-%d>", nextID)
				nextID++
				ids[id] = marker
				return marker
			})
		default:
			return current
		}
	}
	return walk(value, "")
}

func prettyJSON(t *testing.T, value any) string {
	t.Helper()
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("pretty JSON: %v", err)
	}
	return string(b)
}

// validateRelationships checks invariants that a field-for-field comparison
// can miss when both sides make the same structural mistake.  These assertions
// also document the lifecycle relationships the migration is required to keep.
func validateRelationships(t *testing.T, direction string, conversion Conversion) {
	t.Helper()
	if direction == "codex-to-dsh" {
		validateDshRelationships(t, conversion.Events)
	} else {
		validateCodexRelationships(t, conversion.Drafts)
	}
}

func validateDshRelationships(t *testing.T, events []Object) {
	t.Helper()
	callIDs := make(map[string]bool)
	advertised := make(map[string]bool)
	for index, event := range events {
		if int(num(event["seq"])) != index {
			t.Fatalf("DSH event sequence is not dense at index %d: %#v", index, event["seq"])
		}
		typeName := str(event["type"])
		data := obj(event["data"])
		switch typeName {
		case "assistant/message":
			message := obj(data["message"])
			for _, block := range arr(message["content"]) {
				block := obj(block)
				if str(block["type"]) == "tool-call" {
					advertised[str(block["id"])] = true
				}
			}
		case "tool/call":
			callIDs[str(data["callId"])] = true
		case "tool/result":
			message := obj(data["message"])
			callID := str(message["toolCallId"])
			if callID == "" || !callIDs[callID] {
				t.Fatalf("DSH tool result refers to missing call %q", callID)
			}
		}
	}
	for id := range callIDs {
		if !advertised[id] {
			t.Fatalf("DSH tool call %q has no assistant advertisement", id)
		}
	}
}

func validateCodexRelationships(t *testing.T, drafts []Object) {
	t.Helper()
	calls := make(map[string]bool)
	turnIDs := make(map[string]bool)
	for _, draft := range drafts {
		if str(draft["type"]) != "event_msg" {
			continue
		}
		payload := obj(draft["payload"])
		if str(payload["type"]) == "task_started" {
			turnIDs[str(payload["turn_id"])] = true
		}
	}
	for _, draft := range drafts {
		if str(draft["type"]) != "response_item" {
			continue
		}
		payload := obj(draft["payload"])
		switch str(payload["type"]) {
		case "function_call":
			calls[str(payload["call_id"])] = true
		case "function_call_output":
			callID := str(payload["call_id"])
			if callID == "" || !calls[callID] {
				t.Fatalf("Codex function output refers to missing call %q", callID)
			}
		}
	}
	for _, draft := range drafts {
		if str(draft["type"]) != "turn_context" {
			continue
		}
		turnID := str(obj(draft["payload"])["turn_id"])
		if turnID == "" || !turnIDs[turnID] {
			t.Fatalf("Codex turn context refers to missing task_started turn %q", turnID)
		}
	}
}

// Keep compile-time coverage of the JSON surface promised by Conversion.  The
// actual parity comparison above marshals this struct, so a renamed tag fails
// both here and with a useful fixture mismatch.
func TestConversionJSONSurface(t *testing.T) {
	value := Conversion{
		Header:  Object{"header": true},
		Events:  []Object{{"event": true}},
		Drafts:  []Object{{"draft": true}},
		Tallies: map[string]*Tally{"synthetic": {Mapped: 1}},
		Losses:  []string{"synthetic loss"},
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"header"`, `"events"`, `"drafts"`, `"tallies"`, `"losses"`} {
		if !strings.Contains(string(encoded), key) {
			t.Fatalf("Conversion JSON omitted %s: %s", key, encoded)
		}
	}
}
