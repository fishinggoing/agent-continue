package provider

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/responses"
)

type StreamingClient interface {
	domain.Provider
	Close()
}

func Open(c config.Config, env config.LookupEnv) (StreamingClient, error) {
	if c.Provider.Protocol == config.ProtocolResponses {
		return NewResponses(c, env)
	}
	return New(c, env)
}

type ResponsesClient struct {
	settings     config.Provider
	contextBytes int
	credential   string
	http         *http.Client
	sdk          openai.Client
}

type limitedBody struct {
	io.ReadCloser
	remaining int64
}

func (b *limitedBody) Read(p []byte) (int, error) {
	if b.remaining <= 0 {
		return 0, &Error{Kind: Limit}
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.ReadCloser.Read(p)
	b.remaining -= int64(n)
	return n, err
}

type responseTransport struct {
	base     *http.Transport
	maxBytes int
}

func (t responseTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(r)
	if err == nil {
		response.Body = &limitedBody{ReadCloser: response.Body, remaining: int64(t.maxBytes)}
	}
	return response, err
}

func NewResponses(c config.Config, env config.LookupEnv) (*ResponsesClient, error) {
	if err := config.Validate(c); err != nil {
		return nil, err
	}
	if c.Provider.Protocol != config.ProtocolResponses {
		return nil, &Error{Kind: Unsupported}
	}
	key, err := config.Credential(c.Provider, env)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	h := &http.Client{Transport: responseTransport{base: transport, maxBytes: c.Provider.MaxResponseBytes}, Timeout: time.Duration(c.Provider.TimeoutSeconds) * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	client := &ResponsesClient{settings: c.Provider, contextBytes: c.Limits.MaxContextBytes, credential: key, http: h}
	client.sdk = openai.NewClient(option.WithBaseURL(strings.TrimSuffix(c.Provider.Endpoint, "/responses")+"/"), option.WithAPIKey(key), option.WithMaxRetries(0), option.WithHTTPClient(h), option.WithOrganization(""), option.WithProject(""), option.WithHeader("User-Agent", "agent-continue/0.1"))
	return client, nil
}
func (c *ResponsesClient) Close() { c.http.Transport.(responseTransport).base.CloseIdleConnections() }
func (c *ResponsesClient) Models(ctx context.Context) ([]domain.Model, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return Models(c.settings), nil
}

func (c *ResponsesClient) encode(request domain.ModelRequest) ([]byte, error) {
	var params []byte
	if request.Model != "" && request.Model != c.settings.Model {
		return params, &Error{Kind: Unsupported}
	}
	input := []json.RawMessage{}
	appendItem := func(v any) { b, _ := json.Marshal(v); input = append(input, b) }
	for _, m := range request.Messages {
		var text strings.Builder
		for _, part := range m.Content {
			text.WriteString(part.Text)
		}
		if m.Role == domain.RoleAssistant && len(m.ProviderOutput) != 0 {
			var output []json.RawMessage
			if json.Unmarshal(m.ProviderOutput, &output) != nil {
				return params, &Error{Kind: Protocol}
			}
			input = append(input, output...)
			continue
		}
		if m.Role == domain.RoleTool {
			appendItem(map[string]any{"type": "function_call_output", "call_id": m.ToolCallID, "output": text.String()})
			continue
		}
		if text.Len() > 0 {
			appendItem(map[string]any{"role": m.Role, "content": text.String()})
		}
		for _, call := range m.ToolCalls {
			appendItem(map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Name, "arguments": string(call.Arguments)})
		}
	}
	tools := []map[string]any{}
	for _, tool := range request.Tools {
		tools = append(tools, map[string]any{"type": "function", "name": tool.Name, "description": tool.Description, "parameters": tool.Parameters, "strict": true})
	}
	maxTokens := request.MaxOutputTokens
	if maxTokens == 0 {
		maxTokens = c.settings.MaxOutputTokens
	}
	b, err := json.Marshal(map[string]any{"model": c.settings.Model, "input": input, "tools": tools, "reasoning": map[string]string{"effort": c.settings.ReasoningEffort}, "store": false, "include": []string{"reasoning.encrypted_content"}, "max_output_tokens": maxTokens, "stream": true})
	if err != nil || len(b) > c.contextBytes {
		return params, &Error{Kind: Limit}
	}
	return b, nil
}

func (c *ResponsesClient) Complete(ctx context.Context, request domain.ModelRequest, delta func(string) error) (result domain.ModelResponse, err error) {
	defer func() {
		if err != nil {
			result.Complete = false
			result.ToolCalls = nil
			result.ProviderOutput = nil
		}
	}()
	params, err := c.encode(request)
	if err != nil {
		return result, err
	}
	for attempt := 0; attempt <= c.settings.MaxRetries; attempt++ {
		if ctx.Err() != nil {
			return result, contextError(ctx.Err(), result.Requests)
		}
		result.Requests++
		stream := c.sdk.Responses.NewStreaming(ctx, responses.ResponseNewParams{}, option.WithRequestBody("application/json", params))
		redactor := streamRedactor{secret: c.credential, emit: func(text string) error {
			result.Text += text
			if delta != nil {
				return delta(text)
			}
			return nil
		}}
		for stream.Next() {
			event := stream.Current()
			if len(event.RawJSON()) > c.settings.MaxEventBytes {
				stream.Close()
				return result, &Error{Kind: Limit, Requests: result.Requests}
			}
			switch event.Type {
			case "response.output_text.delta", "response.refusal.delta":
				if e := redactor.push(event.Delta, false); e != nil {
					stream.Close()
					return result, &Error{Kind: Limit, Requests: result.Requests}
				}
			case "response.completed":
				stream.Close()
				if e := redactor.push("", true); e != nil {
					return result, &Error{Kind: Limit, Requests: result.Requests}
				}
				return c.completed(event.Response.RawJSON(), result)
			case "response.failed", "response.incomplete", "error":
				stream.Close()
				return result, &Error{Kind: Rejected, Requests: result.Requests}
			}
		}
		e := stream.Err()
		stream.Close()
		if ctx.Err() != nil {
			return result, contextError(ctx.Err(), result.Requests)
		}
		var apiError *openai.Error
		if errors.As(e, &apiError) {
			if retryable(apiError.StatusCode) && attempt < c.settings.MaxRetries && result.Text == "" {
				if e := wait(ctx, retryDelay("", c.settings.RetryDelayMillis, attempt)); e != nil {
					return result, contextError(e, result.Requests)
				}
				continue
			}
			return result, &Error{Kind: statusKind(apiError.StatusCode), HTTPStatus: apiError.StatusCode, Requests: result.Requests}
		}
		var limit *Error
		if errors.As(e, &limit) {
			return result, &Error{Kind: limit.Kind, Requests: result.Requests}
		}
		if errors.Is(e, context.DeadlineExceeded) {
			return result, contextError(context.DeadlineExceeded, result.Requests)
		}
		return result, &Error{Kind: Disconnected, Requests: result.Requests}
	}
	return result, &Error{Kind: Server, Requests: result.Requests}
}

func (c *ResponsesClient) completed(raw string, result domain.ModelResponse) (domain.ModelResponse, error) {
	var response struct {
		Status string          `json:"status"`
		Output json.RawMessage `json:"output"`
		Usage  *struct {
			Input        *int64 `json:"input_tokens"`
			Output       *int64 `json:"output_tokens"`
			Total        *int64 `json:"total_tokens"`
			InputDetails *struct {
				Cached *int64 `json:"cached_tokens"`
			} `json:"input_tokens_details"`
			OutputDetails *struct {
				Reasoning *int64 `json:"reasoning_tokens"`
			} `json:"output_tokens_details"`
		} `json:"usage"`
	}
	bad := func() (domain.ModelResponse, error) { return result, &Error{Kind: Protocol, Requests: result.Requests} }
	if json.Unmarshal([]byte(raw), &response) != nil || response.Status != "completed" || containsSecret(response.Output, c.credential) {
		return bad()
	}
	var items []struct {
		Type      string `json:"type"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
		Content   []struct {
			Type    string `json:"type"`
			Text    string `json:"text"`
			Refusal string `json:"refusal"`
		} `json:"content"`
	}
	if json.Unmarshal(response.Output, &items) != nil {
		return bad()
	}
	var text strings.Builder
	seen := map[string]bool{}
	for _, item := range items {
		switch item.Type {
		case "message":
			for _, part := range item.Content {
				if part.Type == "output_text" {
					text.WriteString(part.Text)
				}
				if part.Type == "refusal" {
					text.WriteString(part.Refusal)
				}
			}
		case "function_call":
			if item.CallID == "" || item.Name == "" || seen[item.CallID] || !json.Valid([]byte(item.Arguments)) || !strings.HasPrefix(strings.TrimSpace(item.Arguments), "{") || containsSecret(json.RawMessage(item.Arguments), c.credential) {
				return bad()
			}
			seen[item.CallID] = true
			result.ToolCalls = append(result.ToolCalls, domain.ToolCall{ID: item.CallID, Name: item.Name, Arguments: json.RawMessage(item.Arguments), Status: domain.ToolProposed})
		case "reasoning":
		default:
			return bad()
		}
	}
	if result.Text != "" && text.String() != result.Text {
		return bad()
	}
	result.Text = text.String()
	if response.Usage != nil {
		u := response.Usage
		w := wireUsage{Input: u.Input, Output: u.Output, Total: u.Total}
		if u.InputDetails != nil {
			w.Cached = u.InputDetails.Cached
		}
		result.Usage, _ = w.usage()
		if u.OutputDetails != nil {
			result.Usage.ReasoningTokens = u.OutputDetails.Reasoning
		}
		if _, valid := w.usage(); !valid {
			return bad()
		}
	}
	result.ProviderOutput = response.Output
	result.Complete, result.FinishReason = true, "stop"
	return result, nil
}
