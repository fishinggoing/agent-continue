package server

import (
	"context"
	"crypto/sha256"
	"errors"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Only explicitly configured proxies may assert the public scheme and client IP.
type Options struct {
	TrustedProxies []netip.Prefix
}

func proxyOptions(value string) (Options, error) {
	var options Options
	if value == "" {
		return options, nil
	}
	for _, item := range strings.Split(value, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(item))
		if err != nil || prefix.Bits() == 0 {
			return Options{}, errors.New("AGENT_CONTINUE_TRUSTED_PROXIES must contain explicit IP CIDRs, never a wildcard")
		}
		options.TrustedProxies = append(options.TrustedProxies, prefix)
	}
	return options, nil
}

func peerIP(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}
	}
	ip, _ := netip.ParseAddr(host)
	return ip.Unmap()
}

func (s *Server) trustedProxy(r *http.Request) bool {
	ip := peerIP(r)
	for _, prefix := range s.options.TrustedProxies {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

func (s *Server) secureRequest(r *http.Request) bool {
	return r.TLS != nil || s.trustedProxy(r) && r.Header.Get("X-Forwarded-Proto") == "https"
}

func localRequest(r *http.Request) bool {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	ip, _ := netip.ParseAddr(strings.Trim(host, "[]"))
	// A proxy must never turn public HTTP into unauthenticated local access.
	return peerIP(r).IsLoopback() && (strings.EqualFold(host, "localhost") || ip.IsLoopback()) &&
		r.Header.Get("X-Forwarded-Proto") == "" && r.Header.Get("Forwarded") == "" && r.Header.Get("X-Forwarded-For") == ""
}

func (s *Server) allowRequest(w http.ResponseWriter, r *http.Request) bool {
	secure := s.secureRequest(r)
	if secure {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
	}
	if r.URL.Path == "/healthz" {
		return true
	}
	if s.token == "" && !localRequest(r) {
		failure(w, 403, "Unprotected mode is restricted to direct loopback requests")
		return false
	}
	if !secure && !localRequest(r) {
		failure(w, 403, "HTTPS is required outside direct loopback access")
		return false
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		return true
	}
	origin := r.Header.Get("Origin")
	if origin != "" {
		u, err := url.Parse(origin)
		scheme := "http"
		if secure {
			scheme = "https"
		}
		if err != nil || u.Scheme != scheme || !strings.EqualFold(u.Host, r.Host) || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
			failure(w, 403, "Cross-origin requests are not allowed")
			return false
		}
	}
	site := r.Header.Get("Sec-Fetch-Site")
	if site == "cross-site" || site == "same-site" {
		failure(w, 403, "Cross-site requests are not allowed")
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Authorization") == "" {
		if _, err := r.Cookie("agent_continue_session"); err == nil && origin == "" && site != "same-origin" {
			failure(w, 403, "Cookie-authenticated writes require a same-origin browser request")
			return false
		}
	}
	return true
}

func jsonContent(r *http.Request) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && media == "application/json"
}

type loginSession struct {
	userID  string
	expires time.Time
	ctx     context.Context
	cancel  context.CancelFunc
}

type attemptWindow struct {
	start time.Time
	count int
}

type securityState struct {
	mu       sync.Mutex
	logins   map[[32]byte]loginSession
	users    map[string]loginSession
	attempts map[string]attemptWindow
	global   attemptWindow
	streams  map[string]int
	active   int
}

func newSecurityState() *securityState {
	return &securityState{logins: make(map[[32]byte]loginSession), users: make(map[string]loginSession), attempts: make(map[string]attemptWindow), streams: make(map[string]int)}
}

func (s *Server) clientIP(r *http.Request) string {
	if s.trustedProxy(r) {
		if ip, err := netip.ParseAddr(r.Header.Get("X-Real-IP")); err == nil {
			return ip.Unmap().String()
		}
	}
	return peerIP(r).String()
}

func (s *Server) allowLogin(r *http.Request) bool {
	state := s.security
	state.mu.Lock()
	defer state.mu.Unlock()
	now := time.Now()
	for ip, window := range state.attempts {
		if now.Sub(window.start) >= time.Minute {
			delete(state.attempts, ip)
		}
	}
	if now.Sub(state.global.start) >= time.Minute {
		state.global = attemptWindow{start: now}
	}
	ip := s.clientIP(r)
	window, exists := state.attempts[ip]
	if !exists {
		if len(state.attempts) >= 4096 {
			return false
		}
		window.start = now
	}
	if window.count >= 10 || state.global.count >= 120 {
		return false
	}
	window.count++
	state.attempts[ip] = window
	state.global.count++
	return true
}

func (s *Server) revokeLogin(cookie *http.Cookie) {
	if cookie == nil {
		return
	}
	key := sha256.Sum256([]byte(cookie.Value))
	s.security.mu.Lock()
	defer s.security.mu.Unlock()
	if login, ok := s.security.logins[key]; ok {
		login.cancel()
		delete(s.security.logins, key)
	}
}

func (s *Server) acquireStream(user string) bool {
	s.security.mu.Lock()
	defer s.security.mu.Unlock()
	if s.security.active >= 32 || s.security.streams[user] >= 2 {
		return false
	}
	s.security.active++
	s.security.streams[user]++
	return true
}

func (s *Server) releaseStream(user string) {
	s.security.mu.Lock()
	defer s.security.mu.Unlock()
	s.security.active--
	s.security.streams[user]--
	if s.security.streams[user] == 0 {
		delete(s.security.streams, user)
	}
}
