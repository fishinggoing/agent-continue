package task

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/session"
)

const localKey = "synthetic-local-model-credential"
const localToken = "synthetic-private-web-token"

func localEnvironment(name string) (string, bool) {
	switch name {
	case "DEEPSEEK_API_KEY":
		return localKey, true
	case "AGENT_CONTINUE_TOKEN":
		return localToken, true
	}
	return "", false
}

func localConfig(t *testing.T) (config.Config, string, string) {
	t.Helper()
	base := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", filepath.Join(base, "cache"))
	t.Setenv("LocalAppData", filepath.Join(base, "cache"))
	workspace := filepath.Join(base, "project")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(base, "runtime-config.json")
	c := config.Defaults(configPath, workspace)
	c.Provider.MaxRetries = 0
	return c, configPath, workspace
}

func localEvent(delta any, finish any) string {
	b, _ := json.Marshal(map[string]any{"id": "synthetic-completion", "object": "chat.completion.chunk", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
	return "data: " + string(b) + "\n\n"
}

func localTextResponse(text string) string {
	return localEvent(map[string]any{"content": text}, nil) + localEvent(map[string]any{}, "stop") + "data: [DONE]\n\n"
}

func TestLocalToolScopeProtectsPathsLinksAndCredentials(t *testing.T) {
	c, configPath, workspace := localConfig(t)
	c.WorkspaceRoots = []string{filepath.Dir(workspace)}
	if err := os.WriteFile(configPath, []byte("private config"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenLocal(c, localEnvironment, configPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	f, err := s.localFiles(filepath.Dir(workspace))
	if err != nil {
		t.Fatal(err)
	}
	defer f.root.Close()
	for name, content := range map[string]string{
		"project/main.go": "package main\n", "project/.env": "sensitive", "project/secrets/auth.txt": "sensitive", "project/pdf_text.txt": "sensitive",
		"project/node_modules/pkg/main.js": "dependency", "project/private.sqlite": "private", "project/key.pem": "private",
		"project/ordinary.txt": "normal content with " + localKey, "project/other.txt": localToken,
	} {
		full := filepath.Join(filepath.Dir(workspace), filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(full), 0700)
		if err := os.WriteFile(full, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"runtime-config.json", "data/cli-v1/sessions-v1.sqlite", "project/.env", "project/secrets/auth.txt", "project/pdf_text.txt", "project/node_modules/pkg/main.js", "project/private.sqlite", "project/key.pem", "../elsewhere", "project/ordinary.txt", "project/other.txt"} {
		if text, err := f.Read(name); err == nil || text != "" || strings.Contains(err.Error(), localKey) || strings.Contains(err.Error(), localToken) {
			t.Fatalf("protected read %q: content=%q error=%v", name, text, err)
		}
	}
	if text, err := f.Read("project/main.go"); err != nil || text != "package main\n" {
		t.Fatalf("permitted source inaccessible: %v", err)
	}
	if err := os.Link(configPath, filepath.Join(workspace, "alias.txt")); err == nil {
		if _, err := f.Read("project/alias.txt"); err == nil {
			t.Fatal("hardlink alias exposed private configuration")
		}
	}
	if err := os.Symlink(workspace, filepath.Join(filepath.Dir(workspace), "linked")); err == nil {
		if _, err := f.Read("linked/main.go"); err == nil {
			t.Fatal("symlink directory allowed")
		}
	}
	names, err := f.List()
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(names, "\n")
	for _, hidden := range []string{"runtime-config", "sqlite", "pdf_text", "secrets", "node_modules", "key.pem", "alias", "linked"} {
		if strings.Contains(joined, hidden) {
			t.Fatalf("protected filename listed: %s", joined)
		}
	}
	for _, secret := range []string{localKey, localToken} {
		args, _ := json.Marshal(FileInput{Path: "project/new.txt", Content: secret})
		escaped := strings.ReplaceAll(string(args), secret[:1], fmt.Sprintf("\\u%04x", secret[0]))
		if _, err := f.Validate(context.Background(), domain.ToolCall{ID: "call", Name: "create_file", Arguments: json.RawMessage(escaped)}); err == nil {
			t.Fatal("escaped credential allowed in write")
		}
	}
}

func TestLocalConfigSymlinkAndAncestorSymlinkRejected(t *testing.T) {
	for _, ancestor := range []bool{false, true} {
		t.Run(fmt.Sprint(ancestor), func(t *testing.T) {
			c, configPath, workspace := localConfig(t)
			target := filepath.Join(workspace, "runtime.json")
			body, _ := json.Marshal(c)
			if err := os.WriteFile(target, body, 0600); err != nil {
				t.Fatal(err)
			}
			linkTarget, linkPath := target, configPath
			if ancestor {
				linkTarget, linkPath = workspace, filepath.Join(filepath.Dir(workspace), "linked-settings")
				configPath = filepath.Join(linkPath, "runtime.json")
			}
			if err := os.Symlink(linkTarget, linkPath); err != nil {
				t.Skip("symlink creation unavailable")
			}
			loaded, err := config.Load(config.Overrides{Path: configPath}, localEnvironment)
			if err != nil {
				t.Fatal(err)
			}
			if s, err := OpenLocal(loaded, localEnvironment, configPath); err == nil {
				s.Close()
				t.Fatal("linked active configuration opened local runtime")
			}
			if _, err := os.Stat(filepath.Join(c.DataDir, "cli-v1", "sessions-v1.sqlite")); !os.IsNotExist(err) {
				t.Fatal("rejected config created session storage")
			}
		})
	}
}

func TestLocalPortablePathAliasesCannotAccessProtectedFiles(t *testing.T) {
	c, configPath, workspace := localConfig(t)
	c.WorkspaceRoots = []string{filepath.Dir(workspace)}
	if err := os.WriteFile(configPath, []byte("protected configuration"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenLocal(c, localEnvironment, configPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	f, err := s.localFiles(filepath.Dir(workspace))
	if err != nil {
		t.Fatal(err)
	}
	defer f.root.Close()
	for _, name := range []string{"runtime-config.json.", "runtime-config.json ", "data./cli-v1/sessions-v1.sqlite.", "data /cli-v1/sessions-v1.sqlite ", "RUNTIM~1.JSON", "STATE~1/cli-v1/sessions-v1.sqlite", "CON", "con.txt", "AUX.json", "PRN", "NUL", "nul.log", "COM1", "COM9.txt", "LPT1.txt", "LPT9", "CONIN$", "CONOUT$.txt", "COM\u00b9.txt", "LPT\u00b3.txt", "project/a?/b.txt"} {
		if localPathAllowed(name) {
			t.Fatalf("portable alias accepted: %q", name)
		}
		if _, err := f.Read(name); err == nil {
			t.Fatalf("portable alias read accepted: %q", name)
		}
		args, _ := json.Marshal(FileInput{Path: name, Content: "modified"})
		if _, err := f.Validate(context.Background(), domain.ToolCall{ID: "create", Name: "create_file", Arguments: args}); err == nil {
			t.Fatalf("portable alias write accepted: %q", name)
		}
	}
	if localPathAllowed("project/COM10.txt") == false || localPathAllowed("project/console.go") == false {
		t.Fatal("ordinary source filename denied")
	}
	for _, alias := range []string{configPath + ".", configPath + " ", filepath.Join(filepath.Dir(configPath), "RUNTIM~1.JSON")} {
		if linked, err := OpenLocal(c, localEnvironment, alias); err == nil {
			linked.Close()
			t.Fatal("aliased active configuration accepted")
		}
	}
	if runtime.GOOS == "windows" {
		for _, alias := range []string{"runtime-config.json.", "runtime-config.json "} {
			h, err := f.root.Open(alias)
			if err == nil {
				info, statErr := h.Stat()
				h.Close()
				original, _ := os.Stat(configPath)
				if statErr != nil || !os.SameFile(info, original) {
					t.Fatalf("unexpected Windows alias target %q", alias)
				}
				t.Logf("os.Root accepts synthetic protected-file alias %q; local policy rejects it", alias)
			} else {
				t.Logf("os.Root itself rejects synthetic alias %q", alias)
			}
		}
	}
}

func TestLocalModelPolicyAndPersistentResume(t *testing.T) {
	for _, mode := range []string{"readonly", "allow", "allow-unlisted", "ask"} {
		t.Run(mode, func(t *testing.T) {
			c, path, workspace := localConfig(t)
			os.WriteFile(filepath.Join(workspace, "main.txt"), []byte("before\n"), 0600)
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+localKey {
					t.Error("incorrect synthetic credential")
				}
				body, _ := io.ReadAll(r.Body)
				if requests.Load() >= 2 && !strings.Contains(string(body), "tool_call_id") {
					t.Error("resume did not restore completed tool pair")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if requests.Add(1) == 1 {
					_, _ = io.WriteString(w, localEvent(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "patch-once", "type": "function", "function": map[string]any{"name": "apply_patch", "arguments": `{"path":"main.txt","before":"before","after":"after"}`}}}}, nil)+localEvent(map[string]any{}, "tool_calls")+"data: [DONE]\n\n")
				} else {
					_, _ = io.WriteString(w, localTextResponse("done"))
				}
			}))
			defer server.Close()
			c.Provider.Endpoint = server.URL + "/chat/completions"
			c.Tools.Mode = mode
			if mode == "allow-unlisted" {
				c.Tools.Mode, c.Tools.AllowedTools = "allow", []string{"create_file"}
			} else if mode == "allow" {
				c.Tools.AllowedTools = []string{"apply_patch"}
			}
			s, err := OpenLocal(c, localEnvironment, path)
			if err != nil {
				t.Fatal(err)
			}
			run, err := s.Start(context.Background(), domain.StartRequest{Workspace: workspace, Prompt: "change source"})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "ask" {
				p := pendingApproval(t, waitFor(t, s, run.SessionID, domain.AwaitingApproval))
				if _, err := s.Start(context.Background(), domain.StartRequest{Workspace: workspace, Prompt: "overlap"}); err == nil {
					t.Fatal("concurrent local writes permitted in overlapping workspace")
				}
				if err := resolve(s, p, true); err != nil {
					t.Fatal(err)
				}
			}
			snap := waitFor(t, s, run.SessionID, domain.Completed)
			want, tools := "before\n", 0
			if mode == "allow" || mode == "ask" {
				want, tools = "after\n", 1
			}
			got, _ := os.ReadFile(filepath.Join(workspace, "main.txt"))
			if string(got) != want || snap.Runs[0].ToolsExecuted != tools || snap.Runs[0].ModelRequests != 2 {
				t.Fatalf("policy or execution count mismatch: content=%q run=%+v", got, snap.Runs[0])
			}
			if len(s.ForUser(session.DefaultOwnerID).List()) != 0 {
				t.Fatal("HTTP user could enumerate CLI histories")
			}
			if _, err := s.ForUser(session.DefaultOwnerID).Get(run.SessionID); err == nil {
				t.Fatal("HTTP user could read CLI history")
			}
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}
			if web, err := Open(filepath.Join(c.DataDir, "cli-v1")); err == nil {
				web.Close()
				t.Fatal("web opened local database")
			}
			s, err = OpenLocal(c, localEnvironment, path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if _, err := s.Continue(context.Background(), run.SessionID, "continue"); err != nil {
				t.Fatal(err)
			}
			snap = waitFor(t, s, run.SessionID, domain.Completed)
			if len(snap.Runs) != 2 || snap.Session.Workspace != workspace || snap.Runs[1].ModelRequests != 1 {
				t.Fatalf("resume lost history or workspace: %+v", snap)
			}
			if _, err := os.Stat(filepath.Join(c.DataDir, "cli-v1", "model-settings.json")); !os.IsNotExist(err) {
				t.Fatal("local runtime persisted model settings")
			}
		})
	}
}

func TestLocalRecoveryRootRevalidationAndMissingCredential(t *testing.T) {
	c, path, workspace := localConfig(t)
	s, err := OpenLocal(c, localEnvironment, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{"relative", t.TempDir(), c.DataDir} {
		if _, err := s.Start(context.Background(), domain.StartRequest{Workspace: root, Prompt: "inspect"}); err == nil {
			t.Fatalf("invalid root accepted: %s", root)
		}
	}
	for _, secret := range []string{localKey, localToken} {
		if _, err := s.Start(context.Background(), domain.StartRequest{Workspace: workspace, Prompt: secret}); err == nil {
			t.Fatal("credential prompt persisted")
		}
	}
	now := time.Now().UTC()
	snap := &Snapshot{OwnerID: session.DefaultOwnerID, Session: domain.Session{Version: domain.SchemaVersion, ID: "recover", Workspace: workspace, CreatedAt: now, UpdatedAt: now, ModelRef: "deepseek", Status: domain.Running}, Runs: []domain.Run{{ID: "old-run", SessionID: "recover", Status: domain.Running}}, Tools: []ToolEntry{{RunID: "old-run", Call: domain.ToolCall{ID: "unknown-write", Name: "apply_patch", Status: domain.ToolRunning}}}}
	s.sessions[snap.Session.ID] = snap
	if err := s.recordLocked(snap, domain.ToolStarted, domain.EventData{}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	c.WorkspaceRoots = []string{t.TempDir()}
	s, err = OpenLocal(c, localEnvironment, path)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get("recover")
	if got.Session.Status != domain.Interrupted || got.Tools[0].Call.Status != domain.ToolUnknown || got.Runs[0].EndReason != domain.EndInterrupted {
		t.Fatalf("recovery status: %+v", got)
	}
	if _, err := s.Continue(context.Background(), "recover", "continue"); err == nil {
		t.Fatal("resume ignored revoked workspace root")
	}
	s.Close()
	c.WorkspaceRoots = []string{workspace}
	s, err = OpenLocal(c, func(string) (string, bool) { return "", false }, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if len(s.List()) != 1 || s.ModelReady() {
		t.Fatal("offline history access unavailable")
	}
	if _, err := s.Start(context.Background(), domain.StartRequest{Workspace: workspace, Prompt: "inspect"}); err == nil {
		t.Fatal("missing credential run accepted")
	}
}

func TestLocalTokenCannotPersistThroughModelStreamOrToolArguments(t *testing.T) {
	for _, asTool := range []bool{false, true} {
		t.Run(fmt.Sprint(asTool), func(t *testing.T) {
			c, path, workspace := localConfig(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				if asTool {
					args := `{"path":"main.txt","content":"\u0073ynthetic-private-web-token"}`
					_, _ = io.WriteString(w, localEvent(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "unsafe", "type": "function", "function": map[string]any{"name": "create_file", "arguments": args}}}}, nil)+localEvent(map[string]any{}, "tool_calls")+"data: [DONE]\n\n")
				} else {
					_, _ = io.WriteString(w, localEvent(map[string]any{"content": localToken[:10]}, nil)+localEvent(map[string]any{"content": localToken[10:]}, nil)+localEvent(map[string]any{}, "stop")+"data: [DONE]\n\n")
				}
			}))
			defer server.Close()
			c.Provider.Endpoint = server.URL + "/chat/completions"
			s, err := OpenLocal(c, localEnvironment, path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			run, err := s.Start(context.Background(), domain.StartRequest{Workspace: workspace, Prompt: "inspect"})
			if err != nil {
				t.Fatal(err)
			}
			status := domain.Completed
			if asTool {
				status = domain.Failed
			}
			snap := waitFor(t, s, run.SessionID, status)
			if asTool && len(snap.Tools) != 0 {
				t.Fatal("protected model call reached tool proposal")
			}
			bodies, _ := s.store.Load(context.Background())
			events, _ := s.store.Events(context.Background(), run.SessionID, 0)
			encoded, _ := json.Marshal(events)
			for _, body := range append(bodies, encoded) {
				if containsProtectedJSON(body, []string{localKey, localToken}) {
					t.Fatal("credential reached snapshots or event stream")
				}
			}
		})
	}
}

func TestLocalWorkspaceLeaseAcrossConfigsReleasesOnCancellationAndCompletion(t *testing.T) {
	c, path, workspace := localConfig(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if requests.Add(1) == 1 {
			_, _ = io.WriteString(w, localEvent(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "write", "type": "function", "function": map[string]any{"name": "create_file", "arguments": `{"path":"new.txt","content":"safe"}`}}}}, nil)+localEvent(map[string]any{}, "tool_calls")+"data: [DONE]\n\n")
		} else {
			_, _ = io.WriteString(w, localTextResponse("done"))
		}
	}))
	defer server.Close()
	c.Provider.Endpoint, c.Tools.Mode = server.URL+"/chat/completions", "ask"
	first, err := OpenLocal(c, localEnvironment, path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	secondConfig := c
	secondConfig.DataDir = filepath.Join(filepath.Dir(path), "second-data")
	second, err := OpenLocal(secondConfig, localEnvironment, path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	req := domain.StartRequest{Workspace: workspace, Prompt: "create"}
	run, err := first.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, first, run.SessionID, domain.AwaitingApproval)
	if _, err := second.Start(context.Background(), req); err == nil {
		t.Fatal("same workspace concurrently opened using another data directory")
	}
	if err := first.Cancel(context.Background(), run.SessionID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, first, run.SessionID, domain.Cancelled)
	if _, err := os.Stat(filepath.Join(workspace, "new.txt")); !os.IsNotExist(err) {
		t.Fatal("cancelled approval changed disk")
	}
	secondRun, err := second.Start(context.Background(), req)
	if err != nil {
		t.Fatalf("cancelled run retained workspace lease: %v", err)
	}
	waitFor(t, second, secondRun.SessionID, domain.Completed)
	if _, err := first.Continue(context.Background(), run.SessionID, "continue"); err != nil {
		t.Fatalf("completed run retained workspace lease: %v", err)
	}
	waitFor(t, first, run.SessionID, domain.Completed)
}

