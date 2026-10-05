package task

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fishinggoing/agent-continue/internal/domain"
)

func TestUploadedCodePatchAndCreate(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	f := &Files{root: root, generic: true}
	if err := writeUpload(root, FileInput{Path: "src/main.go", Content: "package main\n// original user edit\nfunc add(a,b int) int { return a-b }\n"}); err != nil {
		t.Fatal(err)
	}
	p := Patch{Path: "src/main.go", Before: "return a-b", After: "return a+b"}
	b, _ := json.Marshal(p)
	call, err := f.Validate(context.Background(), domain.ToolCall{ID: "patch", Name: "apply_patch", Arguments: b})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Execute(context.Background(), call); err != nil {
		t.Fatal(err)
	}
	text, _ := f.Read(p.Path)
	if !strings.Contains(text, "original user edit") || !strings.Contains(text, "return a+b") {
		t.Fatal("did not preserve current code")
	}
	if _, err := f.Execute(context.Background(), call); err == nil {
		t.Fatal("stale patch accepted")
	}
	call, err = f.Validate(context.Background(), domain.ToolCall{ID: "create", Name: "create_file", Arguments: json.RawMessage(`{"path":"src/new.go","content":"package main\n"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Execute(context.Background(), call); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Execute(context.Background(), call); err == nil {
		t.Fatal("overwrote existing file")
	}
	for _, name := range []string{"../secret", "/tmp/file", "C:/secret", ".env", "keys/auth.key", "a/../b", "a\\b"} {
		if _, err := f.Read(name); err == nil || validPath(name) {
			t.Fatalf("unsafe path %s", name)
		}
	}
	call, err = f.Validate(context.Background(), domain.ToolCall{ID: "test", Name: "run_tests", Arguments: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Execute(context.Background(), call); err == nil {
		t.Fatal("ran demo tests in a real workspace")
	}
}

func TestModelSettingsPersistenceAndNoCredentialExport(t *testing.T) {
	s := openTestService(t)
	key := "synthetic-hyperion-credential"
	if err := s.ConfigureModel("gpt-6.1-sol", key); err != nil {
		t.Fatal(err)
	}
	if !s.ModelReady() || s.ProviderID() != "hyperion" {
		t.Fatal("model settings were not applied")
	}
	run, err := s.Start(context.Background(), domain.StartRequest{Prompt: "Fix pricing", ModelRef: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	snap := waitFor(t, s, run.SessionID, domain.AwaitingApproval)
	b, _ := json.Marshal(snap)
	if strings.Contains(string(b), key) {
		t.Fatal("credential included in session export")
	}
	dir := s.dir
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if !reopened.ModelReady() || reopened.ModelID() != "gpt-6.1-sol" {
		t.Fatal("model configuration lost on restart")
	}
	if info, err := os.Stat(filepath.Join(dir, "model-settings.json")); err != nil || !info.Mode().IsRegular() {
		t.Fatal("private settings file absent")
	}
}
