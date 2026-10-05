package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/task"
)

func taskRequest(h http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := localTestRequest(method, path, bytes.NewBufferString(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://localhost")
	if cookie != nil {
		r.AddCookie(cookie)
	} else {
		r.Header.Set("Authorization", "Bearer "+testToken)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestWorkbenchLoginAndTaskHTTPContract(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	s, err := task.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := NewWithTasks(testToken, s)
	login := taskRequest(h, "POST", "/api/connect", `{"token":"synthetic-server-access-token"}`, nil)
	if login.Code != 200 {
		t.Fatal(login.Body.String())
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("insecure session cookie")
	}
	w := taskRequest(h, "GET", "/api/workbench", "", cookies[0])
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	cookie := *cookies[0]
	cookie.Value += "changed"
	if w = taskRequest(h, "GET", "/api/sessions", "", &cookie); w.Code != 401 {
		t.Fatal("forged cookie accepted")
	}
	for _, body := range []string{`{"prompt":"x","workspace":"/"}`, `{"prompt":"x","mode":"deepseek"}`, `{"prompt":"","mode":"demo"}`} {
		w = taskRequest(h, "POST", "/api/sessions", body, cookies[0])
		if w.Code < 400 {
			t.Fatalf("accepted invalid request: %s", body)
		}
	}
	w = taskRequest(h, "POST", "/api/sessions", `{"prompt":"Fix pricing","mode":"demo"}`, cookies[0])
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var run domain.Run
	json.Unmarshal(w.Body.Bytes(), &run)
	var snap task.Snapshot
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		snap, _ = s.Get(run.SessionID)
		if snap.Session.Status == domain.AwaitingApproval {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if snap.Session.Status != domain.AwaitingApproval {
		t.Fatal("approval not reached")
	}
	w = taskRequest(h, "GET", "/api/sessions/"+run.SessionID+"/file?path=../secret", "", cookies[0])
	if w.Code < 400 {
		t.Fatal("path escape accepted")
	}
	w = taskRequest(h, "GET", "/api/sessions/"+run.SessionID+"/export", "", cookies[0])
	if w.Code != 200 || w.Header().Get("Content-Disposition") == "" {
		t.Fatal("missing export")
	}
	w = taskRequest(h, "GET", "/api/sessions/unknown", "", cookies[0])
	if w.Code != 404 {
		t.Fatal("unknown session code")
	}
	w = taskRequest(h, "GET", "/api/sessions/"+run.SessionID+"/events?after=invalid", "", cookies[0])
	if w.Code != 400 {
		t.Fatal("invalid cursor accepted")
	}
}

func TestLoginCookieScopedToACProxyPrefix(t *testing.T) {
	r := localTestRequest("POST", "/api/connect", bytes.NewBufferString(`{"token":"synthetic-server-access-token"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Forwarded-Prefix", "/ac/")
	r.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	NewWithOptions(testToken, nil, Options{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}).ServeHTTP(w, r)
	cookies := w.Result().Cookies()
	if w.Code != 200 || len(cookies) != 1 || cookies[0].Path != "/ac/" || !cookies[0].Secure || !cookies[0].HttpOnly {
		t.Fatal("proxy login cookie must be scoped to /ac/ and secure on HTTPS")
	}
}
