package server

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/task"
)

func TestNetworkTransportAndRebindingBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, token, host, peer, forwarded string
		tls, trusted                       bool
		status                             int
	}{
		{"direct local", "", "localhost:8080", "127.0.0.1:9000", "", false, false, 200},
		{"direct IPv6", "", "[::1]:8080", "[::1]:9000", "", false, false, 200},
		{"rebinding", "", "attacker.example:8080", "127.0.0.1:9000", "", false, false, 403},
		{"spoof local host", "", "localhost", "192.0.2.1:9000", "", false, false, 403},
		{"unauthenticated proxy", "", "public.example", "127.0.0.1:9000", "https", false, true, 403},
		{"public plaintext", testToken, "public.example", "192.0.2.1:9000", "", false, false, 403},
		{"forged HTTPS", testToken, "public.example", "192.0.2.1:9000", "https", false, false, 403},
		{"proxy plaintext with local host", testToken, "localhost", "127.0.0.1:9000", "http", false, true, 403},
		{"trusted proxy", testToken, "public.example", "127.0.0.1:9000", "https", false, true, 200},
		{"public TLS", testToken, "public.example", "192.0.2.1:9000", "", true, false, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			options := Options{}
			if tc.trusted {
				options.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
			}
			h := NewWithOptions(tc.token, nil, options)
			r := httptest.NewRequest("GET", "/api/demo", nil)
			r.Host, r.RemoteAddr = tc.host, tc.peer
			if tc.tls {
				r.TLS = &tls.ConnectionState{}
			}
			r.Header.Set("Authorization", "Bearer "+testToken)
			if tc.token == "" {
				r.Header.Del("Authorization")
			}
			r.Header.Set("X-Forwarded-Proto", tc.forwarded)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("HTTP %d, want %d", w.Code, tc.status)
			}
			if (tc.tls || tc.trusted && tc.forwarded == "https") && w.Header().Get("Strict-Transport-Security") == "" {
				t.Fatal("missing HSTS over HTTPS")
			}
		})
	}
	for _, value := range []string{"0.0.0.0/0", "::/0", "127.0.0.1", "invalid"} {
		if _, err := proxyOptions(value); err == nil {
			t.Fatal("invalid/wildcard proxy trust accepted")
		}
	}
}

func TestCookieWritesRequireSameOriginAndJSON(t *testing.T) {
	h := New(testToken)
	cookie := loginHTTPUser(t, h, testToken)
	for _, tc := range []struct {
		origin, site string
		status       int
	}{
		{"", "", 403},
		{"http://localhost", "", 200},
		{"", "same-origin", 200},
		{"https://localhost", "same-origin", 403},
		{"http://localhost/path", "same-origin", 403},
		{"http://localhost?x", "same-origin", 403},
		{"http://user@localhost", "same-origin", 403},
		{"null", "", 403},
		{"http://localhost", "same-site", 403},
	} {
		r := localTestRequest("POST", "/api/disconnect", nil)
		r.AddCookie(cookie)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Sec-Fetch-Site", tc.site)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("origin %q site %q: HTTP %d, want %d", tc.origin, tc.site, w.Code, tc.status)
		}
	}
	for _, media := range []string{"text/plain", "application/x-www-form-urlencoded", ""} {
		r := localTestRequest("POST", "/api/connect", strings.NewReader(`{"token":"`+testToken+`"}`))
		r.Header.Set("Content-Type", media)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 || len(w.Result().Cookies()) != 0 {
			t.Fatal("non-JSON login accepted")
		}
	}
}

