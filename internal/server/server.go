// Package server exposes file-in/file-out conversion, never host filesystem paths.
package server

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/fishinggoing/agent-continue/internal/app"
	"github.com/fishinggoing/agent-continue/internal/migrate"
	"github.com/fishinggoing/agent-continue/internal/task"
)

//go:embed web/*
var assets embed.FS

type Server struct {
	token    string
	slots    chan struct{}
	tasks    *task.Service
	options  Options
	security *securityState
	requests chan struct{}
}

func New(token string) http.Handler {
	return NewWithTasks(token, nil)
}

func NewWithTasks(token string, tasks *task.Service) http.Handler {
	return NewWithOptions(token, tasks, Options{})
}

func NewWithOptions(token string, tasks *task.Service, options Options) http.Handler {
	s := &Server{token: token, slots: make(chan struct{}, 2), tasks: tasks, options: options, security: newSecurityState(), requests: make(chan struct{}, 64)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]any{"status": "ok"}) })
	mux.HandleFunc("POST /api/inspect", s.api)
	mux.HandleFunc("POST /api/plan", s.api)
	mux.HandleFunc("POST /api/convert", s.api)
	mux.HandleFunc("GET /api/demo", s.demo)
	mux.HandleFunc("POST /api/connect", s.connect)
	mux.HandleFunc("POST /api/disconnect", s.disconnect)
	if tasks != nil {
		mux.HandleFunc("POST /api/users", s.createUser)
		mux.HandleFunc("GET /api/users", s.listUsers)
		mux.HandleFunc("DELETE /api/users/{id}", s.revokeUser)
		s.registerTasks(mux)
	}
	files, _ := fs.Sub(assets, "web")
	static := http.FileServer(http.FS(files))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed := map[string]bool{"/": true, "/app.js": true, "/migration.js": true, "/style.css": true, "/chat.css": true, "/theme.css": true, "/theme.js": true, "/lucide.min.js": true, "/marked.umd.js": true, "/purify.min.js": true, "/marked-LICENSE.txt": true, "/purify-LICENSE.txt": true}
		if !allowed[r.URL.Path] {
			http.NotFound(w, r)
			return
		}
		static.ServeHTTP(w, r)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		if !s.allowRequest(w, r) {
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			select {
			case s.requests <- struct{}{}:
				defer func() { <-s.requests }()
			default:
				failure(w, 429, "Too many concurrent requests; retry later")
				return
			}
			if r.URL.Path != "/api/connect" && r.URL.Path != "/api/disconnect" {
				user, login, ok := s.authenticate(r)
				if !ok {
					if !s.allowLogin(r) {
						w.Header().Set("Retry-After", "60")
						failure(w, 429, "Too many authentication attempts; retry in one minute")
						return
					}
					failure(w, 401, "Access token is required or invalid")
					return
				}
				ctx := r.Context()
				if login != nil {
					var cancel context.CancelFunc
					ctx, cancel = context.WithDeadline(ctx, login.expires)
					stop := context.AfterFunc(login.ctx, cancel)
					defer cancel()
					defer stop()
				}
				r = r.WithContext(context.WithValue(ctx, userContextKey{}, user))
			}
		}
		mux.ServeHTTP(w, r)
	})
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]any{"status": "failed", "error": message})
}
func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		failure(w, 429, "Server is busy; retry shortly")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, migrate.MaxUploadBytes+65536)
	reader, e := r.MultipartReader()
	if e != nil {
		failure(w, 400, "Expected a multipart file upload")
		return
	}
	fields := map[string]string{}
	var data []byte
	filename := ""
	seenFile := false
	allowed := map[string]bool{"from": true, "cwd": true, "id": true, "cliVersion": true, "modelProvider": true, "model": true, "title": true}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			failure(w, 413, "Invalid upload or upload exceeds 16 MiB; use the local CLI for larger files")
			return
		}
		name := part.FormName()
		if name == "file" {
			if seenFile {
				failure(w, 400, "Upload exactly one session file")
				return
			}
			seenFile = true
			filename = part.FileName()
			data, e = io.ReadAll(io.LimitReader(part, migrate.MaxUploadBytes+1))
			if e != nil || len(data) > migrate.MaxUploadBytes {
				failure(w, 413, "Web input exceeds 16 MiB; use the local CLI for larger files")
				return
			}
		}
		if name != "file" {
			if !allowed[name] {
				failure(w, 400, "Unknown form field")
				return
			}
			if _, ok := fields[name]; ok {
				failure(w, 400, "Duplicate form field")
				return
			}
			b, err := io.ReadAll(io.LimitReader(part, 4097))
			if err != nil || len(b) > 4096 {
				failure(w, 400, "Invalid form field size")
				return
			}
			fields[name] = string(b)
		}
		part.Close()
	}
	if !seenFile || len(data) == 0 {
		failure(w, 400, "Choose a non-empty session file")
		return
	}
	source, e := migrate.ParseUpload(fields["from"], filename, data)
	if e != nil {
		failure(w, 422, e.Error())
		return
	}
	if r.URL.Path == "/api/inspect" {
		report, e := app.Inspect(source, filename)
		if e != nil {
			failure(w, 422, e.Error())
			return
		}
		respond(w, 200, map[string]any{"report": report})
		return
	}
	prepared, e := app.Prepare(source, app.Options{Cwd: fields["cwd"], ID: fields["id"], CLIVersion: fields["cliVersion"], ModelProvider: fields["modelProvider"], Model: fields["model"], Title: fields["title"]})
	if e != nil {
		failure(w, 422, e.Error())
		return
	}
	result := map[string]any{"report": prepared.Report}
	if r.URL.Path == "/api/convert" {
		prepared.Report["status"] = "converted"
		prepared.Report["output"].(map[string]any)["bytes"] = len(prepared.Content)
		result["artifact"] = map[string]any{"name": prepared.Filename, "data": base64.StdEncoding.EncodeToString(prepared.Content), "sha256": app.Hash(prepared.Content), "harness": prepared.Target, "cwd": prepared.Cwd, "model": prepared.Model, "title": prepared.Title}
	}
	respond(w, 200, result)
}

