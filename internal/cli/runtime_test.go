package cli

import (
	"bufio"
	"bytes"
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
	"unicode"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/task"
)

const runtimeTestKey = "synthetic-cli-model-credential"

type runtimeWireMessage struct {
	Role       string `json:"role"`
	Content    string `json:"content"`
	ToolCallID string `json:"tool_call_id"`
}

type runtimeWireRequest struct {
	Messages []runtimeWireMessage `json:"messages"`
}

type runtimeFixture struct {
	path      string
	workspace string
	env       config.LookupEnv
}

func newRuntimeFixture(t *testing.T, handler func(http.ResponseWriter, *http.Request, runtimeWireRequest), adjust func(*config.Config)) runtimeFixture {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer "+runtimeTestKey {
			t.Error("unexpected model request or authentication")
		}
		var request runtimeWireRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error("invalid model request JSON")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		handler(w, r, request)
	}))
	t.Cleanup(server.Close)
	base := t.TempDir()
	cacheDir := filepath.Join(base, "cache")
	t.Setenv("LOCALAPPDATA", cacheDir)
	t.Setenv("XDG_CACHE_HOME", cacheDir)
	workspace := filepath.Join(base, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(base, "settings", "config.json")
	c, err := config.Init(path, workspace)
	if err != nil {
		t.Fatal(err)
	}
	c.DataDir = filepath.Join(base, "state")
	c.Provider.Endpoint = server.URL + "/chat/completions"
	c.Provider.MaxRetries = 0
	c.Provider.TimeoutSeconds = 5
	c.Limits.MaxDurationSeconds = 5
	if adjust != nil {
		adjust(&c)
	}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	return runtimeFixture{path: path, workspace: workspace, env: func(name string) (string, bool) {
		return runtimeTestKey, name == "DEEPSEEK_API_KEY"
	}}
}

func runtimeChunk(delta any, finish any) string {
	b, _ := json.Marshal(map[string]any{"id": "cli-fixture", "object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
	return "data: " + string(b) + "\n\n"
}

func runtimeText(w http.ResponseWriter, parts ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, part := range parts {
		_, _ = io.WriteString(w, runtimeChunk(map[string]any{"content": part}, nil))
	}
	_, _ = io.WriteString(w, runtimeChunk(map[string]any{}, "stop")+"data: [DONE]\n\n")
}

func runtimeTool(w http.ResponseWriter, id, name, args string) {
	w.Header().Set("Content-Type", "text/event-stream")
	_, _ = io.WriteString(w, runtimeChunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}}}}, nil))
	_, _ = io.WriteString(w, runtimeChunk(map[string]any{}, "tool_calls")+"data: [DONE]\n\n")
}

func runtimeUsers(request runtimeWireRequest) []string {
	var users []string
	for _, message := range request.Messages {
		if message.Role == "user" {
			users = append(users, message.Content)
		}
	}
	return users
}

func (f runtimeFixture) execute(t *testing.T, args []string, stdin string, interactive bool) (string, string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var stdout, stderr bytes.Buffer
	args = append(append([]string{}, args...), "--config", f.path)
	handled, err := ExecuteContext(ctx, args, Streams{In: strings.NewReader(stdin), Out: &stdout, Err: &stderr, Interactive: interactive}, f.env)
	if !handled {
		t.Fatalf("runtime command was not handled: %v", args)
	}
	return stdout.String(), stderr.String(), err
}

func runtimeEvents(t *testing.T, text string) []domain.Event {
	t.Helper()
	var events []domain.Event
	scanner := bufio.NewScanner(strings.NewReader(text))
	scanner.Buffer(make([]byte, 1024), 1<<20)
	for scanner.Scan() {
		var event domain.Event
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatalf("stdout is not NDJSON events: %v", err)
		}
		if event.Version != domain.SchemaVersion || event.SessionID == "" || event.RunID == "" || event.Time.IsZero() || event.Sequence == 0 {
			t.Fatalf("event lacks required contract fields: %+v", event)
		}
		if len(events) != 0 && event.Sequence != events[len(events)-1].Sequence+1 {
			t.Fatal("event sequence is not contiguous")
		}
		events = append(events, event)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 {
		t.Fatal("no events emitted")
	}
	last := events[len(events)-1]
	if last.Type != domain.RunCompleted && last.Type != domain.RunCancelled && last.Type != domain.RunFailed || last.Data.Run == nil {
		t.Fatalf("last event is not a persisted terminal run: %+v", last)
	}
	return events
}