func TestCookieExpiryRotationRestartAndProxyAttributes(t *testing.T) {
	s := &Server{token: testToken, security: newSecurityState()}
	login := func(old *http.Cookie) *http.Cookie {
		t.Helper()
		r := localTestRequest("POST", "/api/connect", strings.NewReader(`{"token":"`+testToken+`"}`))
		r.Header.Set("Content-Type", "application/json")
		if old != nil {
			r.AddCookie(old)
		}
		w := httptest.NewRecorder()
		s.connect(w, r)
		if w.Code != 200 {
			t.Fatal("cannot login")
		}
		return w.Result().Cookies()[0]
	}
	authenticated := func(cookie *http.Cookie) bool {
		r := localTestRequest("GET", "/api/demo", nil)
		r.AddCookie(cookie)
		_, _, ok := s.authenticate(r)
		return ok
	}
	first := login(nil)
	second := login(first)
	if first.Value == second.Value || authenticated(first) || !authenticated(second) {
		t.Fatal("login rotation did not invalidate previous credential")
	}
	if w := userRequest(New(testToken), "GET", "/api/demo", "", "", second); w.Code != 401 {
		t.Fatal("cookie survived a new server instance")
	}
	key := sha256.Sum256([]byte(second.Value))
	state := s.security.logins[key]
	state.expires = time.Now().Add(-time.Second)
	s.security.logins[key] = state
	if authenticated(second) || state.ctx.Err() == nil {
		t.Fatal("expired cookie retained authorization or request context")
	}
	r := localTestRequest("POST", "/api/connect", nil)
	r.Header.Set("X-Forwarded-Proto", "https")
	r.Header.Set("X-Forwarded-Prefix", "/ac/")
	if cookie := s.accessCookie(r); cookie.Path != "/" || cookie.Secure {
		t.Fatal("untrusted proxy headers changed cookie attributes")
	}
}

