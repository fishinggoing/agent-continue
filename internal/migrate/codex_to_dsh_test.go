package migrate

import (
	"encoding/json"
	"strings"
	"testing"
)

func c2dRecord(recordType, timestamp string, payload Object) Object {
	return Object{"type": recordType, "timestamp": timestamp, "payload": payload}
}

func c2dSession(records ...Object) []Object {
	return append([]Object{c2dRecord("session_meta", "2026-10-01T00:00:00.000Z", Object{"cwd": `F:\proj`, "model_provider": "provider"})}, records...)
}

func c2dKinds(events []Object) []string {
	result := make([]string, 0, len(events))
	for _, event := range events {
		result = append(result, str(event["type"]))
	}
	return result
}

func TestCodexToDshBasicMapping(t *testing.T) {
	records := c2dSession(
		c2dRecord("event_msg", "2026-10-01T00:00:01.000Z", Object{"type": "task_started", "turn_id": "t1"}),
		c2dRecord("response_item", "2026-10-01T00:00:02.000Z", Object{"type": "message", "id": "u1", "role": "user", "content": []any{Object{"type": "input_text", "text": "q"}}}),
		c2dRecord("response_item", "2026-10-01T00:00:03.000Z", Object{"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{}"}),
		c2dRecord("response_item", "2026-10-01T00:00:04.000Z", Object{"type": "function_call_output", "call_id": "c1", "output": "ok", "isError": false}),
		c2dRecord("response_item", "2026-10-01T00:00:05.000Z", Object{"type": "message", "id": "a1", "role": "assistant", "content": []any{Object{"type": "output_text", "text": "a"}}}),
		c2dRecord("event_msg", "2026-10-01T00:00:06.000Z", Object{"type": "task_complete", "turn_id": "t1"}),
	)
	conversion, err := CodexToDsh(records, Object{"sessionId": "target", "cwd": `F:\proj`})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"turn/start", "step/start", "system/message", "user/message", "assistant/message", "tool/call", "tool/result", "assistant/message", "step/end", "turn/end"}
	got := c2dKinds(conversion.Events)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("event kinds = %v, want %v", got, want)
	}
	if conversion.Events[4]["surfaceOp"] != "append" {
		t.Fatalf("tool advertisement missing surface op: %#v", conversion.Events[4])
	}
	if conversion.Events[5]["surfaceOp"] != nil {
		t.Fatalf("tool call unexpectedly has surface op: %#v", conversion.Events[5])
	}
}

func TestCodexToDshLeavesUnresolvedTailOpen(t *testing.T) {
	records := c2dSession(
		c2dRecord("event_msg", "t", Object{"type": "task_started", "turn_id": "t1"}),
		c2dRecord("response_item", "t", Object{"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{}"}),
	)
	conversion, err := CodexToDsh(records, Object{"sessionId": "target", "cwd": `F:\proj`})
	if err != nil {
		t.Fatal(err)
	}
	got := c2dKinds(conversion.Events)
	for _, kind := range got {
		if kind == "step/end" || kind == "turn/end" {
			t.Fatalf("unresolved tail was closed: %v", got)
		}
	}
}

func TestCodexToDshSynthesizesUnknownBeforeLaterTurn(t *testing.T) {
	records := c2dSession(
		c2dRecord("event_msg", "t", Object{"type": "task_started", "turn_id": "t1"}),
		c2dRecord("response_item", "t", Object{"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{}"}),
		c2dRecord("event_msg", "t", Object{"type": "task_complete", "turn_id": "t1"}),
		c2dRecord("event_msg", "t", Object{"type": "task_started", "turn_id": "t2"}),
		c2dRecord("response_item", "t", Object{"type": "message", "role": "user", "content": []any{Object{"type": "input_text", "text": "later"}}}),
	)
	conversion, err := CodexToDsh(records, Object{"sessionId": "target", "cwd": `F:\proj`})
	if err != nil {
		t.Fatal(err)
	}
	if conversion.Tallies["tool/result.synthesized-unknown"].Mapped != 1 {
		t.Fatalf("unknown synthesis tally = %#v", conversion.Tallies["tool/result.synthesized-unknown"])
	}
	if strings.Join(c2dKinds(conversion.Events), ",") != "turn/start,step/start,system/message,assistant/message,tool/call,tool/result,step/end,turn/end,turn/start,step/start,user/message,step/end,turn/end" {
		t.Fatalf("unexpected synthesized event sequence: %v", c2dKinds(conversion.Events))
	}
}