func (f runtimeFixture) snapshots(t *testing.T) []task.Snapshot {
	t.Helper()
	// Discovery and export remain available after the model credential is removed.
	var stdout bytes.Buffer
	handled, err := ExecuteContext(context.Background(), []string{"sessions", "list", "--config", f.path}, Streams{Out: &stdout}, func(string) (string, bool) { return "", false })
	if !handled || err != nil {
		t.Fatalf("sessions list without credential: handled=%v, err=%v", handled, err)
	}
	var snapshots []task.Snapshot
	if err := json.Unmarshal(stdout.Bytes(), &snapshots); err != nil {
		t.Fatal(err)
	}
	return snapshots
}

func (f runtimeFixture) snapshot(t *testing.T, id string) task.Snapshot {
	t.Helper()
	var snap task.Snapshot
	for _, command := range []string{"show", "export"} {
		var stdout bytes.Buffer
		handled, err := ExecuteContext(context.Background(), []string{"sessions", command, id, "--config", f.path}, Streams{Out: &stdout}, func(string) (string, bool) { return "", false })
		if !handled || err != nil {
			t.Fatalf("sessions %s without credential: %v", command, err)
		}
		if strings.Contains(stdout.String(), runtimeTestKey) {
			t.Fatal("session output exposed the model credential")
		}
		if err := json.Unmarshal(stdout.Bytes(), &snap); err != nil {
			t.Fatal(err)
		}
		if snap.Session.ID != id {
			t.Fatal("session discovery returned the wrong ID")
		}
	}
	return snap
}

