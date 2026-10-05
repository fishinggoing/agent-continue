package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/task"
)

func decodeRequest(w http.ResponseWriter, r *http.Request, value any) error {
	if !jsonContent(r) {
		return errors.New("expected application/json request")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return errors.New("invalid JSON request")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("expected one JSON request")
	}
	return nil
}
func taskFailure(w http.ResponseWriter, err error) {
	code := 422
	if errors.Is(err, task.ErrNotFound) {
		code = 404
	}
	if errors.Is(err, task.ErrConflict) {
		code = 409
	}
	failure(w, code, err.Error())
}

func (s *Server) registerTasks(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workbench", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"version": 1, "workspace": "uploads", "modelReady": s.tasks.ModelReady(), "model": s.tasks.ModelID(), "provider": s.tasks.ProviderID(), "models": s.tasks.Models(), "permissionMode": s.tasks.PolicyMode(), "demo": true, "shellEnabled": false, "user": currentUser(r), "multiUserEnabled": s.token != ""})
	})
	mux.HandleFunc("PUT /api/model", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		var req struct {
			Model  string `json:"model"`
			APIKey string `json:"apiKey"`
		}
		if err := decodeRequest(w, r, &req); err != nil {
			failure(w, 400, err.Error())
			return
		}
		if err := s.tasks.ConfigureModel(req.Model, req.APIKey); err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 200, map[string]any{"model": s.tasks.ModelID(), "modelReady": s.tasks.ModelReady()})
	})
	mux.HandleFunc("POST /api/model/check", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		select {
		case s.slots <- struct{}{}:
			defer func() { <-s.slots }()
		default:
			failure(w, 429, "model check is busy")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
		defer cancel()
		if err := s.tasks.CheckModel(ctx); err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 200, map[string]string{"status": "connected", "model": s.tasks.ModelID()})
	})
	mux.HandleFunc("GET /api/sessions", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"sessions": s.userTasks(r).List()})
	})
	mux.HandleFunc("POST /api/sessions", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Prompt string           `json:"prompt"`
			Mode   string           `json:"mode"`
			Files  []task.FileInput `json:"files"`
		}
		if err := decodeRequest(w, r, &req); err != nil {
			failure(w, 400, err.Error())
			return
		}
		if req.Mode == "" {
			req.Mode = s.tasks.ProviderID()
		}
		run, err := s.userTasks(r).StartWithFiles(r.Context(), domain.StartRequest{Prompt: req.Prompt, ModelRef: req.Mode}, req.Files)
		if err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 201, run)
	})
	mux.HandleFunc("GET /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		snap, err := s.userTasks(r).Get(r.PathValue("id"))
		if err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 200, snap)
	})
	mux.HandleFunc("POST /api/sessions/{id}/continue", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Prompt string           `json:"prompt"`
			Files  []task.FileInput `json:"files"`
		}
		if err := decodeRequest(w, r, &req); err != nil {
			failure(w, 400, err.Error())
			return
		}
		run, err := s.userTasks(r).ContinueWithFiles(r.Context(), r.PathValue("id"), req.Prompt, req.Files)
		if err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 202, run)
	})
	mux.HandleFunc("POST /api/sessions/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if err := s.userTasks(r).Cancel(r.Context(), r.PathValue("id")); err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 202, map[string]string{"status": "cancellation_requested"})
	})
	mux.HandleFunc("POST /api/sessions/{id}/approvals/{approval}", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			RunID  string `json:"runId"`
			CallID string `json:"callId"`
			Hash   string `json:"argumentsHash"`
			Allow  *bool  `json:"allow"`
		}
		if err := decodeRequest(w, r, &req); err != nil || req.Allow == nil {
			failure(w, 400, "approval requires an explicit boolean decision")
			return
		}
		err := s.userTasks(r).Resolve(r.PathValue("id"), domain.ApprovalDecision{ApprovalID: r.PathValue("approval"), RunID: req.RunID, CallID: req.CallID, ArgumentsHash: req.Hash, Allow: *req.Allow})
		if err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 200, map[string]string{"status": "resolved"})
	})
	mux.HandleFunc("GET /api/sessions/{id}/file", func(w http.ResponseWriter, r *http.Request) {
		text, err := s.userTasks(r).File(r.PathValue("id"), r.URL.Query().Get("path"))
		if err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 200, map[string]string{"content": text})
	})
	mux.HandleFunc("GET /api/sessions/{id}/files", func(w http.ResponseWriter, r *http.Request) {
		files, err := s.userTasks(r).FileList(r.PathValue("id"))
		if err != nil {
			taskFailure(w, err)
			return
		}
		respond(w, 200, map[string]any{"files": files})
	})
	mux.HandleFunc("GET /api/sessions/{id}/export", func(w http.ResponseWriter, r *http.Request) {
		snap, err := s.userTasks(r).Get(r.PathValue("id"))
		if err != nil {
			taskFailure(w, err)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="agent-continue-session.json"`)
		respond(w, 200, snap)
	})
	mux.HandleFunc("GET /api/sessions/{id}/events", s.taskEvents)
}

func (s *Server) taskEvents(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r).ID
	if !s.acquireStream(user) {
		failure(w, 429, "Too many event streams; close another connection")
		return
	}
	defer s.releaseStream(user)
	after := uint64(0)
	if text := r.URL.Query().Get("after"); text != "" {
		n, err := strconv.ParseUint(text, 10, 64)
		if err != nil {
			failure(w, 400, "invalid event cursor")
			return
		}
		after = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	events, err := s.userTasks(r).Events(ctx, r.PathValue("id"), after)
	if err != nil {
		taskFailure(w, err)
		return
	}
	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	if _, err = fmt.Fprint(w, ": connected\n\n"); err != nil {
		return
	}
	if controller.Flush() != nil {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err = fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			if controller.Flush() != nil {
				return
			}
		case event, ok := <-events:
			if !ok {
				return
			}
			b, _ := json.Marshal(event)
			if _, err = fmt.Fprintf(w, "id: %d\nevent: task\ndata: %s\n\n", event.Sequence, b); err != nil {
				return
			}
			if controller.Flush() != nil {
				return
			}
		}
	}
}
