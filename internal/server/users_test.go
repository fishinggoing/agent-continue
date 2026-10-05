package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/session"
	"github.com/fishinggoing/agent-continue/internal/task"
)

func userRequest(h http.Handler, method, path, body, token string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := localTestRequest(method, path, bytes.NewBufferString(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://localhost")
	if cookie != nil {
		r.AddCookie(cookie)
	} else if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func createHTTPUser(t *testing.T, h http.Handler, name string) (session.User, string) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		t.Fatal(err)
	}
	w := userRequest(h, http.MethodPost, "/api/users", string(body), testToken, nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("create user: HTTP %d", w.Code)
	}
	var result struct {
		User  session.User `json:"user"`
		Token string       `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.User.ID == "" || result.User.ID == session.DefaultOwnerID || result.User.Admin || result.User.Name != name || len(result.Token) < 32 {
		t.Fatal("invalid created identity or access token")
	}
	return result.User, result.Token
}

func loginHTTPUser(t *testing.T, h http.Handler, token string) *http.Cookie {
	t.Helper()
	body, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		t.Fatal(err)
	}
	w := userRequest(h, http.MethodPost, "/api/connect", string(body), "", nil)
	cookies := w.Result().Cookies()
	if w.Code != http.StatusOK || len(cookies) != 1 {
		t.Fatalf("login: HTTP %d, %d cookies", w.Code, len(cookies))
	}
	return cookies[0]
}

func waitHTTPApproval(t *testing.T, s *task.Service, id string) (task.Snapshot, domain.Approval) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		snap, err := s.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if snap.Session.Status == domain.AwaitingApproval {
			for _, tool := range snap.Tools {
				if tool.Approval != nil && tool.Approval.Status == "pending" {
					return snap, *tool.Approval
				}
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("session did not reach pending approval")
	return task.Snapshot{}, domain.Approval{}
}

type cancelOnTaskEventRecorder struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (w *cancelOnTaskEventRecorder) Write(body []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(body)
	if bytes.Contains(body, []byte("event: task")) {
		w.cancel()
	}
	return n, err
}

func TestUserHTTPIsolationAcrossAllSessionRoutes(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	s, err := task.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := NewWithTasks(testToken, s)
	alice, aliceToken := createHTTPUser(t, h, "Alice")
	bob, bobToken := createHTTPUser(t, h, "Bob")
	if alice.ID == bob.ID || aliceToken == bobToken {
		t.Fatal("distinct users share identity or token")
	}
	aliceCookie, bobCookie := loginHTTPUser(t, h, aliceToken), loginHTTPUser(t, h, bobToken)
	ownerCookie := loginHTTPUser(t, h, testToken)
	identities := []struct {
		name   string
		user   session.User
		token  string
		cookie *http.Cookie
		run    domain.Run
	}{
		{name: "Alice", user: alice, token: aliceToken, cookie: aliceCookie},
		{name: "Bob", user: bob, token: bobToken, cookie: bobCookie},
		{name: "owner", user: ownerUser(), token: testToken, cookie: ownerCookie},
	}
	for i := range identities {
		identity := &identities[i]
		w := userRequest(h, http.MethodPost, "/api/sessions", `{"prompt":"Private `+identity.name+` history","mode":"demo"}`, "", identity.cookie)
		if w.Code != http.StatusCreated {
			t.Fatalf("%s start: HTTP %d", identity.name, w.Code)
		}
		if err := json.Unmarshal(w.Body.Bytes(), &identity.run); err != nil {
			t.Fatal(err)
		}
		waitHTTPApproval(t, s, identity.run.SessionID)
	}

	for _, identity := range identities {
		for _, cookie := range []*http.Cookie{identity.cookie, nil} {
			w := userRequest(h, http.MethodGet, "/api/workbench", "", identity.token, cookie)
			var workbench struct {
				User session.User `json:"user"`
			}
			if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &workbench) != nil || workbench.User != identity.user {
				t.Fatalf("%s identity was not preserved by cookie/bearer authentication", identity.name)
			}
			w = userRequest(h, http.MethodGet, "/api/sessions", "", identity.token, cookie)
			var listed struct {
				Sessions []task.Snapshot `json:"sessions"`
			}
			if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &listed) != nil || len(listed.Sessions) != 1 || listed.Sessions[0].Session.ID != identity.run.SessionID {
				t.Fatalf("%s history contains another user's sessions", identity.name)
			}
		}
		for _, suffix := range []string{"", "/file?path=pricing.json", "/files", "/export"} {
			w := userRequest(h, http.MethodGet, "/api/sessions/"+identity.run.SessionID+suffix, "", "", identity.cookie)
			if w.Code != http.StatusOK {
				t.Fatalf("%s cannot access own %s: HTTP %d", identity.name, suffix, w.Code)
			}
		}
	}

	for _, target := range identities {
		before, approval := waitHTTPApproval(t, s, target.run.SessionID)
		beforeJSON, _ := json.Marshal(before)
		approvalBody, _ := json.Marshal(map[string]any{"runId": approval.RunID, "callId": approval.CallID, "argumentsHash": approval.ArgumentsHash, "allow": true})
		for _, caller := range identities {
			if caller.user.ID == target.user.ID {
				continue
			}
			for _, route := range []struct{ method, suffix, body string }{
				{http.MethodGet, "", ""},
				{http.MethodGet, "/file?path=pricing.json", ""},
				{http.MethodGet, "/files", ""},
				{http.MethodGet, "/export", ""},
				{http.MethodGet, "/events", ""},
				{http.MethodPost, "/continue", `{"prompt":"Foreign continuation","files":[{"path":"injected.txt","content":"foreign upload"}]}`},
				{http.MethodPost, "/cancel", ""},
				{http.MethodPost, "/approvals/" + approval.ID, string(approvalBody)},
			} {
				w := userRequest(h, route.method, "/api/sessions/"+target.run.SessionID+route.suffix, route.body, caller.token, nil)
				if w.Code != http.StatusNotFound {
					t.Fatalf("%s accessed %s %s of %s: HTTP %d", caller.name, route.method, route.suffix, target.name, w.Code)
				}
				if strings.Contains(w.Body.String(), target.run.SessionID) || strings.Contains(w.Body.String(), target.name+" history") {
					t.Fatal("denied response disclosed foreign history")
				}
			}
		}
		after, err := s.Get(target.run.SessionID)
		afterJSON, _ := json.Marshal(after)
		file, fileErr := s.File(target.run.SessionID, "pricing.json")
		if err != nil || fileErr != nil || !bytes.Equal(beforeJSON, afterJSON) || file != before.Baseline {
			t.Fatal("foreign requests changed the session or approved a write")
		}
	}

	// A bounded SSE request proves a user can replay only their own events.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r := localTestRequest(http.MethodGet, "/api/sessions/"+identities[0].run.SessionID+"/events", nil).WithContext(ctx)
	r.AddCookie(aliceCookie)
	w := &cancelOnTaskEventRecorder{ResponseRecorder: httptest.NewRecorder(), cancel: cancel}
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "event: task") || !strings.Contains(w.Body.String(), identities[0].run.SessionID) || strings.Contains(w.Body.String(), identities[1].run.SessionID) {
		t.Fatal("own event replay failed or disclosed foreign events")
	}
}

func TestUserAuthenticationForgeryLegacyCookiesAndAdministration(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	s, err := task.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := NewWithTasks(testToken, s)
	_, token := createHTTPUser(t, h, "Alice")
	cookie := loginHTTPUser(t, h, token)
	if len(cookie.Value) != 64 || strings.Contains(cookie.Value, token) {
		t.Fatal("login cookie is not an independent opaque credential")
	}
	for name, value := range map[string]string{
		"owner substitution": session.DefaultOwnerID + cookie.Value[len(session.DefaultOwnerID):],
		"unknown nonce":      strings.Repeat("0", 64),
		"modified nonce":     cookie.Value + "changed",
	} {
		t.Run(name, func(t *testing.T) {
			forged := *cookie
			forged.Value = value
			if w := userRequest(h, http.MethodGet, "/api/sessions", "", "", &forged); w.Code != http.StatusUnauthorized {
				t.Fatalf("forged cookie accepted: HTTP %d", w.Code)
			}
		})
	}
	legacy := *cookie
	value := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10) + ".legacy-nonce"
	mac := hmac.New(sha256.New, []byte(testToken))
	mac.Write([]byte(value))
	legacy.Value = value + "." + hex.EncodeToString(mac.Sum(nil))
	w := userRequest(h, http.MethodGet, "/api/workbench", "", "", &legacy)
	if w.Code != http.StatusUnauthorized {
		t.Fatal("legacy stateless cookie was accepted")
	}
	for _, route := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/users", `{"name":"Unauthorized user"}`},
		{http.MethodPut, "/api/model", `{"model":"invalid","apiKey":"synthetic-key"}`},
		{http.MethodPost, "/api/model/check", `{}`},
	} {
		w := userRequest(h, route.method, route.path, route.body, "", cookie)
		if w.Code != http.StatusForbidden {
			t.Fatalf("regular user accessed admin route %s: HTTP %d", route.path, w.Code)
		}
	}
	if w := userRequest(h, http.MethodGet, "/api/sessions", "", "invalid-token", nil); w.Code != http.StatusUnauthorized {
		t.Fatal("unknown bearer token accepted")
	}
	if w := userRequest(h, http.MethodPost, "/api/connect", `{"token":"invalid-token"}`, "", nil); w.Code != http.StatusUnauthorized {
		t.Fatal("unknown login token accepted")
	}
	w = userRequest(h, http.MethodPost, "/api/disconnect", "", "", cookie)
	logoutCookies := w.Result().Cookies()
	if w.Code != http.StatusOK || len(logoutCookies) != 1 || logoutCookies[0].MaxAge >= 0 || logoutCookies[0].Name != cookie.Name {
		t.Fatal("logout did not expire the authentication cookie")
	}
	if w := userRequest(h, http.MethodGet, "/api/sessions", "", "", logoutCookies[0]); w.Code != http.StatusUnauthorized {
		t.Fatal("cleared authentication cookie accepted")
	}
	if w := userRequest(h, http.MethodGet, "/api/sessions", "", "", cookie); w.Code != http.StatusUnauthorized {
		t.Fatal("captured cookie remained usable after logout")
	}
}

func TestUnprotectedLocalModeCannotCreateUsers(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	s, err := task.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	w := userRequest(NewWithTasks("", s), http.MethodPost, "/api/users", `{"name":"Alice"}`, "", nil)
	if w.Code < 400 {
		t.Fatal("user credentials created without a protected master token")
	}
}
