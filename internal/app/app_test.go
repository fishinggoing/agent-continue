package app

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fishinggoing/agent-continue/internal/migrate"
	"github.com/klauspost/compress/zstd"
	_ "modernc.org/sqlite"
)

const (
	testTimestamp = "2026-10-04T00:00:00.000Z"
	testSourceID  = "11111111-1111-4111-8111-111111111111"
	testTargetID  = "22222222-2222-4222-8222-222222222222"
)

func TestExecuteDryRunAndExclusiveDSHWrite(t *testing.T) {
	cwd := testDirectory(t, "workspace")
	source := writeCodexSource(t, cwd, testSourceID, "dry-run sentinel")
	home := filepath.Join(t.TempDir(), "dsh-home")
	args := []string{
		"migrate", "--from", "codex", "--input", source, "--cwd", cwd,
		"--target-home", home, "--id", testTargetID,
	}

	planned, err := Execute(append(append([]string{}, args...), "--dry-run"))
	if err != nil {
		t.Fatalf("dry-run: %v", err)
	}
	if planned["status"] != "planned" {
		t.Fatalf("dry-run status = %#v", planned["status"])
	}
	plannedPath := text(object(planned["output"])["path"])
	if plannedPath == "" {
		t.Fatal("dry-run did not report an output path")
	}
	if _, err := os.Stat(plannedPath); !os.IsNotExist(err) {
		t.Fatalf("dry-run created %q: %v", plannedPath, err)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("dry-run created target home %q: %v", home, err)
	}

	written, err := Execute(args)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if written["status"] != "written" {
		t.Fatalf("write status = %#v", written["status"])
	}
	path := text(object(written["output"])["path"])
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read written artifact: %v", err)
	}
	if len(before) == 0 {
		t.Fatal("written artifact is empty")
	}

	if _, err := Execute(args); err == nil || !strings.Contains(err.Error(), "overwrite") {
		t.Fatalf("duplicate write error = %v, want overwrite refusal", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read artifact after duplicate attempt: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("duplicate write changed the existing artifact")
	}
}

func TestExecuteDSHMigrationRegistersAndRefusesDuplicateID(t *testing.T) {
	cwd := testDirectory(t, "workspace")
	source := writeDSHSource(t, cwd, testSourceID)
	home := t.TempDir()
	initCodexHome(t, home)
	args := []string{
		"migrate", "--from", "dsh", "--input", source, "--cwd", cwd,
		"--target-home", home, "--id", testTargetID, "--cli-version", "synthetic-cli",
		"--model-provider", "synthetic-provider", "--model", "synthetic-model", "--title", "Synthetic title",
	}

	result, err := Execute(args)
	if err != nil {
		t.Fatalf("DSH migration: %v", err)
	}
	path := text(object(result["output"])["path"])
	if path == "" {
		t.Fatal("migration did not report rollout path")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("rollout was not written: %v", err)
	}
	row := readThread(t, home, testTargetID)
	if row["id"] != testTargetID || row["rollout_path"] != path {
		t.Fatalf("registered thread = %#v, want id/path %q/%q", row, testTargetID, path)
	}

	if _, err := Execute(args); err == nil || !strings.Contains(err.Error(), "existing session artifact") {
		t.Fatalf("duplicate migration error = %v, want artifact refusal", err)
	}
	if countThreads(t, home, testTargetID) != 1 {
		t.Fatalf("duplicate migration changed registry row count")
	}
}