func TestLocalMissingAncestorsCannotSkipAliasValidation(t *testing.T) {
	base := t.TempDir()
	for _, name := range []string{"state.", "state ", "STATE~1", "NUL.txt"} {
		if err := noLinkComponents(filepath.Join(base, "not-created", name, "child"), true); err == nil {
			t.Fatalf("unsupported name after a missing ancestor accepted: %q", name)
		}
	}
	if err := noLinkComponents(filepath.Join(base, "not-created", "safe", "child"), true); err != nil {
		t.Fatal(err)
	}
}

func TestLocalPatchPreservesExecutableFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits")
	}
	c, configPath, workspace := localConfig(t)
	s, err := OpenLocal(c, localEnvironment, configPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	name := filepath.Join(workspace, "run.sh")
	if err := os.WriteFile(name, []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(name, 0755); err != nil {
		t.Fatal(err)
	}
	f, err := s.localFiles(workspace)
	if err != nil {
		t.Fatal(err)
	}
	defer f.root.Close()
	call := domain.ToolCall{ID: "change-script", Name: "apply_patch", Arguments: json.RawMessage(`{"path":"run.sh","before":"exit 1","after":"exit 0"}`)}
	validated, err := f.Validate(context.Background(), call)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Execute(context.Background(), validated); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(name)
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("executable file permissions changed: info=%v error=%v", info, err)
	}
	content, err := os.ReadFile(name)
	if err != nil || string(content) != "#!/bin/sh\nexit 0\n" {
		t.Fatalf("patch failed: content=%q error=%v", content, err)
	}
}
