package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/fishinggoing/agent-continue/internal/session"
	"github.com/fishinggoing/agent-continue/internal/task"
)

type userContextKey struct{}

func currentUser(r *http.Request) session.User {
	user, _ := r.Context().Value(userContextKey{}).(session.User)
	return user
}

func (s *Server) userTasks(r *http.Request) task.UserService {
	return s.tasks.ForUser(currentUser(r).ID)
}

func ownerUser() session.User {
	return session.User{ID: session.DefaultOwnerID, Name: "管理员", Admin: true}
}

func tokenMatches(provided, expected string) bool {
	a, b := sha256.Sum256([]byte(provided)), sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}
func (s *Server) authenticateToken(ctx context.Context, token string) (session.User, bool) {
	if token == "" || len(token) > 256 {
		return session.User{}, false
	}
	if s.token != "" && tokenMatches(token, s.token) {
		return ownerUser(), true
	}
	if s.tasks != nil && token != "" {
		user, err := s.tasks.AuthenticateUser(ctx, token)
		return user, err == nil
	}
	return session.User{}, false
}

func (s *Server) authenticate(r *http.Request) (session.User, *loginSession, bool) {
	if header := r.Header.Get("Authorization"); header != "" {
		if !strings.HasPrefix(header, "Bearer ") {
			return session.User{}, nil, false
		}
		user, ok := s.authenticateToken(r.Context(), strings.TrimPrefix(header, "Bearer "))
		if !ok || user.Admin {
			return user, nil, ok
		}
		s.security.mu.Lock()
		defer s.security.mu.Unlock()
		// Recheck under the registry lock so revocation cannot miss a new stream.
		if _, err := s.tasks.User(r.Context(), user.ID); err != nil {
			return session.User{}, nil, false
		}
		login, exists := s.security.users[user.ID]
		if !exists {
			ctx, cancel := context.WithCancel(context.Background())
			login = loginSession{userID: user.ID, ctx: ctx, cancel: cancel}
			s.security.users[user.ID] = login
		}
		login.expires = time.Now().Add(12 * time.Hour)
		return user, &login, true
	}
	if s.token == "" && localRequest(r) {
		return ownerUser(), nil, true
	}
	cookie, err := r.Cookie("agent_continue_session")
	if err != nil || len(cookie.Value) != 64 {
		return session.User{}, nil, false
	}
	key := sha256.Sum256([]byte(cookie.Value))
	s.security.mu.Lock()
	login, ok := s.security.logins[key]
	if ok && !time.Now().Before(login.expires) {
		login.cancel()
		delete(s.security.logins, key)
		ok = false
	}
	s.security.mu.Unlock()
	if !ok || login.ctx.Err() != nil {
		return session.User{}, nil, false
	}
	if login.userID == session.DefaultOwnerID {
		return ownerUser(), &login, true
	}
	if s.tasks != nil {
		user, err := s.tasks.User(r.Context(), login.userID)
		return user, &login, err == nil
	}
	return session.User{}, nil, false
}

func (s *Server) accessCookie(r *http.Request) *http.Cookie {
	path := "/"
	if s.trustedProxy(r) && r.Header.Get("X-Forwarded-Prefix") == "/ac/" {
		path = "/ac/"
	}
	return &http.Cookie{Name: "agent_continue_session", Path: path, HttpOnly: true, Secure: s.secureRequest(r), SameSite: http.SameSiteStrictMode}
}

func (s *Server) connect(w http.ResponseWriter, r *http.Request) {
	if !s.allowLogin(r) {
		w.Header().Set("Retry-After", "60")
		failure(w, 429, "Too many login attempts; retry in one minute")
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if err := decodeRequest(w, r, &req); err != nil {
		failure(w, 400, err.Error())
		return
	}
	user, ok := s.authenticateToken(r.Context(), req.Token)
	if !ok {
		failure(w, 401, "Access token is required or invalid")
		return
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		failure(w, 500, "cannot create login session")
		return
	}
	if old, err := r.Cookie("agent_continue_session"); err == nil {
		s.revokeLogin(old)
	}
	cookie := s.accessCookie(r)
	cookie.Value = hex.EncodeToString(nonce)
	cookie.Expires = time.Now().Add(12 * time.Hour)
	cookie.MaxAge = 12 * 60 * 60
	ctx, cancel := context.WithCancel(context.Background())
	s.security.mu.Lock()
	if !user.Admin {
		if _, err := s.tasks.User(r.Context(), user.ID); err != nil {
			s.security.mu.Unlock()
			cancel()
			failure(w, 401, "Access token is required or invalid")
			return
		}
	}
	count := 0
	var oldestKey [32]byte
	var oldest time.Time
	for key, login := range s.security.logins {
		if !time.Now().Before(login.expires) {
			login.cancel()
			delete(s.security.logins, key)
			continue
		}
		if login.userID == user.ID {
			count++
			if oldest.IsZero() || login.expires.Before(oldest) {
				oldest, oldestKey = login.expires, key
			}
		}
	}
	if count >= 16 {
		s.security.logins[oldestKey].cancel()
		delete(s.security.logins, oldestKey)
	}
	if len(s.security.logins) >= 4096 {
		s.security.mu.Unlock()
		cancel()
		failure(w, 429, "Login session capacity reached; retry later")
		return
	}
	s.security.logins[sha256.Sum256([]byte(cookie.Value))] = loginSession{userID: user.ID, expires: cookie.Expires, ctx: ctx, cancel: cancel}
	s.security.mu.Unlock()
	http.SetCookie(w, cookie)
	respond(w, 200, map[string]any{"status": "connected", "user": user})
}

func (s *Server) disconnect(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("agent_continue_session"); err == nil {
		s.revokeLogin(cookie)
	}
	cookie := s.accessCookie(r)
	cookie.MaxAge = -1
	cookie.Expires = time.Unix(1, 0)
	http.SetCookie(w, cookie)
	respond(w, 200, map[string]string{"status": "disconnected"})
}

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !currentUser(r).Admin {
		failure(w, 403, "administrator access is required")
		return false
	}
	return true
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	if s.token == "" {
		failure(w, 403, "configure a service access token before creating users")
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := decodeRequest(w, r, &req); err != nil {
		failure(w, 400, err.Error())
		return
	}
	user, token, err := s.tasks.CreateUser(r.Context(), req.Name)
	if err != nil {
		failure(w, 422, err.Error())
		return
	}
	respond(w, 201, map[string]any{"user": user, "token": token})
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	users, err := s.tasks.Users(r.Context())
	if err != nil {
		failure(w, 500, "cannot list users")
		return
	}
	respond(w, 200, map[string]any{"users": users})
}

func (s *Server) revokeUser(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := r.PathValue("id")
	if err := s.tasks.RevokeUser(r.Context(), id); err != nil {
		failure(w, 422, err.Error())
		return
	}
	s.security.mu.Lock()
	if login, ok := s.security.users[id]; ok {
		login.cancel()
		delete(s.security.users, id)
	}
	for key, login := range s.security.logins {
		if login.userID == id {
			login.cancel()
			delete(s.security.logins, key)
		}
	}
	s.security.mu.Unlock()
	respond(w, 200, map[string]string{"status": "revoked"})
}