func TestExecuteInstallRoundTripBothDirections(t *testing.T) {
	cwd := testDirectory(t, "roundtrip")
	codexSource := writeCodexSource(t, cwd, testSourceID, "round-trip Codex text")
	dshHome := filepath.Join(t.TempDir(), "dsh-home")

	toDsh, err := Execute([]string{
		"migrate", "--from", "codex", "--input", codexSource, "--cwd", cwd,
		"--target-home", dshHome, "--id", testTargetID,
	})
	if err != nil {
		t.Fatalf("Codex -> DSH migration: %v", err)
	}
	dshArtifact := text(object(toDsh["output"])["path"])
	dshInstallHome := filepath.Join(t.TempDir(), "dsh-install")
	installedDSH, err := Execute([]string{
		"install", "--from", "dsh", "--input", dshArtifact, "--cwd", cwd,
		"--target-home", dshInstallHome,
	})
	if err != nil {
		t.Fatalf("DSH install: %v", err)
	}
	installedDSHPath := text(object(installedDSH["output"])["path"])
	if _, err := os.Stat(installedDSHPath); err != nil {
		t.Fatalf("installed DSH artifact missing: %v", err)
	}
	parsedDSH, err := ReadSource("dsh", installedDSHPath)
	if err != nil {
		t.Fatalf("parse installed DSH artifact: %v", err)
	}
	if parsedDSH.Header["id"] != testTargetID || parsedDSH.Cwd() != cwd {
		t.Fatalf("installed DSH identity = %q/%q", parsedDSH.Header["id"], parsedDSH.Cwd())
	}

	dshSource := writeDSHSource(t, cwd, testSourceID)
	codexHome := t.TempDir()
	initCodexHome(t, codexHome)
	toCodex, err := Execute([]string{
		"migrate", "--from", "dsh", "--input", dshSource, "--cwd", cwd,
		"--target-home", codexHome, "--id", testTargetID, "--cli-version", "synthetic-cli",
		"--model-provider", "synthetic-provider",
	})
	if err != nil {
		t.Fatalf("DSH -> Codex migration: %v", err)
	}
	codexArtifact := text(object(toCodex["output"])["path"])
	codexInstallHome := t.TempDir()
	initCodexHome(t, codexInstallHome)
	installedCodex, err := Execute([]string{
		"install", "--from", "codex", "--input", codexArtifact, "--cwd", cwd,
		"--target-home", codexInstallHome,
	})
	if err != nil {
		t.Fatalf("Codex install: %v", err)
	}
	installedCodexPath := text(object(installedCodex["output"])["path"])
	if _, err := os.Stat(installedCodexPath); err != nil {
		t.Fatalf("installed Codex artifact missing: %v", err)
	}
	parsedCodex, err := ReadSource("codex", installedCodexPath)
	if err != nil {
		t.Fatalf("parse installed Codex artifact: %v", err)
	}
	if len(parsedCodex.Records) == 0 || object(parsedCodex.Records[0]["payload"])["id"] != testTargetID {
		t.Fatalf("installed Codex metadata did not retain target id")
	}
	if countThreads(t, codexInstallHome, testTargetID) != 1 {
		t.Fatal("Codex install did not register exactly one thread")
	}
}

func TestReadSourceRejectsTruncatedAndOversizedZstdFrames(t *testing.T) {
	cwd := testDirectory(t, "codec")
	valid := encodeDSH(t, cwd, testSourceID)
	truncatedPath := filepath.Join(t.TempDir(), "truncated-session.v4.jsonl.zstd")
	if err := os.WriteFile(truncatedPath, valid[:len(valid)-1], 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadSource("dsh", truncatedPath); err == nil || !strings.Contains(strings.ToLower(err.Error()), "incomplete") {
		t.Fatalf("truncated frame error = %v, want incomplete-frame refusal", err)
	}

	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1), zstd.WithSingleSegment(false), zstd.WithWindowSize(1024))
	if err != nil {
		t.Fatalf("zstd encoder: %v", err)
	}
	bomb := encoder.EncodeAll([]byte("compressed header probe"), nil)
	encoder.Close()
	var header zstd.Header
	if err := header.Decode(bomb); err != nil || header.SingleSegment {
		t.Fatalf("probe must include a window descriptor: %v", err)
	}
	// 2^(10 + 19) = 512 MiB, twice the configured decoder limit.
	bomb[5] = 19 << 3
	if _, err := migrate.DecodeFrames(bomb); err == nil {
		t.Fatal("oversized zstd window was accepted")
	}
}

