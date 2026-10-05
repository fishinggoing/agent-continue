package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/fishinggoing/agent-continue/internal/domain"
)

type wireUsage struct {
	Input        *int64 `json:"prompt_tokens"`
	Output       *int64 `json:"completion_tokens"`
	Total        *int64 `json:"total_tokens"`
	Cached       *int64 `json:"prompt_cache_hit_tokens"`
	Miss         *int64 `json:"prompt_cache_miss_tokens"`
	InputDetails *struct {
		Cached *int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	OutputDetails *struct {
		Reasoning *int64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

func (w wireUsage) usage() (domain.Usage, bool) {
	u := domain.Usage{InputTokens: w.Input, OutputTokens: w.Output, TotalTokens: w.Total, CachedInputTokens: w.Cached}
	if w.InputDetails != nil {
		if u.CachedInputTokens != nil && w.InputDetails.Cached != nil && *u.CachedInputTokens != *w.InputDetails.Cached {
			return u, false
		}
		if u.CachedInputTokens == nil {
			u.CachedInputTokens = w.InputDetails.Cached
		}
	}
	if w.OutputDetails != nil {
		u.ReasoningTokens = w.OutputDetails.Reasoning
	}
	for _, n := range []*int64{u.InputTokens, u.OutputTokens, u.TotalTokens, u.CachedInputTokens, u.ReasoningTokens, w.Miss} {
		if n != nil && (*n < 0 || *n > 1<<53-1) {
			return u, false
		}
	}
	if u.InputTokens != nil && u.OutputTokens != nil && u.TotalTokens != nil && *u.InputTokens+*u.OutputTokens != *u.TotalTokens {
		return u, false
	}
	if u.CachedInputTokens != nil && u.InputTokens != nil && *u.CachedInputTokens > *u.InputTokens {
		return u, false
	}
	if u.ReasoningTokens != nil && u.OutputTokens != nil && *u.ReasoningTokens > *u.OutputTokens {
		return u, false
	}
	if w.Miss != nil && w.Cached != nil && w.Input != nil && *w.Miss+*w.Cached != *w.Input {
		return u, false
	}
	return u, true
}

type chunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Choices []struct {
		Index  *int    `json:"index"`
		Finish *string `json:"finish_reason"`
		Delta  struct {
			Role      string  `json:"role"`
			Content   *string `json:"content"`
			Reasoning string  `json:"reasoning_content"`
			Calls     []struct {
				Index    *int   `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *wireUsage `json:"usage"`
}

type partialCall struct {
	id, name  string
	arguments strings.Builder
}

func (c *Client) stream(body io.Reader, requests int, emit func(string) error) (result domain.ModelResponse, err error) {
	result.Requests = requests
	var text strings.Builder
	defer func() {
		result.Text = text.String()
		if err != nil {
			result.ToolCalls = nil
			result.Complete = false
		}
	}()
	failure := func(kind ErrorKind) error { return &Error{Kind: kind, Requests: requests} }
	reader := &io.LimitedReader{R: body, N: int64(c.settings.MaxResponseBytes) + 1}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, min(4096, c.settings.MaxEventBytes+1)), c.settings.MaxEventBytes+1)
	var data []byte
	eventBytes := 0
	streamID := ""
	finished := false
	calls := map[int]*partialCall{}
	redactor := streamRedactor{secret: c.credential, emit: emit}
	consume := func() (bool, error) {
		if len(data) == 0 {
			return false, nil
		}
		payload := data
		data = nil
		if bytes.Equal(payload, []byte("[DONE]")) {
			if !finished {
				return false, failure(Disconnected)
			}
			return true, nil
		}
		if finished || !utf8.Valid(payload) {
			return false, failure(Protocol)
		}
		var event chunk
		if json.Unmarshal(payload, &event) != nil || event.Object != "chat.completion.chunk" || event.ID == "" || len(event.ID) > 256 || len(event.Choices) != 1 {
			return false, failure(Protocol)
		}
		if streamID != "" && streamID != event.ID {
			return false, failure(Protocol)
		}
		streamID = event.ID
		choice := event.Choices[0]
		if choice.Index == nil || *choice.Index != 0 || choice.Delta.Role != "" && choice.Delta.Role != "assistant" {
			return false, failure(Protocol)
		}
		if choice.Delta.Reasoning != "" {
			return false, failure(Unsupported)
		}
		if choice.Delta.Content != nil {
			text.WriteString(*choice.Delta.Content)
			if err := redactor.push(*choice.Delta.Content, false); err != nil {
				return false, failure(Rejected)
			}
		}
		for _, call := range choice.Delta.Calls {
			if call.Index == nil || *call.Index < 0 || *call.Index >= 128 {
				return false, failure(Protocol)
			}
			index := *call.Index
			partial, exists := calls[index]
			if !exists {
				if call.ID == "" || call.Type != "function" || !functionName.MatchString(call.Function.Name) {
					return false, failure(Protocol)
				}
				partial = &partialCall{id: call.ID, name: call.Function.Name}
				calls[index] = partial
			} else if call.ID != "" && call.ID != partial.id || call.Type != "" && call.Type != "function" || call.Function.Name != "" && call.Function.Name != partial.name {
				return false, failure(Protocol)
			}
			partial.arguments.WriteString(call.Function.Arguments)
		}
		if event.Usage != nil {
			if choice.Finish == nil {
				return false, failure(Protocol)
			}
			usage, ok := event.Usage.usage()
			if !ok {
				return false, failure(Protocol)
			}
			result.Usage = usage
		}
		if choice.Finish != nil {
			if *choice.Finish == "" {
				return false, failure(Protocol)
			}
			finished, result.FinishReason = true, *choice.Finish
		}
		return false, nil
	}
	done := false
	for scanner.Scan() {
		if reader.N <= 0 {
			return result, failure(Limit)
		}
		line := scanner.Bytes()
		eventBytes += len(line) + 1
		if eventBytes > c.settings.MaxEventBytes {
			return result, failure(Limit)
		}
		if len(line) == 0 {
			done, err = consume()
			eventBytes = 0
			if err != nil {
				return result, err
			}
			if done {
				break
			}
			continue
		}
		if bytes.HasPrefix(line, []byte("data:")) {
			part := bytes.TrimPrefix(line[5:], []byte(" "))
			if len(data) > 0 {
				data = append(data, '\n')
			}
			data = append(data, part...)
		}
	}
	if !done {
		if reader.N <= 0 {
			return result, failure(Limit)
		}
		if err := scanner.Err(); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return result, contextError(context.DeadlineExceeded, requests)
			}
			if errors.Is(err, bufio.ErrTooLong) {
				return result, failure(Limit)
			}
			return result, failure(Disconnected)
		}
		done, err = consume()
		if err != nil {
			return result, err
		}
		if !done {
			return result, failure(Disconnected)
		}
	}
	switch result.FinishReason {
	case "stop":
		if len(calls) != 0 {
			return result, failure(Protocol)
		}
	case "tool_calls":
		if len(calls) == 0 {
			return result, failure(Protocol)
		}
	case "length":
		return result, failure(Limit)
	case "content_filter":
		return result, failure(Rejected)
	case "insufficient_system_resource", "aborted":
		return result, failure(Disconnected)
	default:
		return result, failure(Unsupported)
	}
	indices := make([]int, 0, len(calls))
	for index := range calls {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	ids := map[string]bool{}
	for position, index := range indices {
		partial := calls[index]
		arguments := json.RawMessage(partial.arguments.String())
		if index != position || ids[partial.id] || len(partial.id) > 256 || !objectJSON(arguments) {
			return result, failure(Protocol)
		}
		ids[partial.id] = true
		// Provider credentials must not be persisted through reflected arguments.
		if strings.Contains(partial.id, c.credential) || strings.Contains(partial.name, c.credential) || containsSecret(arguments, c.credential) {
			return result, failure(Protocol)
		}
		result.ToolCalls = append(result.ToolCalls, domain.ToolCall{ID: partial.id, Name: partial.name, Arguments: arguments, Status: domain.ToolProposed})
	}
	if err := redactor.push("", true); err != nil {
		return result, failure(Rejected)
	}
	result.Complete = true
	return result, nil
}

type streamRedactor struct {
	secret, pending string
	emit            func(string) error
}

// Hold a suffix matching the key prefix so split deltas cannot expose the key.
func (r *streamRedactor) push(value string, final bool) error {
	r.pending = strings.ReplaceAll(r.pending+value, r.secret, "[REDACTED]")
	keep := 0
	if !final {
		for n := min(len(r.secret)-1, len(r.pending)); n > 0; n-- {
			if strings.HasSuffix(r.pending, r.secret[:n]) {
				keep = n
				break
			}
		}
	}
	text := r.pending[:len(r.pending)-keep]
	r.pending = r.pending[len(r.pending)-keep:]
	if r.emit != nil && text != "" {
		return r.emit(text)
	}
	return nil
}

func containsSecret(raw json.RawMessage, secret string) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return true
	}
	var inspect func(any) bool
	inspect = func(value any) bool {
		switch v := value.(type) {
		case string:
			return strings.Contains(v, secret)
		case []any:
			for _, entry := range v {
				if inspect(entry) {
					return true
				}
			}
		case map[string]any:
			for key, entry := range v {
				if strings.Contains(key, secret) || inspect(entry) {
					return true
				}
			}
		}
		return false
	}
	return inspect(value)
}
