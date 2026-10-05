// Package provider adapts the documented DeepSeek Chat Completions protocol.
// It returns complete proposals and never executes tools or grants permissions.
package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
)

type ErrorKind string

const (
	Authentication ErrorKind = "authentication"
	Quota          ErrorKind = "quota"
	RateLimit      ErrorKind = "rate_limit"
	Timeout        ErrorKind = "timeout"
	Cancelled      ErrorKind = "cancelled"
	Disconnected   ErrorKind = "disconnected"
	Protocol       ErrorKind = "protocol"
	Unsupported    ErrorKind = "unsupported_protocol"
	Limit          ErrorKind = "limit"
	Server         ErrorKind = "server"
	Transport      ErrorKind = "transport"
	Rejected       ErrorKind = "rejected"
)

// Provider errors intentionally exclude response bodies, headers and credentials.
type Error struct {
	Kind       ErrorKind `json:"kind"`
	HTTPStatus int       `json:"httpStatus,omitempty"`
	Requests   int       `json:"requests"`
	cause      error
}

func (e *Error) Error() string {
	return fmt.Sprintf("model request failed: %s (HTTP %d, requests %d)", e.Kind, e.HTTPStatus, e.Requests)
}
func (e *Error) Unwrap() error { return e.cause }

type Client struct {
	settings     config.Provider
	contextBytes int
	credential   string
	http         *http.Client
}

var _ domain.Provider = (*Client)(nil)

func New(c config.Config, env config.LookupEnv) (*Client, error) {
	if err := config.Validate(c); err != nil {
		return nil, err
	}
	if c.Provider.Protocol != config.ProtocolDeepSeek {
		return nil, &Error{Kind: Unsupported}
	}
	key, err := config.Credential(c.Provider, env)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	return &Client{settings: c.Provider, contextBytes: c.Limits.MaxContextBytes, credential: key, http: &http.Client{
		Transport:     transport,
		Timeout:       time.Duration(c.Provider.TimeoutSeconds) * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

func Models(p config.Provider) []domain.Model {
	result := []domain.Model{}
	if p.ID == "hyperion" {
		return []domain.Model{{Provider: "hyperion", ID: "gpt-6.1-sol", Configured: true, Tools: true, Streaming: true}}
	}
	for _, id := range []string{"deepseek-flash", "deepseek-v4-pro"} {
		result = append(result, domain.Model{Provider: "deepseek", ID: id, Configured: id == p.Model, Tools: true, Streaming: true})
	}
	return result
}

// Model listing is local; no speculative remote discovery is performed.
func (c *Client) Models(ctx context.Context) ([]domain.Model, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return Models(c.settings), nil
}

type wireFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments,omitempty"`
}
type wireCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function wireFunction `json:"function"`
}
type wireMessage struct {
	Role       domain.Role `json:"role"`
	Content    *string     `json:"content"`
	ToolCalls  []wireCall  `json:"tool_calls,omitempty"`
	ToolCallID string      `json:"tool_call_id,omitempty"`
}
type wireTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}
type wireRequest struct {
	Model         string        `json:"model"`
	Messages      []wireMessage `json:"messages"`
	Tools         []wireTool    `json:"tools,omitempty"`
	Stream        bool          `json:"stream"`
	StreamOptions struct {
		IncludeUsage bool `json:"include_usage"`
	} `json:"stream_options"`
	Thinking struct {
		Type string `json:"type"`
	} `json:"thinking"`
	MaxTokens int `json:"max_tokens"`
}

var functionName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func objectJSON(raw json.RawMessage) bool {
	b := bytes.TrimSpace(raw)
	return len(b) > 0 && b[0] == '{' && json.Valid(b)
}

func (c *Client) encode(request domain.ModelRequest) ([]byte, error) {
	w := wireRequest{Model: c.settings.Model, Stream: true, MaxTokens: c.settings.MaxOutputTokens}
	w.StreamOptions.IncludeUsage = true
	w.Thinking.Type = "disabled"
	if request.Model != "" && request.Model != w.Model {
		return nil, &Error{Kind: Unsupported}
	}
	if request.MaxOutputTokens != 0 {
		if request.MaxOutputTokens < 1 || request.MaxOutputTokens > c.settings.MaxOutputTokens {
			return nil, &Error{Kind: Limit}
		}
		w.MaxTokens = request.MaxOutputTokens
	}
	if len(request.Messages) == 0 {
		return nil, &Error{Kind: Protocol}
	}
	pending := map[string]bool{}
	seenCalls := map[string]bool{}
	for _, message := range request.Messages {
		if len(pending) > 0 && message.Role != domain.RoleTool {
			return nil, &Error{Kind: Protocol}
		}
		m := wireMessage{Role: message.Role}
		var text strings.Builder
		for _, part := range message.Content {
			if part.Type != "text" {
				return nil, &Error{Kind: Unsupported}
			}
			text.WriteString(part.Text)
		}
		content := text.String()
		m.Content = &content
		switch message.Role {
		case domain.RoleUser, domain.RoleSystem:
			if len(message.ToolCalls) > 0 || message.ToolCallID != "" {
				return nil, &Error{Kind: Protocol}
			}
		case domain.RoleAssistant:
			if message.ToolCallID != "" {
				return nil, &Error{Kind: Protocol}
			}
			for _, call := range message.ToolCalls {
				if call.ID == "" || !functionName.MatchString(call.Name) || !objectJSON(call.Arguments) || seenCalls[call.ID] {
					return nil, &Error{Kind: Protocol}
				}
				seenCalls[call.ID], pending[call.ID] = true, true
				m.ToolCalls = append(m.ToolCalls, wireCall{ID: call.ID, Type: "function", Function: wireFunction{Name: call.Name, Arguments: string(call.Arguments)}})
			}
			if content == "" && len(m.ToolCalls) > 0 {
				m.Content = nil
			}
		case domain.RoleTool:
			if !pending[message.ToolCallID] || len(message.ToolCalls) > 0 {
				return nil, &Error{Kind: Protocol}
			}
			delete(pending, message.ToolCallID)
			m.ToolCallID = message.ToolCallID
		default:
			return nil, &Error{Kind: Unsupported}
		}
		w.Messages = append(w.Messages, m)
	}
	if len(pending) != 0 {
		return nil, &Error{Kind: Protocol}
	}
	seenTools := map[string]bool{}
	for _, definition := range request.Tools {
		if !functionName.MatchString(definition.Name) || !objectJSON(definition.Parameters) || seenTools[definition.Name] {
			return nil, &Error{Kind: Protocol}
		}
		seenTools[definition.Name] = true
		t := wireTool{Type: "function"}
		t.Function.Name, t.Function.Description, t.Function.Parameters = definition.Name, definition.Description, definition.Parameters
		w.Tools = append(w.Tools, t)
	}
	if len(w.Tools) > 128 {
		return nil, &Error{Kind: Limit}
	}
	b, err := json.Marshal(w)
	if err != nil {
		return nil, &Error{Kind: Protocol}
	}
	if len(b) > c.contextBytes {
		return nil, &Error{Kind: Limit}
	}
	return b, nil
}