func testDirectory(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeCodexSource(t *testing.T, cwd, id, textValue string) string {
	t.Helper()
	records := []Object{
		{"timestamp": testTimestamp, "ordinal": 0, "type": "session_meta", "payload": Object{"id": id, "cwd": cwd, "model_provider": "synthetic-provider"}},
		{"timestamp": testTimestamp, "ordinal": 1, "type": "event_msg", "payload": Object{"type": "task_started", "turn_id": "synthetic-turn"}},
		{"timestamp": testTimestamp, "ordinal": 2, "type": "response_item", "payload": Object{"type": "message", "id": "user-1", "role": "user", "content": []any{Object{"type": "input_text", "text": textValue}}}},
		{"timestamp": testTimestamp, "ordinal": 3, "type": "response_item", "payload": Object{"type": "message", "id": "assistant-1", "role": "assistant", "content": []any{Object{"type": "output_text", "text": "synthetic answer"}}}},
		{"timestamp": testTimestamp, "ordinal": 4, "type": "event_msg", "payload": Object{"type": "task_complete", "turn_id": "synthetic-turn"}},
	}
	return writeJSONLines(t, "source.jsonl", records)
}

func writeDSHSource(t *testing.T, cwd, id string) string {
	t.Helper()
	return writeDSH(t, "source-session.v4.jsonl.zstd", cwd, id)
}

func writeDSH(t *testing.T, filename, cwd, id string) string {
	t.Helper()
	header := Object{"type": "session", "version": 4, "id": id, "createdAt": float64(1791072000000), "cwd": cwd, "isSeeded": false, "delegationDepth": 0}
	events := []Object{
		{"type": "turn/start", "seq": 0, "time": float64(1791072000000), "data": Object{"turn": 1}},
		{"type": "step/start", "seq": 1, "time": float64(1791072000001), "data": Object{"turn": 1, "step": 1}},
		{"type": "user/message", "seq": 2, "time": float64(1791072000002), "data": Object{"id": "dsh-user", "role": "user", "content": []any{Object{"type": "text", "text": "synthetic DSH question"}}, "source": Object{"kind": "user"}}, "surfaceOp": "append"},
		{"type": "assistant/message", "seq": 3, "time": float64(1791072000003), "data": Object{"turn": 1, "step": 1, "stream": []any{}, "message": Object{"id": "dsh-assistant", "role": "assistant", "source": Object{"kind": "model", "provider": "synthetic-provider", "model": "synthetic-model"}, "content": []any{Object{"type": "text", "text": "synthetic DSH answer"}}}}, "surfaceOp": "append"},
		{"type": "step/end", "seq": 4, "time": float64(1791072000004), "data": Object{"turn": 1, "step": 1}},
		{"type": "turn/end", "seq": 5, "time": float64(1791072000005), "data": Object{"turn": 1, "reason": Object{"kind": "completed"}}},
	}
	data, err := migrate.EncodeDSH(header, events)
	if err != nil {
		t.Fatalf("encode DSH source: %v", err)
	}
	path := filepath.Join(t.TempDir(), filename)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func encodeDSH(t *testing.T, cwd, id string) []byte {
	t.Helper()
	path := writeDSH(t, "encoded-session.v4.jsonl.zstd", cwd, id)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func writeJSONLines(t *testing.T, filename string, records []Object) string {
	t.Helper()
	var b bytes.Buffer
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		b.Write(encoded)
		b.WriteByte('\n')
	}
	path := filepath.Join(t.TempDir(), filename)
	if err := os.WriteFile(path, b.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func initCodexHome(t *testing.T, home string) {
	t.Helper()
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(home, "state_5.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	columns := strings.Fields("id rollout_path created_at updated_at source model_provider cwd title sandbox_policy approval_mode tokens_used has_user_event archived cli_version first_user_message memory_mode model reasoning_effort created_at_ms updated_at_ms thread_source preview recency_at recency_at_ms history_mode is_pinned originator")
	definitions := make([]string, 0, len(columns))
	for _, column := range columns {
		kind := "TEXT"
		if strings.HasSuffix(column, "_at") || strings.HasSuffix(column, "_ms") || column == "created_at" || column == "updated_at" || column == "tokens_used" || column == "has_user_event" || column == "archived" || column == "is_pinned" {
			kind = "INTEGER"
		}
		if column == "id" {
			definitions = append(definitions, column+" "+kind+" PRIMARY KEY")
		} else {
			definitions = append(definitions, column+" "+kind)
		}
	}
	if _, err := db.Exec("CREATE TABLE threads (" + strings.Join(definitions, ", ") + ")"); err != nil {
		t.Fatal(err)
	}
}

func readThread(t *testing.T, home, id string) map[string]string {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(home, "state_5.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var got map[string]string
	var gotID, path, source, provider, cwd, title, cli string
	if err := db.QueryRow("SELECT id, rollout_path, source, model_provider, cwd, title, cli_version FROM threads WHERE id = ?", id).Scan(&gotID, &path, &source, &provider, &cwd, &title, &cli); err != nil {
		t.Fatal(err)
	}
	got = map[string]string{"id": gotID, "rollout_path": path, "source": source, "model_provider": provider, "cwd": cwd, "title": title, "cli_version": cli}
	return got
}

func countThreads(t *testing.T, home, id string) int {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(home, "state_5.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM threads WHERE id = ?", id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
