package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
)

const syntheticKey = "synthetic-model-credential"

func testClient(t testing.TB, handler http.HandlerFunc, adjust func(*config.Config)) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	dir := t.TempDir()
	c := config.Defaults(filepath.Join(dir, "config.json"), dir)
	c.Provider.Endpoint = server.URL + "/chat/completions"
	c.Provider.RetryDelayMillis = 1
	if adjust != nil {
		adjust(&c)
	}
	client, err := New(c, func(name string) (string, bool) { return syntheticKey, name == "DEEPSEEK_API_KEY" })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client
}

func request() domain.ModelRequest {
	return domain.ModelRequest{Messages: []domain.Message{{Role: domain.RoleUser, Source: "user", Content: []domain.ContentPart{{Type: "text", Text: "Hello"}}}}}
}

func event(delta any, finish any, usage any) string {
	b, _ := json.Marshal(map[string]any{"id": "synthetic-completion", "object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}, "usage": usage})
	return "data: " + string(b) + "\n\n"
}

func stop() string { return event(map[string]any{}, "stop", nil) + "data: [DONE]\n\n" }

func sse(text string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		_, _ = io.WriteString(w, text)
	}
}

func kind(t *testing.T, err error, expected ErrorKind, requests int) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Kind != expected || e.Requests != requests {
		t.Fatalf("error = %v; expected %s, %d requests", err, expected, requests)
	}
	if strings.Contains(err.Error(), syntheticKey) {
		t.Fatal("credential echoed by error")
	}
}

func TestOfficialRequestAndTextFixture(t *testing.T) {
	fixture, err := os.ReadFile("testdata/text.sse")
	if err != nil {
		t.Fatal(err)
	}
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer "+syntheticKey || r.Header.Get("Accept") != "text/event-stream" {
			t.Error("request method, endpoint or authentication mismatch")
		}
		var body wireRequest
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid request JSON")
		}
		if body.Model != "deepseek-flash" || !body.Stream || !body.StreamOptions.IncludeUsage || body.Thinking.Type != "disabled" || body.MaxTokens != 8192 || len(body.Messages) != 1 || *body.Messages[0].Content != "Hello" {
			t.Errorf("request protocol mismatch: %+v", body)
		}
		sse(string(fixture))(w, r)
	}, nil)
	var deltas strings.Builder
	result, err := client.Complete(context.Background(), request(), func(text string) error { deltas.WriteString(text); return nil })
	if err != nil || !result.Complete || result.Text != "Hello" || deltas.String() != result.Text || result.Requests != 1 || result.FinishReason != "stop" {
		t.Fatalf("result = %+v, %v", result, err)
	}
	if result.Usage.InputTokens == nil || *result.Usage.InputTokens != 2 || result.Usage.CachedInputTokens != nil || result.Usage.ReasoningTokens != nil {
		t.Fatal("usage did not preserve known and unknown counters")
	}
}

func TestFragmentedUTF8AndMultipleToolCalls(t *testing.T) {
	text := event(map[string]any{"content": "\u4f60\u597d"}, nil, nil) +
		event(map[string]any{"tool_calls": []any{
			map[string]any{"index": 1, "id": "call-b", "type": "function", "function": map[string]any{"name": "search", "arguments": `{"query":"`}},
			map[string]any{"index": 0, "id": "call-a", "type": "function", "function": map[string]any{"name": "read_file", "arguments": `{"path":`}},
		}}, nil, nil) +
		event(map[string]any{"tool_calls": []any{
			map[string]any{"index": 0, "function": map[string]any{"arguments": `"main.go"}`}},
			map[string]any{"index": 1, "function": map[string]any{"arguments": "\u4f60\u597d\"}"}},
		}}, nil, nil) + event(map[string]any{}, "tool_calls", nil) + "data: [DONE]\n\n"
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body wireRequest
		if json.NewDecoder(r.Body).Decode(&body) != nil || len(body.Tools) != 2 || body.Tools[0].Type != "function" || body.Tools[0].Function.Name != "read_file" {
			t.Error("tool declarations not encoded")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, b := range []byte(text) {
			_, _ = w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
	}, nil)
	req := request()
	req.Tools = []domain.ToolDefinition{
		{Name: "read_file", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"additionalProperties":false}`)},
		{Name: "search", Parameters: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}},"additionalProperties":false}`)},
	}
	result, err := client.Complete(context.Background(), req, nil)
	if err != nil || !result.Complete || result.Text != "\u4f60\u597d" || len(result.ToolCalls) != 2 || result.ToolCalls[0].ID != "call-a" || result.ToolCalls[1].ID != "call-b" {
		t.Fatalf("result = %+v, %v", result, err)
	}
	for _, call := range result.ToolCalls {
		if call.Status != domain.ToolProposed || !json.Valid(call.Arguments) {
			t.Fatal("call was not a complete untrusted proposal")
		}
	}
	if result.Usage.InputTokens != nil || result.Usage.OutputTokens != nil || result.Usage.TotalTokens != nil {
		t.Fatal("unknown usage was converted to zero")
	}
}

