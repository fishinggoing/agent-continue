package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fishinggoing/agent-continue/internal/app"
	"github.com/fishinggoing/agent-continue/internal/migrate"
)

const testToken = "synthetic-server-access-token"

func localTestRequest(method, path string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, path, body)
	r.RemoteAddr = "127.0.0.1:12345"
	r.Host = "localhost"
	return r
}

func upload(t *testing.T, handler http.Handler, endpoint string, fields map[string]string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "source.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(data); err != nil {
		t.Fatal(err)
	}
	for key, value := range fields {
		if err = writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := localTestRequest("POST", endpoint, &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func demoData(t *testing.T, handler http.Handler) []byte {
	t.Helper()
	r := localTestRequest("GET", "/api/demo", nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("demo: %d %s", w.Code, w.Body.String())
	}
	return w.Body.Bytes()
}

func TestAuthenticationOriginsAndStaticAssets(t *testing.T) {
	handler := New(testToken)
	for _, c := range []struct {
		path, token, origin, site string
		code                      int
	}{
		{"/", "", "", "", 200},
		{"/lucide.min.js", "", "", "", 200},
		{"/healthz", "", "", "", 200},
		{"/api/demo", "", "", "", 401},
		{"/api/demo", "invalid", "", "", 401},
		{"/api/demo", testToken, "https://other.example", "", 403},
		{"/api/demo", testToken, "", "cross-site", 403},
		{"/api/demo", testToken, "http://localhost", "same-origin", 200},
		{"/server.go", "", "", "", 404},
	} {
		r := localTestRequest("GET", c.path, nil)
		if c.token != "" {
			r.Header.Set("Authorization", "Bearer "+c.token)
		}
		r.Header.Set("Origin", c.origin)
		r.Header.Set("Sec-Fetch-Site", c.site)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != c.code {
			t.Errorf("%s: got %d, want %d", c.path, w.Code, c.code)
		}
		if w.Header().Get("Content-Security-Policy") == "" || w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("security headers missing on %s", c.path)
		}
	}
}

func TestUploadInspectPlanConvertAndReverse(t *testing.T) {
	handler := New(testToken)
	data := demoData(t, handler)
	fields := map[string]string{"from": "codex", "cwd": "/target/project", "id": "22222222-2222-4222-8222-222222222222"}
	for _, endpoint := range []string{"inspect", "plan", "convert"} {
		w := upload(t, handler, "/api/"+endpoint, fields, data)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", endpoint, w.Code, w.Body.String())
		}
		var result struct {
			Report   map[string]any
			Artifact struct{ Name, Data, Sha256, Harness string }
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Report["toolsExecuted"] != float64(0) {
			t.Fatal("unexpected tool execution")
		}
		if strings.Contains(w.Body.String(), "合成示例") {
			t.Fatal("report leaked message bodies")
		}
		if endpoint != "convert" {
			if result.Artifact.Data != "" {
				t.Fatal("inspect/plan exposed artifact")
			}
			continue
		}
		artifact, err := base64.StdEncoding.DecodeString(result.Artifact.Data)
		if err != nil {
			t.Fatal(err)
		}
		if app.Hash(artifact) != result.Artifact.Sha256 {
			t.Fatal("artifact checksum mismatch")
		}
		source, err := migrate.ParseSource(result.Artifact.Harness, result.Artifact.Name, artifact)
		if err != nil {
			t.Fatal(err)
		}
		if source.Cwd() != fields["cwd"] || source.Header["id"] != fields["id"] {
			t.Fatal("target identity differs from plan")
		}
		decoded, err := migrate.DecodeFrames(artifact)
		if err != nil {
			t.Fatal(err)
		}
		reverse := upload(t, handler, "/api/convert", map[string]string{"from": "dsh", "cwd": "/target/project", "cliVersion": "synthetic-cli", "modelProvider": "synthetic-provider"}, decoded)
		if reverse.Code != 200 {
			t.Fatalf("reverse: %d %s", reverse.Code, reverse.Body.String())
		}
	}
}

func TestMalformedUploadsAndBusyServer(t *testing.T) {
	handler := New(testToken)
	data := demoData(t, handler)
	for _, c := range []struct {
		fields map[string]string
		data   []byte
		code   int
	}{
		{map[string]string{"from": "codex", "target-home": "/host/path"}, data, 400},
		{map[string]string{"from": "invalid"}, data, 422},
		{map[string]string{"from": "codex"}, []byte("private malformed message"), 422},
		{map[string]string{"from": "codex"}, nil, 400},
		{map[string]string{"from": "codex", "cwd": "relative"}, data, 422},
	} {
		w := upload(t, handler, "/api/convert", c.fields, c.data)
		if w.Code != c.code {
			t.Errorf("got %d want %d: %s", w.Code, c.code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "private malformed") {
			t.Fatal("parse diagnostic leaked source")
		}
	}
	s := &Server{slots: make(chan struct{}, 1)}
	s.slots <- struct{}{}
	w := httptest.NewRecorder()
	s.api(w, httptest.NewRequest("POST", "/api/convert", io.NopCloser(strings.NewReader(""))))
	if w.Code != 429 {
		t.Fatalf("busy server status = %d", w.Code)
	}
}