func TestCodexToDshUsageAndRemapping(t *testing.T) {
	records := c2dSession(
		c2dRecord("event_msg", "2026-10-01T00:00:01.000Z", Object{"type": "task_started", "turn_id": "t1"}),
		c2dRecord("token_usage_record", "2026-10-01T00:00:02.000Z", Object{"usage": Object{"input_tokens": float64(12), "output_tokens": float64(4), "cached_input_tokens": float64(2), "cache_write_input_tokens": float64(1), "total_tokens": float64(16), "reasoning_output_tokens": float64(2)}}),
		c2dRecord("response_item", "2026-10-01T00:00:03.000Z", Object{"type": "message", "role": "assistant", "content": []any{Object{"type": "output_text", "text": "answer"}}}),
	)
	conversion, err := CodexToDsh(records, Object{"sessionId": "target", "cwd": `F:\current`})
	if err != nil {
		t.Fatal(err)
	}
	assistant := Object(nil)
	for _, event := range conversion.Events {
		if str(event["type"]) == "assistant/message" {
			assistant = obj(event["data"])
		}
	}
	usage := obj(assistant["usage"])
	if num(usage["inputTokens"]) != 9 || num(usage["outputTokens"]) != 4 || num(usage["cacheReadTokens"]) != 2 || num(usage["cacheWriteTokens"]) != 1 || num(usage["totalTokens"]) != 16 || num(usage["reasoningTokens"]) != 2 {
		t.Fatalf("usage = %#v", usage)
	}
	if conversion.Tallies["workspace.remapped-context"].Mapped != 1 {
		t.Fatalf("remap tally = %#v", conversion.Tallies["workspace.remapped-context"])
	}
}

func TestCodexToDshCompactionReplacement(t *testing.T) {
	records := c2dSession(
		c2dRecord("event_msg", "2026-10-01T00:00:01.000Z", Object{"type": "task_started", "turn_id": "t1"}),
		c2dRecord("response_item", "2026-10-01T00:00:02.000Z", Object{"type": "message", "role": "user", "content": []any{Object{"type": "input_text", "text": "old"}}}),
		c2dRecord("event_msg", "2026-10-01T00:00:03.000Z", Object{"type": "task_complete", "turn_id": "t1"}),
		c2dRecord("compacted", "2026-10-01T00:00:04.000Z", Object{"replacement_history": []Object{{"type": "message", "role": "user", "content": []any{Object{"type": "input_text", "text": "summary"}}}}, "window_id": "w1"}),
	)
	conversion, err := CodexToDsh(records, Object{"sessionId": "target", "cwd": `F:\proj`})
	if err != nil {
		t.Fatal(err)
	}
	foundSummary := false
	foundReplacement := false
	for _, event := range conversion.Events {
		if strings.Contains(jsonText(event), "summary") {
			foundSummary = true
		}
		if marker, ok := event["surfaceOp"].(Object); ok && marker["op"] == "replace" {
			foundReplacement = true
		}
	}
	if !foundSummary || !foundReplacement {
		t.Fatalf("compaction did not replace active surface: summary=%v replacement=%v events=%#v", foundSummary, foundReplacement, conversion.Events)
	}
}

func TestC2DJSONStringifyPreservesRawOrderAndNormalizesJSON(t *testing.T) {
	raw := json.RawMessage(`{"z":1.0,"a":{"z":2,"a":3},"10":"ten","2":"two","01":"leading","nested":[1e-6,1e-7,1e21,-0]}`)
	want := `{"2":"two","10":"ten","z":1,"a":{"z":2,"a":3},"01":"leading","nested":[0.000001,1e-7,1e+21,0]}`
	if got := c2dJSONStringify(raw); got != want {
		t.Fatalf("JSON.stringify(raw) = %s, want %s", got, want)
	}

	records := c2dSession(c2dRecord("response_item", "t", Object{
		"type":    "custom_tool_call",
		"call_id": "raw-order",
		"name":    "inspect",
		"input":   raw,
	}))
	conversion, err := CodexToDsh(records, Object{"sessionId": "raw-order", "cwd": `F:\proj`})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range conversion.Events {
		if str(event["type"]) == "tool/call" && str(obj(event["data"])["callId"]) == "raw-order" {
			if got := str(obj(event["data"])["arguments"]); got != want {
				t.Fatalf("converted custom arguments = %s, want %s", got, want)
			}
			return
		}
	}
	t.Fatal("converted custom tool call was not found")
}