func TestToolHistoryPairing(t *testing.T) {
	client := testClient(t, sse(stop()), nil)
	req := request()
	req.Messages = append(req.Messages,
		domain.Message{Role: domain.RoleAssistant, ToolCalls: []domain.ToolCall{{ID: "call-a", Name: "read_file", Arguments: json.RawMessage(`{"path":"main.go"}`)}}},
		domain.Message{Role: domain.RoleTool, ToolCallID: "call-a", Content: []domain.ContentPart{{Type: "text", Text: "file content"}}},
	)
	if result, err := client.Complete(context.Background(), req, nil); err != nil || !result.Complete {
		t.Fatalf("valid tool history rejected: %v", err)
	}
	req.Messages = req.Messages[:len(req.Messages)-1]
	result, err := client.Complete(context.Background(), req, nil)
	kind(t, err, Protocol, 0)
	if result.Requests != 0 {
		t.Fatal("incomplete history was sent to model")
	}
}

func TestIncompleteAndInvalidStreamsNeverReturnExecutableCalls(t *testing.T) {
	tool := func(index any, id, name, args string) string {
		return event(map[string]any{"tool_calls": []any{map[string]any{"index": index, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}}}}, nil, nil)
	}
	valid := tool(0, "a", "read_file", `{"path":"main.go"}`)
	tail := event(map[string]any{}, "tool_calls", nil) + "data: [DONE]\n\n"
	cases := []struct {
		name, text string
		expected   ErrorKind
	}{
		{"missingDone", valid + event(map[string]any{}, "tool_calls", nil), Disconnected},
		{"missingFinish", valid + "data: [DONE]\n\n", Disconnected},
		{"invalidJSON", "data: {broken}\n\n" + stop(), Protocol},
		{"invalidUTF8", "data: {\"bad\":\"\xff\"}\n\n" + stop(), Protocol},
		{"incompleteArguments", tool(0, "a", "read_file", `{"path":`) + tail, Protocol},
		{"arrayArguments", tool(0, "a", "read_file", `[]`) + tail, Protocol},
		{"duplicateIDs", valid + tool(1, "a", "search", `{}`) + tail, Protocol},
		{"missingIndex", tool(nil, "a", "read_file", `{}`) + tail, Protocol},
		{"indexGap", tool(1, "a", "read_file", `{}`) + tail, Protocol},
		{"changedName", valid + tool(0, "a", "search", `{}`) + tail, Protocol},
		{"changedID", valid + tool(0, "b", "read_file", `{}`) + tail, Protocol},
		{"stopWithCalls", valid + stop(), Protocol},
		{"toolFinishWithoutCalls", tail, Protocol},
		{"length", valid + event(map[string]any{}, "length", nil) + "data: [DONE]\n\n", Limit},
		{"filter", event(map[string]any{}, "content_filter", nil) + "data: [DONE]\n\n", Rejected},
		{"aborted", event(map[string]any{}, "aborted", nil) + "data: [DONE]\n\n", Disconnected},
		{"unknownFinish", event(map[string]any{}, "unknown", nil) + "data: [DONE]\n\n", Unsupported},
		{"unexpectedThinking", event(map[string]any{"reasoning_content": "reasoning"}, nil, nil) + stop(), Unsupported},
		{"wrongObject", strings.Replace(stop(), "chat.completion.chunk", "chat.completion", 1), Protocol},
		{"changedStreamID", valid + strings.Replace(tail, "synthetic-completion", "other-completion", 1), Protocol},
		{"emptyChoices", "data: {\"id\":\"x\",\"object\":\"chat.completion.chunk\",\"choices\":[]}\n\n" + stop(), Protocol},
		{"prematureUsage", event(map[string]any{}, nil, map[string]any{"prompt_tokens": 1}) + stop(), Protocol},
		{"reflectedCallID", tool(0, syntheticKey, "read_file", `{}`) + tail, Protocol},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			client := testClient(t, sse(test.text), nil)
			result, err := client.Complete(context.Background(), request(), nil)
			kind(t, err, test.expected, 1)
			if result.Complete || len(result.ToolCalls) != 0 || result.Requests != 1 {
				t.Fatal("failed stream exposed tool calls or was silently retried")
			}
		})
	}
}

