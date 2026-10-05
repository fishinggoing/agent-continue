package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigCommandsAndLocalModels(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	env := func(name string) (string, bool) {
		if name == "DEEPSEEK_API_KEY" {
			return "synthetic-key-never-print", true
		}
		return "", false
	}
	var stdout bytes.Buffer
	for _, args := range [][]string{
		{"config", "init", "--config", path, "--cwd", dir},
		{"config", "show", "--config", path},
		{"config", "check", "--config", path},
		{"models", "list", "--config", path},
		{"doctor", "--config", path},
		{"version"},
	} {
		stdout.Reset()
		handled, err := Execute(args, &stdout, env)
		if !handled || err != nil || !json.Valid(stdout.Bytes()) {
			t.Fatalf("%v: handled=%v, err=%v, output=%q", args, handled, err, stdout.String())
		}
		if strings.Contains(stdout.String(), "synthetic-key-never-print") {
			t.Fatal("key exposed")
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); !os.IsNotExist(err) {
		t.Fatal("doctor created persistent state")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatal("doctor left probe files behind")
	}
}

func TestNewParserAndMigrationDispatch(t *testing.T) {
	env := func(string) (string, bool) { return "", false }
	for _, args := range [][]string{
		{"config"}, {"config", "unknown"}, {"models"}, {"models", "discover"},
		{"version", "--config", "x"}, {"doctor", "--model", "x"},
		{"config", "show", "--config"}, {"config", "show", "--config", "one", "--config", "two"},
		{"config", "show", "--config=x"}, {"config", "init", "--api-key", "synthetic-secret"},
	} {
		var stdout bytes.Buffer
		handled, err := Execute(args, &stdout, env)
		if !handled || err == nil || stdout.Len() != 0 {
			t.Fatalf("%v: handled=%v, err=%v", args, handled, err)
		}
		if strings.Contains(err.Error(), "synthetic-secret") {
			t.Fatal("invalid option echoed a credential")
		}
	}
	for _, args := range [][]string{nil, {"help"}, {"inspect"}, {"migrate"}, {"install"}, {"serve"}, {"unknown"}} {
		if handled, err := Execute(args, &bytes.Buffer{}, env); handled || err != nil {
			t.Fatalf("legacy dispatch changed: %v", args)
		}
	}
}

func TestReadinessFailureStillProducesMachineReadableReport(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	env := func(string) (string, bool) { return "", false }
	if _, err := Execute([]string{"config", "init", "--config", path, "--cwd", dir}, &bytes.Buffer{}, env); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	if handled, err := Execute([]string{"config", "check", "--config", path}, &stdout, env); !handled || err == nil {
		t.Fatal("missing credential accepted")
	}
	var report struct {
		Ready bool `json:"ready"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil || report.Ready {
		t.Fatal("readiness report is invalid")
	}
}