func (c *Client) Complete(ctx context.Context, request domain.ModelRequest, delta func(string) error) (result domain.ModelResponse, err error) {
	defer func() {
		result.Text = strings.ReplaceAll(result.Text, c.credential, "[REDACTED]")
		if err != nil {
			result.Complete = false
			result.ToolCalls = nil
		}
	}()
	if ctx.Err() != nil {
		return result, contextError(ctx.Err(), 0)
	}
	b, err := c.encode(request)
	if err != nil {
		return result, err
	}
	for attempt := 0; attempt <= c.settings.MaxRetries; attempt++ {
		if ctx.Err() != nil {
			return result, contextError(ctx.Err(), result.Requests)
		}
		r, e := http.NewRequestWithContext(ctx, http.MethodPost, c.settings.Endpoint, bytes.NewReader(b))
		if e != nil {
			return result, &Error{Kind: Protocol, Requests: result.Requests}
		}
		r.Header.Set("Authorization", "Bearer "+c.credential)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "text/event-stream")
		result.Requests++
		response, e := c.http.Do(r)
		if e != nil {
			if ctx.Err() != nil {
				return result, contextError(ctx.Err(), result.Requests)
			}
			if errors.Is(e, context.DeadlineExceeded) {
				return result, contextError(context.DeadlineExceeded, result.Requests)
			}
			return result, &Error{Kind: Transport, Requests: result.Requests}
		}
		if response.StatusCode != http.StatusOK {
			status := response.StatusCode
			delay := retryDelay(response.Header.Get("Retry-After"), c.settings.RetryDelayMillis, attempt)
			_ = response.Body.Close()
			if retryable(status) && attempt < c.settings.MaxRetries {
				if e := wait(ctx, delay); e != nil {
					return result, contextError(e, result.Requests)
				}
				continue
			}
			return result, &Error{Kind: statusKind(status), HTTPStatus: status, Requests: result.Requests}
		}
		mediaType, _, e := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if e != nil || mediaType != "text/event-stream" {
			_ = response.Body.Close()
			return result, &Error{Kind: Unsupported, HTTPStatus: response.StatusCode, Requests: result.Requests}
		}
		result, e = c.stream(response.Body, result.Requests, delta)
		_ = response.Body.Close()
		if e != nil {
			if ctx.Err() != nil {
				return result, contextError(ctx.Err(), result.Requests)
			}
			if errors.Is(e, context.DeadlineExceeded) {
				return result, contextError(context.DeadlineExceeded, result.Requests)
			}
			return result, e
		}
		return result, nil
	}
	return result, &Error{Kind: Server, Requests: result.Requests}
}

func contextError(err error, requests int) *Error {
	kind := Cancelled
	if errors.Is(err, context.DeadlineExceeded) {
		kind = Timeout
	}
	return &Error{Kind: kind, Requests: requests, cause: err}
}

func retryable(status int) bool {
	return status == 429 || status == 500 || status == 502 || status == 503 || status == 504
}
func statusKind(status int) ErrorKind {
	switch status {
	case 401, 403:
		return Authentication
	case 402:
		return Quota
	case 429:
		return RateLimit
	case 408, 504:
		return Timeout
	case 400, 404, 405, 415, 422:
		return Unsupported
	default:
		if status >= 500 {
			return Server
		}
		return Protocol
	}
}

func retryDelay(header string, milliseconds, attempt int) time.Duration {
	delay := time.Duration(milliseconds) * time.Millisecond * time.Duration(1<<attempt)
	if seconds, err := strconv.ParseInt(header, 10, 32); err == nil && seconds >= 0 {
		delay = time.Duration(seconds) * time.Second
	} else if date, err := http.ParseTime(header); err == nil {
		if d := time.Until(date); d > 0 {
			delay = d
		}
	}
	if delay > time.Minute {
		return time.Minute
	}
	return delay
}

func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