func TestSSECommentsCRLFAndMultilineData(t *testing.T) {
	text := ": keepalive\r\n\r\n" + strings.Replace(event(map[string]any{"content": "hello"}, nil, nil), `,"id":`, ",\ndata: \"id\":", 1) + stop()
	text = strings.ReplaceAll(text, "\n", "\r\n")
	client := testClient(t, sse(text), nil)
	result, err := client.Complete(context.Background(), request(), nil)
	if err != nil || result.Text != "hello" || !result.Complete {
		t.Fatalf("SSE framing failed: %+v, %v", result, err)
	}
}

func TestUsageZeroMissingAndInvalid(t *testing.T) {
	for _, test := range []struct {
		name  string
		usage any
		valid bool
		zero  bool
	}{
		{"missing", nil, true, false},
		{"partial", map[string]any{"prompt_tokens": 2}, true, false},
		{"zero", map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}, true, true},
		{"negative", map[string]any{"prompt_tokens": -1}, false, false},
		{"inconsistentTotal", map[string]any{"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 5}, false, false},
		{"badCache", map[string]any{"prompt_tokens": 2, "prompt_cache_hit_tokens": 3}, false, false},
		{"badReasoning", map[string]any{"completion_tokens": 1, "completion_tokens_details": map[string]any{"reasoning_tokens": 2}}, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := testClient(t, sse(event(map[string]any{}, "stop", test.usage)+"data: [DONE]\n\n"), nil)
			result, err := client.Complete(context.Background(), request(), nil)
			if test.valid {
				if err != nil || !result.Complete {
					t.Fatal(err)
				}
			} else {
				kind(t, err, Protocol, 1)
			}
			if test.zero && (result.Usage.InputTokens == nil || *result.Usage.InputTokens != 0) {
				t.Fatal("explicit zero was lost")
			}
			if test.name == "partial" && (result.Usage.InputTokens == nil || result.Usage.OutputTokens != nil) {
				t.Fatal("partial usage was filled with zero")
			}
		})
	}
}

func TestHTTPErrorClassificationAndFiniteRetries(t *testing.T) {
	for _, test := range []struct {
		status   int
		expected ErrorKind
		requests int
	}{
		{401, Authentication, 1}, {402, Quota, 1}, {429, RateLimit, 3}, {500, Server, 3}, {503, Server, 3}, {404, Unsupported, 1}, {422, Unsupported, 1},
	} {
		t.Run(fmt.Sprint(test.status), func(t *testing.T) {
			var count atomic.Int32
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				count.Add(1)
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, syntheticKey)
			}, nil)
			result, err := client.Complete(context.Background(), request(), nil)
			kind(t, err, test.expected, test.requests)
			if int(count.Load()) != test.requests || result.Requests != test.requests || result.Complete {
				t.Fatal("actual request count differs from report")
			}
		})
	}
	var count atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		attempt := count.Add(1)
		if attempt <= 2 {
			w.WriteHeader(429)
			return
		}
		sse(stop())(w, r)
	}, nil)
	result, err := client.Complete(context.Background(), request(), nil)
	if err != nil || !result.Complete || result.Requests != 3 || count.Load() != 3 {
		t.Fatal("bounded retry did not report all requests")
	}
}

func TestCancellationStopsHTTPAndRetryWait(t *testing.T) {
	for _, retry := range []bool{false, true} {
		t.Run(fmt.Sprint(retry), func(t *testing.T) {
			ready := make(chan struct{})
			stopped := make(chan struct{})
			var count atomic.Int32
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				count.Add(1)
				if retry {
					w.Header().Set("Retry-After", "60")
					w.WriteHeader(429)
					close(ready)
					close(stopped)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, event(map[string]any{"content": "partial"}, nil, nil))
				w.(http.Flusher).Flush()
				close(ready)
				<-r.Context().Done()
				close(stopped)
			}, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			returned := make(chan error, 1)
			go func() { _, err := client.Complete(ctx, request(), nil); returned <- err }()
			select {
			case <-ready:
			case <-time.After(2 * time.Second):
				t.Fatal("request did not start")
			}
			cancel()
			select {
			case err := <-returned:
				kind(t, err, Cancelled, 1)
				if !errors.Is(err, context.Canceled) {
					t.Fatal("cancellation cause lost")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("cancel did not stop provider")
			}
			select {
			case <-stopped:
			case <-time.After(2 * time.Second):
				t.Fatal("HTTP request remained alive")
			}
			if count.Load() != 1 {
				t.Fatal("cancel triggered another request")
			}
		})
	}
}

func TestTimeoutAndMidStreamFailure(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := client.Complete(ctx, request(), nil)
	kind(t, err, Timeout, 1)
	client = testClient(t, sse(event(map[string]any{"content": "partial"}, nil, nil)), nil)
	var delta strings.Builder
	result, err := client.Complete(context.Background(), request(), func(text string) error { delta.WriteString(text); return nil })
	kind(t, err, Disconnected, 1)
	if result.Complete || result.Text != "partial" || delta.String() != "partial" {
		t.Fatal("partial output lost or claimed complete")
	}
}

