package server

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fishinggoing/agent-continue/internal/app"
	"github.com/fishinggoing/agent-continue/internal/migrate"
	_ "modernc.org/sqlite"
)

func TestWebDshConversionCarriesMetadataThroughCodexInstall(t *testing.T) {
	cwd := t.TempDir()
	const model = "web-synthetic-model"
	const title = "Web imported DSH title"

	handler := New(testToken)
	data := metadataDSHArtifact(t, cwd)
	response := metadataUpload(t, handler, "source-session.v4.jsonl.zstd", map[string]string{
		"from":          "dsh",
		"cwd":           cwd,
		"cliVersion":    "synthetic-cli",
		"modelProvider": "synthetic-provider",
		"model":         model,
		"title":         title,
	}, data)
	if response.Code != http.StatusOK {
		t.Fatalf("web conversion: %d %s", response.Code, response.Body.String())
	}

	var result struct {
		Report   map[string]any `json:"report"`
		Artifact struct {
			Name    string `json:"name"`
			Data    string `json:"data"`
			Sha256  string `json:"sha256"`
			Harness string `json:"harness"`
			Cwd     string `json:"cwd"`
			Model   string `json:"model"`
			Title   string `json:"title"`
		} `json:"artifact"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode conversion response: %v", err)
	}
	if result.Artifact.Harness != "codex" || result.Artifact.Cwd != cwd || result.Artifact.Model != model || result.Artifact.Title != title {
		t.Fatalf("web artifact metadata = %#v, want codex/%q/%q/%q", result.Artifact, cwd, model, title)
	}
	target, ok := result.Report["target"].(map[string]any)
	if !ok || target["model"] != model || target["title"] != title {
		t.Fatalf("web report target = %#v, want model %q/title %q", result.Report["target"], model, title)
	}
	artifact, err := base64.StdEncoding.DecodeString(result.Artifact.Data)
	if err != nil {
		t.Fatalf("decode web artifact: %v", err)
	}
	if app.Hash(artifact) != result.Artifact.Sha256 {
		t.Fatalf("web artifact checksum mismatch")
	}
	source, err := migrate.ParseSource("codex", result.Artifact.Name, artifact)
	if err != nil {
		t.Fatalf("parse web Codex artifact: %v", err)
	}
	if source.Cwd() != cwd || len(source.Records) == 0 {
		t.Fatalf("converted source cwd/records = %q/%d, want %q/nonzero", source.Cwd(), len(source.Records), cwd)
	}
	meta, ok := source.Records[0]["payload"].(map[string]any)
	if !ok {
		t.Fatalf("converted session_meta payload = %#v", source.Records[0]["payload"])
	}
	id, ok := meta["id"].(string)
	if !ok || id == "" {
		t.Fatalf("converted Codex metadata id = %#v", meta["id"])
	}

	artifactPath := filepath.Join(t.TempDir(), result.Artifact.Name)
	if err := os.WriteFile(artifactPath, artifact, 0600); err != nil {
		t.Fatalf("write converted artifact: %v", err)
	}
	codexHome := t.TempDir()
	initMetadataCodexHome(t, codexHome)
	installed, err := app.Execute([]string{
		"install", "--from", "codex", "--input", artifactPath, "--cwd", cwd,
		"--target-home", codexHome, "--model", model, "--title", title,
	})
	if err != nil {
		t.Fatalf("install converted web artifact: %v", err)
	}
	installedPath, ok := installed["output"].(map[string]any)["path"].(string)
	if !ok || installedPath == "" {
		t.Fatalf("install output path = %#v", installed["output"])
	}
	if _, err := os.Stat(installedPath); err != nil {
		t.Fatalf("installed rollout missing: %v", err)
	}

	db, err := sql.Open("sqlite", filepath.Join(codexHome, "state_5.sqlite"))
	if err != nil {
		t.Fatalf("open installed registry: %v", err)
	}
	defer db.Close()
	var gotModel, gotTitle, gotPath string
	if err := db.QueryRow("SELECT model, title, rollout_path FROM threads WHERE id = ?", id).Scan(&gotModel, &gotTitle, &gotPath); err != nil {
		t.Fatalf("read installed registry row: %v", err)
	}
	if gotModel != model || gotTitle != title || filepath.Clean(gotPath) != filepath.Clean(installedPath) {
		t.Fatalf("installed metadata = model %q/title %q/path %q, want %q/%q/%q", gotModel, gotTitle, gotPath, model, title, installedPath)
	}
}

func TestDshInstallCanonicalizesHeaderCwdAndProjectPath(t *testing.T) {
	canonical := t.TempDir()
	separator := string(filepath.Separator)
	aliased := canonical + separator + "child" + separator + ".." + separator + "." + separator
	if filepath.Clean(aliased) != filepath.Clean(canonical) || aliased == canonical {
		t.Fatalf("test alias is not a distinct spelling of cwd: %q vs %q", aliased, canonical)
	}

	inputPath := filepath.Join(t.TempDir(), "source-session.v4.jsonl.zstd")
	if err := os.WriteFile(inputPath, metadataDSHArtifact(t, aliased), 0600); err != nil {
		t.Fatalf("write aliased DSH artifact: %v", err)
	}
	home := t.TempDir()
	result, err := app.Execute([]string{
		"install", "--from", "dsh", "--input", inputPath, "--cwd", canonical,
		"--target-home", home,
	})
	if err != nil {
		t.Fatalf("install aliased DSH artifact: %v", err)
	}
	installedPath, ok := result["output"].(map[string]any)["path"].(string)
	if !ok || installedPath == "" {
		t.Fatalf("install output path = %#v", result["output"])
	}
	installed, err := app.ReadSource("dsh", installedPath)
	if err != nil {
		t.Fatalf("parse installed DSH artifact: %v", err)
	}
	if got := installed.Header["cwd"]; got != canonical {
		t.Fatalf("installed DSH header cwd = %#v, want canonical %q", got, canonical)
	}
	expectedProjectPath := filepath.Join(home, "sessions", app.ProjectKey(canonical))
	actualProjectPath := filepath.Dir(filepath.Dir(installedPath))
	if filepath.Clean(actualProjectPath) != filepath.Clean(expectedProjectPath) {
		t.Fatalf("installed project path = %q, want %q", actualProjectPath, expectedProjectPath)
	}
}

func metadataUpload(t *testing.T, handler http.Handler, filename string, fields map[string]string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body strings.Builder
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := localTestRequest(http.MethodPost, "/api/convert", strings.NewReader(body.String()))
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func metadataDSHArtifact(t *testing.T, cwd string) []byte {
	t.Helper()
	header := migrate.Object{
		"type": "session", "version": 4, "id": "33333333-3333-4333-8333-333333333333",
		"createdAt": float64(1791072000000), "cwd": cwd, "isSeeded": false, "delegationDepth": 0,
	}
	events := []migrate.Object{
		{"type": "turn/start", "seq": 0, "time": float64(1791072000000), "data": migrate.Object{"turn": 1}},
		{"type": "step/start", "seq": 1, "time": float64(1791072000001), "data": migrate.Object{"turn": 1, "step": 1}},
		{"type": "user/message", "seq": 2, "time": float64(1791072000002), "data": migrate.Object{
			"id": "metadata-user", "role": "user", "content": []any{migrate.Object{"type": "text", "text": "metadata probe"}}, "source": migrate.Object{"kind": "user"},
		}, "surfaceOp": "append"},
		{"type": "assistant/message", "seq": 3, "time": float64(1791072000003), "data": migrate.Object{
			"turn": 1, "step": 1, "stream": []any{}, "message": migrate.Object{
				"id": "metadata-assistant", "role": "assistant", "source": migrate.Object{"kind": "model", "provider": "synthetic-provider", "model": "synthetic-model"},
				"content": []any{migrate.Object{"type": "text", "text": "metadata answer"}},
			},
		}, "surfaceOp": "append"},
		{"type": "step/end", "seq": 4, "time": float64(1791072000004), "data": migrate.Object{"turn": 1, "step": 1}},
		{"type": "turn/end", "seq": 5, "time": float64(1791072000005), "data": migrate.Object{"turn": 1, "reason": migrate.Object{"kind": "completed"}}},
	}
	data, err := migrate.EncodeDSH(header, events)
	if err != nil {
		t.Fatalf("encode metadata DSH artifact: %v", err)
	}
	return data
}

func initMetadataCodexHome(t *testing.T, home string) {
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