func TestLoginRateLimitsCannotBeBypassedWithForwardedHeaders(t *testing.T) {
	h := New(testToken)
	for i := 0; i < 11; i++ {
		r := localTestRequest("POST", "/api/connect", strings.NewReader(`{"token":"incorrect"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Real-IP", netip.AddrFrom4([4]byte{192, 0, 2, byte(i)}).String())
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 401
		if i == 10 {
			want = 429
			if w.Header().Get("Retry-After") == "" {
				t.Fatal("missing retry delay")
			}
		}
		if w.Code != want {
			t.Fatalf("attempt %d: HTTP %d, want %d", i, w.Code, want)
		}
	}
	s := &Server{security: newSecurityState()}
	for i := 0; i < 121; i++ {
		r := localTestRequest("POST", "/api/connect", nil)
		r.RemoteAddr = net.JoinHostPort(netip.AddrFrom4([4]byte{192, 0, 2, byte(i)}).String(), "1234")
		if allowed := s.allowLogin(r); allowed != (i < 120) {
			t.Fatal("global authentication limit was bypassed")
		}
	}
	s.security.global.start = time.Now().Add(-2 * time.Minute)
	if !s.allowLogin(localTestRequest("POST", "/api/connect", nil)) {
		t.Fatal("authentication window did not reset")
	}
}

type streamRecorder struct {
	*httptest.ResponseRecorder
	started chan struct{}
	once    sync.Once
}

func (w *streamRecorder) Flush() {
	w.ResponseRecorder.Flush()
	w.once.Do(func() { close(w.started) })
}

func TestLogoutCancelsEventStreamsAndReplay(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	s, err := task.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	run, err := s.Start(context.Background(), domain.StartRequest{Prompt: "Private pricing", ModelRef: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	h := NewWithTasks(testToken, s)
	cookie := loginHTTPUser(t, h, testToken)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := localTestRequest("GET", "/api/sessions/"+run.SessionID+"/events", nil).WithContext(ctx)
	r.AddCookie(cookie)
	w := &streamRecorder{ResponseRecorder: httptest.NewRecorder(), started: make(chan struct{})}
	done := make(chan struct{})
	go func() { h.ServeHTTP(w, r); close(done) }()
	select {
	case <-w.started:
	case <-time.After(5 * time.Second):
		t.Fatal("event stream did not open")
	}
	logout := userRequest(h, "POST", "/api/disconnect", "", "", cookie)
	if logout.Code != 200 {
		t.Fatal("logout failed")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("logged-out event stream remained active")
	}
	if replay := userRequest(h, "GET", "/api/sessions/"+run.SessionID+"/events", "", "", cookie); replay.Code != 401 {
		t.Fatal("logged-out cookie could replay private events")
	}
}

func TestEventStreamCapacityIsBoundedPerUserAndGlobally(t *testing.T) {
	s := &Server{security: newSecurityState()}
	if !s.acquireStream("alice") || !s.acquireStream("alice") || s.acquireStream("alice") || !s.acquireStream("bob") {
		t.Fatal("per-user event stream limit failed")
	}
	s.releaseStream("alice")
	if !s.acquireStream("alice") {
		t.Fatal("closed stream did not release capacity")
	}
	s.security.active = 32
	if s.acquireStream("charlie") {
		t.Fatal("global event stream limit failed")
	}
}

func TestAdminRevocationStopsBearerAndCookieStreams(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	s, err := task.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := NewWithTasks(testToken, s)
	user, token := createHTTPUser(t, h, "Revocable")
	cookie := loginHTTPUser(t, h, token)
	w := userRequest(h, "POST", "/api/sessions", `{"prompt":"Private revoked history","mode":"demo"}`, token, nil)
	var run domain.Run
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &run) != nil {
		t.Fatal("cannot create private session")
	}
	waitHTTPApproval(t, s, run.SessionID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var completions []chan struct{}
	for _, useCookie := range []bool{true, false} {
		r := localTestRequest("GET", "/api/sessions/"+run.SessionID+"/events", nil).WithContext(ctx)
		if useCookie {
			r.AddCookie(cookie)
		} else {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		stream := &streamRecorder{ResponseRecorder: httptest.NewRecorder(), started: make(chan struct{})}
		done := make(chan struct{})
		completions = append(completions, done)
		go func() { h.ServeHTTP(stream, r); close(done) }()
		select {
		case <-stream.started:
		case <-time.After(5 * time.Second):
			t.Fatal("private event stream did not open")
		}
	}
	for _, route := range []struct{ method, path string }{{"GET", "/api/users"}, {"DELETE", "/api/users/" + user.ID}} {
		if w := userRequest(h, route.method, route.path, "", token, nil); w.Code != 403 {
			t.Fatal("ordinary user accessed administrative user management")
		}
	}
	users := userRequest(h, "GET", "/api/users", "", testToken, nil)
	if users.Code != 200 || strings.Contains(users.Body.String(), token) || strings.Contains(users.Body.String(), "token_hash") {
		t.Fatal("user management disclosed credentials")
	}
	if w := userRequest(h, "DELETE", "/api/users/"+user.ID, "", testToken, nil); w.Code != 200 {
		t.Fatal("administrator could not revoke access")
	}
	for _, done := range completions {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("revoked cookie or Bearer stream remained active")
		}
	}
	for _, oldCookie := range []*http.Cookie{nil, cookie} {
		if w := userRequest(h, "GET", "/api/sessions/"+run.SessionID+"/export", "", token, oldCookie); w.Code != 401 {
			t.Fatal("revoked credential still accessed private history")
		}
	}
	if w := userRequest(h, "POST", "/api/connect", `{"token":"`+token+`"}`, "", nil); w.Code != 401 {
		t.Fatal("revoked user could log in again")
	}
	if w := userRequest(h, "DELETE", "/api/users/owner", "", testToken, nil); w.Code < 400 {
		t.Fatal("service owner access was revocable through a user ID")
	}
}

func TestAPIResponsesAndStaticFilesNeverExposeConfiguredModelKey(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	s, err := task.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := NewWithTasks(testToken, s)
	const key = "synthetic-private-http-model-key"
	configured := userRequest(h, "PUT", "/api/model", `{"model":"deepseek-flash","apiKey":"`+key+`"}`, testToken, nil)
	if configured.Code != 200 || strings.Contains(configured.Body.String(), key) {
		t.Fatal("model setup disclosed its key")
	}
	_, token := createHTTPUser(t, h, "Private")
	for _, path := range []string{"/api/workbench", "/api/sessions", "/model-settings.json", "/sessions-v1.sqlite", "/sessions-v1.sqlite-wal", "/.env", "/../../model-settings.json"} {
		w := userRequest(h, "GET", path, "", token, nil)
		if strings.Contains(w.Body.String(), key) || strings.Contains(w.Body.String(), `"apiKey"`) {
			t.Fatalf("credential disclosed at %s", path)
		}
		if !strings.HasPrefix(path, "/api/") && w.Code == 200 {
			t.Fatalf("private file served at %s", path)
		}
	}
}