func TestConfiguredHTTPTimeoutAndUnfinishedErrorBody(t *testing.T) {
	for _, status := range []int{200, 401} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(status)
				if status == 200 {
					_, _ = io.WriteString(w, event(map[string]any{"content": "partial"}, nil, nil))
				}
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}, func(c *config.Config) { c.Provider.TimeoutSeconds = 1 })
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			started := time.Now()
			result, err := client.Complete(ctx, request(), nil)
			if status == 200 {
				kind(t, err, Timeout, 1)
			} else {
				kind(t, err, Authentication, 1)
				if time.Since(started) > 500*time.Millisecond {
					t.Fatal("unfinished error body blocked response handling")
				}
			}
			if result.Complete || len(result.ToolCalls) != 0 {
				t.Fatal("failed response marked complete")
			}
		})
	}
}

func TestEventResponseAndRequestSizeLimits(t *testing.T) {
	for _, test := range []struct {
		name, text string
		adjust     func(*config.Config)
	}{
		{"event", event(map[string]any{"content": strings.Repeat("x", 2048)}, nil, nil) + stop(), func(c *config.Config) { c.Provider.MaxEventBytes = 1024 }},
		{"response", strings.Repeat(": keepalive\n\n", 1000) + stop(), func(c *config.Config) { c.Provider.MaxEventBytes = 512; c.Provider.MaxResponseBytes = 1024 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := testClient(t, sse(test.text), test.adjust)
			result, err := client.Complete(context.Background(), request(), nil)
			kind(t, err, Limit, 1)
			if result.Complete {
				t.Fatal("oversized response accepted")
			}
		})
	}
	client := testClient(t, sse(stop()), func(c *config.Config) { c.Limits.MaxContextBytes = 128 })
	result, err := client.Complete(context.Background(), request(), nil)
	kind(t, err, Limit, 0)
	if result.Requests != 0 {
		t.Fatal("oversized request was sent")
	}
}

func TestRedirectAndWrongMediaTypeDoNotExposeCredentials(t *testing.T) {
	var targetRequests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetRequests.Add(1) }))
	defer target.Close()
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL+"/chat/completions", 307) }, nil)
	if _, err := client.Complete(context.Background(), request(), nil); err == nil {
		t.Fatal("redirect accepted")
	}
	if targetRequests.Load() != 0 {
		t.Fatal("credential request followed a redirect")
	}
	client = testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, syntheticKey)
	}, nil)
	_, err := client.Complete(context.Background(), request(), nil)
	kind(t, err, Unsupported, 1)
}

func TestReflectedCredentialRedactionAcrossDeltas(t *testing.T) {
	text := event(map[string]any{"content": "prefix " + syntheticKey[:10]}, nil, nil) + event(map[string]any{"content": syntheticKey[10:] + " suffix"}, nil, nil) + stop()
	client := testClient(t, sse(text), nil)
	var delta strings.Builder
	result, err := client.Complete(context.Background(), request(), func(text string) error { delta.WriteString(text); return nil })
	if err != nil || result.Text != "prefix [REDACTED] suffix" || delta.String() != result.Text {
		t.Fatalf("reflected credential not redacted: err=%v", err)
	}
	args, _ := json.Marshal(map[string]string{"secret": syntheticKey})
	text = event(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "a", "type": "function", "function": map[string]any{"name": "exec", "arguments": string(args)}}}}, nil, nil) + event(map[string]any{}, "tool_calls", nil) + "data: [DONE]\n\n"
	client = testClient(t, sse(text), nil)
	result, err = client.Complete(context.Background(), request(), nil)
	kind(t, err, Protocol, 1)
	if len(result.ToolCalls) != 0 {
		t.Fatal("credential included in persistent tool arguments")
	}
}

func TestLocalModelListingDoesNotRequestAuthentication(t *testing.T) {
	var count atomic.Int32
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) { count.Add(1) }, nil)
	models, err := client.Models(context.Background())
	if err != nil || len(models) != 2 || !models[0].Configured || models[1].Configured || count.Load() != 0 {
		t.Fatal("local model discovery was not local")
	}
}

func FuzzBoundedSSE(f *testing.F) {
	f.Add([]byte(stop()))
	f.Add([]byte("data: {broken}\n\n"))
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 8192 {
			return
		}
		client := &Client{settings: config.Provider{MaxEventBytes: 1024, MaxResponseBytes: 8192}, credential: syntheticKey}
		result, err := client.stream(strings.NewReader(string(data)), 1, nil)
		if err == nil && (!result.Complete || !strings.Contains(string(data), "[DONE]")) {
			t.Fatal("stream claimed completion without an end marker")
		}
	})
}