func TestRuntimeRunResumeAndSessionDiscovery(t *testing.T) {
	var requests atomic.Int32
	f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
		switch requests.Add(1) {
		case 1:
			if got := runtimeUsers(request); len(got) != 1 || got[0] != "first prompt" {
				t.Errorf("first prompt differs: %v", got)
			}
			runtimeText(w, "initial answer")
		case 2:
			if got := runtimeUsers(request); len(got) != 2 || got[0] != "first prompt" || got[1] != "second prompt" {
				t.Errorf("resume lost user history: %v", got)
			}
			found := false
			for _, message := range request.Messages {
				found = found || message.Role == "assistant" && message.Content == "initial answer"
			}
			if !found {
				t.Error("resume lost assistant history")
			}
			runtimeTool(w, "read-on-resume", "read_file", `{"path":"main.txt"}`)
		case 3:
			last := request.Messages[len(request.Messages)-1]
			if last.Role != "tool" || last.ToolCallID != "read-on-resume" || !strings.Contains(last.Content, "same local workspace") {
				t.Errorf("resume did not read its original workspace: %+v", last)
			}
			runtimeText(w, "resumed answer")
		case 4:
			if got := runtimeUsers(request); len(got) != 3 || got[2] != "interactive resume" {
				t.Errorf("interactive resume lost session history: %v", got)
			}
			runtimeText(w, "interactive answer")
		default:
			t.Error("unexpected model request")
			runtimeText(w, "unexpected")
		}
	}, nil)
	if err := os.WriteFile(filepath.Join(f.workspace, "main.txt"), []byte("same local workspace"), 0600); err != nil {
		t.Fatal(err)
	}
	stdout, _, err := f.execute(t, []string{"run", "--cwd", f.workspace, "--prompt", "first prompt", "--json"}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	first := runtimeEvents(t, stdout)
	id := first[0].SessionID
	if run := first[len(first)-1].Data.Run; run.ModelRequests != 1 || run.ToolsExecuted != 0 || run.Status != domain.Completed {
		t.Fatalf("incorrect initial execution counts: %+v", run)
	}
	listed := f.snapshots(t)
	if len(listed) != 1 || listed[0].Session.ID != id {
		t.Fatalf("session cannot be discovered: %+v", listed)
	}
	stdout, _, err = f.execute(t, []string{"resume", id, "--prompt", "second prompt", "--json"}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	resumed := runtimeEvents(t, stdout)
	if resumed[0].Sequence <= first[len(first)-1].Sequence || resumed[0].RunID == first[0].RunID {
		t.Fatal("resume replayed prior-run events")
	}
	for _, event := range resumed {
		if event.SessionID != id || event.RunID != resumed[0].RunID {
			t.Fatal("resume mixed sessions or runs")
		}
	}
	terminal := *resumed[len(resumed)-1].Data.Run
	snap := f.snapshot(t, id)
	if snap.Session.Workspace != f.workspace || len(snap.Runs) != 2 || snap.Runs[1] != terminal || terminal.ModelRequests != 2 || terminal.ToolsExecuted != 1 || terminal.Steps != 2 || requests.Load() != 3 {
		t.Fatalf("resume counts or persisted state differ: terminal=%+v snapshot=%+v", terminal, snap)
	}
	stdout, _, err = f.execute(t, []string{"resume", id}, "interactive resume\n/exit\n", true)
	if err != nil || stdout != "interactive answer\n" || requests.Load() != 4 || len(f.snapshot(t, id).Runs) != 3 {
		t.Fatalf("resume without a prompt did not open current-session chat: output=%q err=%v", stdout, err)
	}
}

func TestRuntimeResponsesRunResumePreservesReasoning(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer "+runtimeTestKey {
			t.Error("unexpected Responses model request or authentication")
		}
		var request struct {
			Model     string `json:"model"`
			Store     *bool  `json:"store"`
			Stream    bool   `json:"stream"`
			Reasoning struct {
				Effort string `json:"effort"`
			} `json:"reasoning"`
			Input []struct {
				Type             string          `json:"type"`
				Role             string          `json:"role"`
				ID               string          `json:"id"`
				EncryptedContent string          `json:"encrypted_content"`
				Content          json.RawMessage `json:"content"`
			} `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error("invalid Responses request JSON")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if request.Model != "gpt-6.1-sol" || request.Reasoning.Effort != "xhigh" || request.Store == nil || *request.Store || !request.Stream {
			t.Error("Responses configuration or private streaming contract differs")
		}
		n := requests.Add(1)
		var users []string
		foundReasoning, foundAssistant := false, false
		for _, item := range request.Input {
			if item.Role == "user" {
				var text string
				if err := json.Unmarshal(item.Content, &text); err != nil {
					t.Error("invalid Responses user content")
				}
				users = append(users, text)
			}
			if item.Type == "reasoning" && item.ID == "rs_cli_first" && item.EncryptedContent == "cli-opaque-reasoning-context" {
				foundReasoning = true
			}
			if item.Type == "message" && item.Role == "assistant" {
				var content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				}
				if err := json.Unmarshal(item.Content, &content); err != nil {
					t.Error("invalid replayed Responses assistant content")
				}
				for _, part := range content {
					foundAssistant = foundAssistant || part.Type == "output_text" && part.Text == "responses first answer"
				}
			}
		}
		if n == 1 && strings.Join(users, "|") != "responses first" {
			t.Errorf("initial Responses prompt differs: %v", users)
		}
		if n == 2 && (strings.Join(users, "|") != "responses first|responses second" || !foundReasoning || !foundAssistant) {
			t.Errorf("Responses resume lost users, assistant or opaque reasoning: users=%v assistant=%v reasoning=%v", users, foundAssistant, foundReasoning)
		}
		if n > 2 {
			t.Error("unexpected Responses model request")
		}
		text, reasoningID := "responses first answer", "rs_cli_first"
		if n == 2 {
			text, reasoningID = "responses resumed answer", "rs_cli_second"
		}
		w.Header().Set("Content-Type", "text/event-stream")
		delta, _ := json.Marshal(map[string]any{"type": "response.output_text.delta", "delta": text})
		_, _ = fmt.Fprintf(w, "event: response.output_text.delta\ndata: %s\n\n", delta)
		completion, _ := json.Marshal(map[string]any{"type": "response.completed", "response": map[string]any{
			"status": "completed", "usage": map[string]any{"input_tokens": 5, "output_tokens": 2, "total_tokens": 7},
			"output": []any{
				map[string]any{"type": "reasoning", "id": reasoningID, "summary": []any{}, "encrypted_content": "cli-opaque-reasoning-context"},
				map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text}}},
			},
		}})
		_, _ = fmt.Fprintf(w, "event: response.completed\ndata: %s\n\n", completion)
	}))
	t.Cleanup(server.Close)
	base := t.TempDir()
	t.Setenv("LOCALAPPDATA", filepath.Join(base, "cache"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(base, "cache"))
	f := runtimeFixture{path: filepath.Join(base, "settings", "config.json"), workspace: filepath.Join(base, "workspace"), env: func(name string) (string, bool) {
		return runtimeTestKey, name == "HYPERION_API_KEY"
	}}
	if err := os.Mkdir(f.workspace, 0700); err != nil {
		t.Fatal(err)
	}
	c, err := config.Init(f.path, f.workspace)
	if err != nil {
		t.Fatal(err)
	}
	c.DataDir = filepath.Join(base, "state")
	c.Provider.ID, c.Provider.Protocol, c.Provider.Model = "hyperion", config.ProtocolResponses, "gpt-6.1-sol"
	c.Provider.Endpoint, c.Provider.CredentialEnv, c.Provider.ReasoningEffort = server.URL+"/v1/responses", "HYPERION_API_KEY", "xhigh"
	c.Provider.MaxRetries, c.Provider.TimeoutSeconds, c.Limits.MaxDurationSeconds = 0, 5, 5
	encoded, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.path, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	stdout, _, err := f.execute(t, []string{"run", "--cwd", f.workspace, "--prompt", "responses first", "--json"}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	first := runtimeEvents(t, stdout)
	firstTerminal := first[len(first)-1]
	stdout, _, err = f.execute(t, []string{"resume", firstTerminal.SessionID, "--prompt", "responses second", "--json"}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	resumed := runtimeEvents(t, stdout)
	terminal := resumed[len(resumed)-1]
	if resumed[0].Sequence <= firstTerminal.Sequence || terminal.RunID == firstTerminal.RunID || terminal.SessionID != firstTerminal.SessionID || requests.Load() != 2 {
		t.Fatal("Responses resume replayed prior-run events or switched sessions")
	}
	for _, event := range resumed {
		if event.RunID != terminal.RunID || event.SessionID != terminal.SessionID {
			t.Fatal("Responses output mixed earlier runs into current run")
		}
	}
	snap := f.snapshot(t, terminal.SessionID)
	if snap.Session.ModelRef != "hyperion" || len(snap.Runs) != 2 || snap.Runs[0] != *firstTerminal.Data.Run || snap.Runs[1] != *terminal.Data.Run {
		t.Fatal("Responses terminal events differ from persisted runs")
	}
	for _, run := range snap.Runs {
		if run.Status != domain.Completed || run.EndReason != domain.EndStop || run.ModelRequests != 1 || run.Steps != 1 || run.ToolsExecuted != 0 {
			t.Fatalf("Responses run counters differ: %+v", run)
		}
	}
}

func TestRuntimePromptFromStdinAndBoundedInput(t *testing.T) {
	var requests atomic.Int32
	f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
		requests.Add(1)
		if got := runtimeUsers(request); len(got) != 1 || got[0] != "stdin prompt\nsecond line\n" {
			t.Errorf("stdin prompt differs: %v", got)
		}
		runtimeText(w, "stdin answer")
	}, nil)
	stdout, _, err := f.execute(t, []string{"run", "--cwd", f.workspace, "--json"}, "stdin prompt\nsecond line\n", false)
	if err != nil {
		t.Fatal(err)
	}
	runtimeEvents(t, stdout)
	input := &runtimeCountingReader{Reader: strings.NewReader(strings.Repeat("x", 1<<20))}
	var out bytes.Buffer
	_, err = ExecuteContext(context.Background(), []string{"run", "--cwd", f.workspace, "--config", f.path, "--json"}, Streams{In: input, Out: &out}, f.env)
	if err == nil || out.Len() != 0 || input.bytes > 8193 || requests.Load() != 1 || len(f.snapshots(t)) != 1 {
		t.Fatalf("oversized stdin was not bounded before execution: err=%v bytes=%d requests=%d", err, input.bytes, requests.Load())
	}
}

type runtimeCountingReader struct {
	io.Reader
	bytes int
}

func (r *runtimeCountingReader) Read(b []byte) (int, error) {
	n, err := r.Reader.Read(b)
	r.bytes += n
	return n, err
}

func TestRuntimeInvalidArgumentsDoNotEchoValues(t *testing.T) {
	for _, args := range [][]string{
		{"run", "--prompt", runtimeTestKey},
		{"run", "--cwd", "x", "--cwd", runtimeTestKey},
		{"run", "--cwd", "x", "--unknown", runtimeTestKey},
		{"run", "--cwd", "x", "--json=" + runtimeTestKey},
		{"run", "--cwd", "x", "--json", "--json"},
		{"run", "--cwd"},
		{"chat", "--prompt", runtimeTestKey},
		{"resume"},
		{"resume", "--prompt", runtimeTestKey},
		{"sessions", "show"},
		{"sessions", "list", "--model", runtimeTestKey},
	} {
		var stdout, stderr bytes.Buffer
		handled, err := ExecuteContext(context.Background(), args, Streams{Out: &stdout, Err: &stderr}, func(string) (string, bool) { return "", false })
		if !handled || err == nil || stdout.Len() != 0 || stderr.Len() != 0 || strings.Contains(err.Error(), runtimeTestKey) {
			t.Fatalf("invalid arguments were not rejected safely: handled=%v err=%v", handled, err)
		}
	}
}

func TestRuntimeWritePoliciesAndApprovalInput(t *testing.T) {
	for _, tc := range []struct {
		name, mode, answer                               string
		interactive, listed, allowed, approval, jsonMode bool
	}{
		{"ask without terminal", "ask", "yes\n", false, false, false, true, false},
		{"ask JSON terminal", "ask", "yes\n", true, false, false, true, true},
		{"ask JSON pipe", "ask", "yes\n", false, false, false, true, true},
		{"ask approve", "ask", "yes\n", true, false, true, true, false},
		{"ask deny", "ask", "no\n", true, false, false, true, false},
		{"allow listed", "allow", "", false, true, true, false, true},
		{"allow unlisted", "allow", "", false, false, false, false, true},
		{"readonly", "readonly", "yes\n", true, false, false, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
				if requests.Add(1) == 1 {
					runtimeTool(w, "write-once", "create_file", `{"path":"created.txt","content":"approved content"}`)
					return
				}
				last := request.Messages[len(request.Messages)-1]
				var result domain.ToolResult
				if json.Unmarshal([]byte(last.Content), &result) != nil || last.Role != "tool" || result.CallID != "write-once" {
					t.Error("missing write result in model history")
				}
				if tc.allowed && result.Status != domain.ToolCompleted || !tc.allowed && result.Status != domain.ToolDenied {
					t.Errorf("incorrect write policy result: %+v", result)
				}
				runtimeText(w, "write handled")
			}, func(c *config.Config) {
				c.Tools.Mode = tc.mode
				if tc.listed {
					c.Tools.AllowedTools = []string{"create_file"}
				}
			})
			args := []string{"run", "--cwd", f.workspace, "--prompt", "create a file"}
			if tc.jsonMode {
				args = append(args, "--json")
			}
			started := time.Now()
			stdout, _, err := f.execute(t, args, tc.answer, tc.interactive)
			if err != nil {
				t.Fatal(err)
			}
			if time.Since(started) > 3*time.Second {
				t.Fatal("write approval waited on invisible input")
			}
			if tc.jsonMode {
				runtimeEvents(t, stdout)
			}
			b, err := os.ReadFile(filepath.Join(f.workspace, "created.txt"))
			if tc.allowed && (err != nil || string(b) != "approved content") || !tc.allowed && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("unapproved write or approved write missing: err=%v", err)
			}
			snaps := f.snapshots(t)
			if len(snaps) != 1 {
				t.Fatalf("incorrect session count: %d", len(snaps))
			}
			snap := f.snapshot(t, snaps[0].Session.ID)
			if len(snap.Tools) != 1 || (snap.Tools[0].Approval != nil) != tc.approval || snap.Runs[0].ModelRequests != 2 {
				t.Fatalf("write approval or request count not persisted: %+v", snap)
			}
			wantExecuted := 0
			if tc.allowed {
				wantExecuted = 1
			}
			if snap.Runs[0].ToolsExecuted != wantExecuted {
				t.Fatal("denied tool counted as executed")
			}
		})
	}
}

func TestRuntimeChatMultiTurnNewAndExit(t *testing.T) {
	var requests atomic.Int32
	f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
		want := [][]string{{"first"}, {"first", "second"}, {"third"}}
		n := int(requests.Add(1))
		got := runtimeUsers(request)
		if n > len(want) || strings.Join(got, "|") != strings.Join(want[n-1], "|") {
			t.Errorf("chat history differs at turn %d: %v", n, got)
		}
		runtimeText(w, fmt.Sprintf("answer %d", n))
	}, nil)
	stdout, _, err := f.execute(t, []string{"chat", "--cwd", f.workspace}, "first\nsecond\n/new\nthird\n/exit\nunread\n", true)
	if err != nil || requests.Load() != 3 || stdout != "answer 1\nanswer 2\nanswer 3\n" {
		t.Fatalf("chat result: requests=%d output=%q err=%v", requests.Load(), stdout, err)
	}
	snaps := f.snapshots(t)
	if len(snaps) != 2 {
		t.Fatalf("/new did not create an independent session: %+v", snaps)
	}
	if len(f.snapshot(t, snaps[0].Session.ID).Runs)+len(f.snapshot(t, snaps[1].Session.ID).Runs) != 3 {
		t.Fatal("chat turns were not persisted in their sessions")
	}
}

func TestRuntimeCancellationPersistsTerminalRun(t *testing.T) {
	started := make(chan struct{})
	f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
		close(started)
		<-r.Context().Done()
	}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	go func() {
		select {
		case <-started:
			cancel()
		case <-ctx.Done():
		}
	}()
	var stdout bytes.Buffer
	_, err := ExecuteContext(ctx, []string{"run", "--cwd", f.workspace, "--prompt", "wait until canceled", "--config", f.path, "--json"}, Streams{Out: &stdout}, f.env)
	if ExitCode(err) != domain.ExitCancelled {
		t.Fatalf("cancel exit code = %d, err=%v", ExitCode(err), err)
	}
	events := runtimeEvents(t, stdout.String())
	last := events[len(events)-1]
	snap := f.snapshot(t, last.SessionID)
	if last.Type != domain.RunCancelled || last.Data.Run.EndReason != domain.EndCancelled || last.Data.Run.Status != domain.Cancelled || snap.Runs[0] != *last.Data.Run || snap.Runs[0].ModelRequests != 1 {
		t.Fatalf("cancel terminal state differs: event=%+v snapshot=%+v", last, snap)
	}
}

func TestRuntimeConfiguredLimitsReturnExitThree(t *testing.T) {
	for _, name := range []string{"steps", "duration"} {
		t.Run(name, func(t *testing.T) {
			f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
				if name == "duration" {
					<-r.Context().Done()
					return
				}
				runtimeTool(w, "list-limit", "list_files", `{}`)
			}, func(c *config.Config) {
				if name == "duration" {
					c.Limits.MaxDurationSeconds = 1
				} else {
					c.Limits.MaxSteps = 1
				}
			})
			stdout, _, err := f.execute(t, []string{"run", "--cwd", f.workspace, "--prompt", "exercise limit", "--json"}, "", false)
			if ExitCode(err) != domain.ExitLimit {
				t.Fatalf("limit exit code = %d, err=%v", ExitCode(err), err)
			}
			events := runtimeEvents(t, stdout)
			terminal := events[len(events)-1]
			if terminal.Type != domain.RunFailed || terminal.Data.Run.EndReason != domain.EndLimit || terminal.Data.Run.ModelRequests != 1 {
				t.Fatalf("limit not accurately persisted: %+v", terminal)
			}
			if name == "steps" && terminal.Data.Run.ToolsExecuted != 1 {
				t.Fatal("step limit lost actual tool execution count")
			}
			if snap := f.snapshot(t, terminal.SessionID); snap.Runs[0] != *terminal.Data.Run {
				t.Fatal("limit terminal event differs from session export")
			}
		})
	}
}

type runtimeApprovalOutput struct {
	buffer bytes.Buffer
	ready  chan struct{}
}

func (w *runtimeApprovalOutput) String() string { return w.buffer.String() }

func (w *runtimeApprovalOutput) Write(b []byte) (int, error) {
	if bytes.Contains(b, []byte("Allow once?")) {
		select {
		case w.ready <- struct{}{}:
		default:
		}
	}
	return w.buffer.Write(b)
}

func TestRuntimePendingApprovalEndsWithoutTerminalInput(t *testing.T) {
	for _, name := range []string{"duration", "cancel"} {
		t.Run(name, func(t *testing.T) {
			var requests atomic.Int32
			f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
				if requests.Add(1) != 1 {
					t.Error("pending approval made another model request")
				}
				runtimeTool(w, "waiting-write", "create_file", `{"path":"never-created.txt","content":"requires approval"}`)
			}, func(c *config.Config) {
				c.Tools.Mode = "ask"
				if name == "duration" {
					c.Limits.MaxDurationSeconds = 1
				}
			})
			reader, writer := io.Pipe()
			defer reader.Close()
			defer writer.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			stderr := &runtimeApprovalOutput{ready: make(chan struct{}, 1)}
			if name == "cancel" {
				go func() {
					select {
					case <-stderr.ready:
						cancel()
					case <-ctx.Done():
					}
				}()
			}
			var stdout bytes.Buffer
			started := time.Now()
			handled, err := ExecuteContext(ctx, []string{"run", "--cwd", f.workspace, "--prompt", "request approval and wait", "--config", f.path}, Streams{In: reader, Out: &stdout, Err: stderr, Interactive: true}, f.env)
			wantCode, wantEnd, wantStatus := domain.ExitLimit, domain.EndLimit, domain.Failed
			if name == "cancel" {
				wantCode, wantEnd, wantStatus = domain.ExitCancelled, domain.EndCancelled, domain.Cancelled
			}
			if !handled || ExitCode(err) != wantCode || time.Since(started) > 3*time.Second {
				t.Fatalf("waiting input blocked task termination: handled=%v code=%d elapsed=%s err=%v", handled, ExitCode(err), time.Since(started), err)
			}
			if !strings.Contains(stderr.String(), "Allow once?") || !strings.Contains(stderr.String(), fmt.Sprintf("Run: %s (%s)", wantStatus, wantEnd)) {
				t.Fatal("CLI did not consume terminal run while awaiting approval input")
			}
			if _, err := os.Stat(filepath.Join(f.workspace, "never-created.txt")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("unapproved file was written: %v", err)
			}
			snaps := f.snapshots(t)
			if len(snaps) != 1 {
				t.Fatal("missing pending-approval session")
			}
			snap := f.snapshot(t, snaps[0].Session.ID)
			if len(snap.Runs) != 1 || snap.Runs[0].Status != wantStatus || snap.Runs[0].EndReason != wantEnd || snap.Runs[0].ToolsExecuted != 0 || snap.Runs[0].ModelRequests != 1 {
				t.Fatalf("pending approval run was not safely terminated and persisted: %+v", snap.Runs)
			}
			if len(snap.Tools) != 1 || snap.Tools[0].Approval == nil || snap.Tools[0].Result == nil {
				t.Fatal("pending approval or cancelled tool result was not persisted")
			}
			tool := snap.Tools[0]
			if tool.Approval.Status != "cancelled" || tool.Result.Status != domain.ToolCancelled {
				t.Fatalf("pending approval not cancelled: approval=%s result=%s", tool.Approval.Status, tool.Result.Status)
			}
		})
	}
}

func TestRuntimeModelReflectionAndTerminalControls(t *testing.T) {
	f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
		runtimeText(w, "safe\x1b[2J\x00\r\b\u009b\u202e "+runtimeTestKey[:12], runtimeTestKey[12:]+" end")
	}, nil)
	stdout, stderr, err := f.execute(t, []string{"run", "--cwd", f.workspace, "--prompt", "answer safely"}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stdout+stderr, runtimeTestKey) || !strings.Contains(stdout, "[REDACTED]") {
		t.Fatal("reflected credential reached terminal output")
	}
	for _, r := range stdout + stderr {
		if r != '\n' && r != '\t' && (unicode.IsControl(r) || unicode.Is(unicode.Cf, r)) {
			t.Fatal("model controls reached terminal")
		}
	}
	snaps := f.snapshots(t)
	if len(snaps) != 1 {
		t.Fatal("missing reflected-output session")
	}
	f.snapshot(t, snaps[0].Session.ID)
	stdout, _, err = f.execute(t, []string{"run", "--cwd", f.workspace, "--prompt", "emit safe events", "--json"}, "", false)
	if err != nil || strings.Contains(stdout, runtimeTestKey) {
		t.Fatalf("event output exposed reflected model credential: %v", err)
	}
	events := runtimeEvents(t, stdout)
	var deltas strings.Builder
	for _, event := range events {
		if event.Type == domain.MessageDelta {
			deltas.WriteString(event.Data.Text)
		}
	}
	if strings.Contains(deltas.String(), runtimeTestKey) || !strings.Contains(deltas.String(), "[REDACTED]") {
		t.Fatal("persisted deltas did not redact credentials across fragments")
	}
}

type runtimeBrokenWriter struct{}

func (runtimeBrokenWriter) Write(b []byte) (int, error) {
	if bytes.Contains(b, []byte(`"type":"message.delta"`)) {
		return 0, errors.New(runtimeTestKey)
	}
	return len(b), nil
}

func TestRuntimeBrokenOutputCancelsExecution(t *testing.T) {
	requestEnded := make(chan struct{})
	f := newRuntimeFixture(t, func(w http.ResponseWriter, r *http.Request, request runtimeWireRequest) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, runtimeChunk(map[string]any{"content": strings.Repeat("partial response ", 16)}, nil))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(requestEnded)
	}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_, err := ExecuteContext(ctx, []string{"run", "--cwd", f.workspace, "--prompt", "stream answer", "--config", f.path, "--json"}, Streams{Out: runtimeBrokenWriter{}}, f.env)
	if err == nil || strings.Contains(err.Error(), runtimeTestKey) {
		t.Fatalf("broken output error was absent or exposed writer text: %v", err)
	}
	select {
	case <-requestEnded:
	case <-time.After(time.Second):
		t.Fatal("broken output left model execution running")
	}
	snaps := f.snapshots(t)
	if len(snaps) != 1 || snaps[0].Session.Status != domain.Cancelled {
		t.Fatalf("broken output cancellation was not persisted: %+v", snaps)
	}
	snap := f.snapshot(t, snaps[0].Session.ID)
	if len(snap.Runs) != 1 || snap.Runs[0].EndReason != domain.EndCancelled {
		t.Fatalf("broken output run cancellation was not persisted: %+v", snap)
	}
}
