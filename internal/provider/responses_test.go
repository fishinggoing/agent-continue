package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
)

func responsesConfig(t *testing.T, endpoint string) config.Config {
	c := config.Defaults(filepath.Join(t.TempDir(), "config.json"), t.TempDir())
	c.Provider.ID, c.Provider.Protocol, c.Provider.Model = "hyperion", config.ProtocolResponses, "gpt-6.1-sol"
	c.Provider.Endpoint, c.Provider.CredentialEnv, c.Provider.ReasoningEffort = endpoint+"/v1/responses", "HYPERION_API_KEY", "xhigh"
	c.Provider.MaxRetries = 0
	return c
}

func sendResponse(w http.ResponseWriter, output any, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	if text != "" {
		b, _ := json.Marshal(map[string]any{"type": "response.output_text.delta", "delta": text})
		fmt.Fprintf(w, "event: response.output_text.delta\ndata: %s\n\n", b)
	}
	b, _ := json.Marshal(map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed", "output": output, "usage": map[string]any{"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}}})
	fmt.Fprintf(w, "event: response.completed\ndata: %s\n\n", b)
}

func TestResponsesToolsAndReasoningContext(t *testing.T) {
	key := "synthetic-model-key"
	var bodies []map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer "+key {
			t.Error("invalid authenticated endpoint")
		}
		var body map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid request JSON")
		}
		bodies = append(bodies, body)
		sendResponse(w, []any{map[string]any{"type": "reasoning", "id": "rs_1", "summary": []any{}, "encrypted_content": "opaque-context"}, map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "你好"}}}, map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_file", "arguments": "{\"path\":\"main.go\"}"}}, "你好")
	}))
	defer server.Close()
	c, err := NewResponses(responsesConfig(t, server.URL), func(string) (string, bool) { return key, true })
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	request := domain.ModelRequest{Messages: []domain.Message{{Role: domain.RoleUser, Content: []domain.ContentPart{{Text: "inspect code"}}}}, Tools: []domain.ToolDefinition{{Name: "read_file", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}`)}}}
	var streamed strings.Builder
	result, err := c.Complete(context.Background(), request, func(text string) error { streamed.WriteString(text); return nil })
	if err != nil || !result.Complete || len(result.ToolCalls) != 1 || result.ToolCalls[0].ID != "call_1" || streamed.String() != "你好" {
		t.Fatalf("invalid completion: %+v %v", result, err)
	}
	if string(bodies[0]["model"]) != `"gpt-6.1-sol"` || !strings.Contains(string(bodies[0]["reasoning"]), "xhigh") || string(bodies[0]["store"]) != "false" {
		t.Fatal("wrong requested model or reasoning")
	}
	request.Messages = append(request.Messages, domain.Message{Role: domain.RoleAssistant, ProviderOutput: result.ProviderOutput, ToolCalls: result.ToolCalls}, domain.Message{Role: domain.RoleTool, ToolCallID: "call_1", Content: []domain.ContentPart{{Text: "source code"}}})
	if _, err := c.Complete(context.Background(), request, nil); err != nil {
		t.Fatal(err)
	}
	input := string(bodies[1]["input"])
	if !strings.Contains(input, "opaque-context") || !strings.Contains(input, "function_call_output") || !strings.Contains(input, "call_1") {
		t.Fatalf("reasoning/tool context was lost: %s", input)
	}
}

func TestResponsesIncompleteRetryAndCancellation(t *testing.T) {
	for _, scenario := range []string{"missing-completion", "bad-arguments", "auth", "retry", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if scenario == "auth" {
					w.WriteHeader(401)
					fmt.Fprint(w, `{"error":{"message":"synthetic-model-key"}}`)
					return
				}
				if scenario == "retry" && requests == 1 {
					w.WriteHeader(429)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if scenario == "cancel" {
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					return
				}
				if scenario == "missing-completion" {
					fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n")
					return
				}
				if scenario == "bad-arguments" {
					sendResponse(w, []any{map[string]any{"type": "function_call", "call_id": "call", "name": "read_file", "arguments": "{"}}, "")
					return
				}
				sendResponse(w, []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "OK"}}}}, "OK")
			}))
			defer server.Close()
			config := responsesConfig(t, server.URL)
			if scenario == "retry" {
				config.Provider.MaxRetries = 1
				config.Provider.RetryDelayMillis = 1
			}
			c, err := NewResponses(config, func(string) (string, bool) { return "synthetic-model-key", true })
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			ctx := context.Background()
			if scenario == "cancel" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 50*time.Millisecond)
				defer cancel()
			}
			result, err := c.Complete(ctx, domain.ModelRequest{Messages: []domain.Message{{Role: domain.RoleUser, Content: []domain.ContentPart{{Text: "hello"}}}}}, nil)
			if scenario == "retry" {
				if err != nil || !result.Complete || result.Requests != 2 {
					t.Fatalf("retry failed %+v %v", result, err)
				}
			} else {
				if err == nil || result.Complete || len(result.ToolCalls) != 0 || strings.Contains(err.Error(), "synthetic-model-key") {
					t.Fatalf("unsafe failure %+v %v", result, err)
				}
			}
		})
	}
}

func TestResponsesRejectsEscapedCredentialInToolArguments(t *testing.T) {
	const key = "synthetic-responses-private-key"
	var escaped strings.Builder
	for _, char := range key {
		fmt.Fprintf(&escaped, `\u%04x`, char)
	}
	arguments := `{"path":"main.txt","content":"` + escaped.String() + `"}`
	if strings.Contains(arguments, key) {
		t.Fatal("fixture must hide the literal credential in JSON escapes")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sendResponse(w, []any{map[string]any{"type": "function_call", "call_id": "private-call", "name": "create_file", "arguments": arguments}}, "")
	}))
	defer server.Close()
	c, err := NewResponses(responsesConfig(t, server.URL), func(string) (string, bool) { return key, true })
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var emitted strings.Builder
	result, err := c.Complete(context.Background(), request(), func(text string) error { emitted.WriteString(text); return nil })
	if err == nil || result.Complete || len(result.ToolCalls) != 0 || len(result.ProviderOutput) != 0 || strings.Contains(emitted.String(), key) || strings.Contains(err.Error(), key) {
		t.Fatal("escaped credential reached a tool proposal, replay context, stream or error")
	}
}