// The demo contains only synthetic text and runs through the normal upload flow.
func (s *Server) demo(w http.ResponseWriter, r *http.Request) {
	records := []map[string]any{
		{"timestamp": "2026-10-04T00:00:00.000Z", "type": "session_meta", "payload": map[string]any{"id": "11111111-1111-4111-8111-111111111111", "cwd": "/demo/project", "cli_version": "demo", "model_provider": "demo"}},
		{"timestamp": "2026-10-04T00:00:00.000Z", "type": "event_msg", "payload": map[string]any{"type": "task_started", "turn_id": "demo-turn"}},
		{"timestamp": "2026-10-04T00:00:00.000Z", "type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "合成示例：请继续完成项目的测试。"}}}},
		{"timestamp": "2026-10-04T00:00:00.000Z", "type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "合成示例：已经完成实现，下一步运行测试。"}}}},
		{"timestamp": "2026-10-04T00:00:00.000Z", "type": "event_msg", "payload": map[string]any{"type": "task_complete", "turn_id": "demo-turn"}},
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="demo-rollout.jsonl"`)
	for _, record := range records {
		_ = json.NewEncoder(w).Encode(record)
	}
}
func Run(listen, token string) error {
	host, _, e := net.SplitHostPort(listen)
	if e != nil {
		return fmt.Errorf("Invalid listen address: %w", e)
	}
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) && len(token) < 24 {
		return fmt.Errorf("Non-loopback listeners require AGENT_CONTINUE_TOKEN with at least 24 characters")
	}
	if token != "" && (len(token) < 24 || len(token) > 256 || strings.ContainsAny(token, " \t\r\n\x00")) {
		return fmt.Errorf("AGENT_CONTINUE_TOKEN must contain 24..256 characters without whitespace")
	}
	options, e := proxyOptions(os.Getenv("AGENT_CONTINUE_TRUSTED_PROXIES"))
	if e != nil {
		return e
	}
	dataDir := os.Getenv("AGENT_CONTINUE_DATA_DIR")
	if dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		dataDir = filepath.Join(base, "agent-continue", "workbench")
	}
	tasks, e := task.Open(dataDir)
	if e != nil {
		return e
	}
	defer tasks.Close()
	srv := &http.Server{Addr: listen, Handler: NewWithOptions(token, tasks, options), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 90 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	listener, e := net.Listen("tcp", listen)
	if e != nil {
		return e
	}
	fmt.Fprintf(os.Stderr, "Agent Continue: http://%s\n", listener.Addr())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		case <-done:
		}
	}()
	if e = srv.Serve(listener); e == http.ErrServerClosed {
		return nil
	}
	return e
}
