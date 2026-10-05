// Package domain defines the versioned contracts for the independent Go runtime.
// Imported content and model output never confer tool execution permission.
package domain

import (
	"context"
	"encoding/json"
	"time"
)

const SchemaVersion = 1

type RunStatus string

const (
	Queued           RunStatus = "queued"
	Running          RunStatus = "running"
	AwaitingApproval RunStatus = "awaiting_approval"
	Completed        RunStatus = "completed"
	Failed           RunStatus = "failed"
	Cancelled        RunStatus = "cancelled"
	Interrupted      RunStatus = "interrupted"
)

type ToolStatus string

const (
	ToolProposed  ToolStatus = "proposed"
	ToolApproved  ToolStatus = "approved"
	ToolRunning   ToolStatus = "running"
	ToolCompleted ToolStatus = "completed"
	ToolFailed    ToolStatus = "failed"
	ToolDenied    ToolStatus = "denied"
	ToolCancelled ToolStatus = "cancelled"
	ToolUnknown   ToolStatus = "unknown"
)

type EndReason string

const (
	EndStop        EndReason = "stop"
	EndError       EndReason = "error"
	EndToolFailure EndReason = "tool_failure"
	EndCancelled   EndReason = "cancelled"
	EndLimit       EndReason = "limit"
	EndQuota       EndReason = "quota"
	EndInterrupted EndReason = "interrupted"
)

const (
	ExitOK        = 0
	ExitFailure   = 1
	ExitCancelled = 2
	ExitLimit     = 3
)

type Session struct {
	Version    int         `json:"version"`
	ID         string      `json:"id"`
	Workspace  string      `json:"workspace"`
	CreatedAt  time.Time   `json:"createdAt"`
	UpdatedAt  time.Time   `json:"updatedAt"`
	ModelRef   string      `json:"modelRef"`
	Status     RunStatus   `json:"status"`
	Provenance *Provenance `json:"provenance,omitempty"`
}

type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

type ContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type Message struct {
	ID         string        `json:"id"`
	Role       Role          `json:"role"`
	Content    []ContentPart `json:"content"`
	Source     string        `json:"source"`
	OriginalID string        `json:"originalId,omitempty"`
	ToolCalls  []ToolCall    `json:"toolCalls,omitempty"`
	ToolCallID string        `json:"toolCallId,omitempty"`
}

// Arguments are complete JSON, but still untrusted until ToolRegistry.Validate.
type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Status    ToolStatus      `json:"status"`
}

type ValidatedToolCall struct {
	Call               ToolCall
	CanonicalArguments json.RawMessage
	ArgumentsHash      string
}

type ToolResult struct {
	CallID    string     `json:"callId"`
	Status    ToolStatus `json:"status"`
	Output    string     `json:"output,omitempty"`
	Stdout    string     `json:"stdout,omitempty"`
	Stderr    string     `json:"stderr,omitempty"`
	ExitCode  *int       `json:"exitCode,omitempty"`
	Truncated bool       `json:"truncated"`
	Error     string     `json:"error,omitempty"`
}

type ToolDefinition struct {
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	Parameters     json.RawMessage `json:"parameters"`
	Writes         bool            `json:"writes"`
	Executes       bool            `json:"executes"`
	MaxOutputBytes int             `json:"maxOutputBytes"`
}

type RunLimits struct {
	MaxSteps           int `json:"maxSteps"`
	MaxDurationSeconds int `json:"maxDurationSeconds"`
	MaxOutputBytes     int `json:"maxOutputBytes"`
	MaxContextBytes    int `json:"maxContextBytes"`
}

type Run struct {
	ID            string    `json:"id"`
	SessionID     string    `json:"sessionId"`
	Status        RunStatus `json:"status"`
	Steps         int       `json:"steps"`
	ModelRequests int       `json:"modelRequests"`
	ToolsExecuted int       `json:"toolsExecuted"`
	Limits        RunLimits `json:"limits"`
	EndReason     EndReason `json:"endReason,omitempty"`
}

// nil means the provider did not supply the counter; explicit zero stays zero.
type Usage struct {
	InputTokens       *int64 `json:"inputTokens"`
	OutputTokens      *int64 `json:"outputTokens"`
	TotalTokens       *int64 `json:"totalTokens"`
	CachedInputTokens *int64 `json:"cachedInputTokens"`
	ReasoningTokens   *int64 `json:"reasoningTokens"`
}

type Approval struct {
	ID            string    `json:"id"`
	SessionID     string    `json:"sessionId"`
	RunID         string    `json:"runId"`
	CallID        string    `json:"callId"`
	ArgumentsHash string    `json:"argumentsHash"`
	Summary       string    `json:"summary"`
	Scope         string    `json:"scope"`
	Status        string    `json:"status"`
	ExpiresAt     time.Time `json:"expiresAt"`
}

type Provenance struct {
	Source   string `json:"source"`
	SourceID string `json:"sourceId"`
	Losses   []Loss `json:"losses"`
}

type Loss struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

type EventType string

const (
	RunStarted         EventType = "run.started"
	MessageDelta       EventType = "message.delta"
	MessageCompleted   EventType = "message.completed"
	ToolProposedEvent  EventType = "tool.proposed"
	ApprovalRequested  EventType = "approval.requested"
	ApprovalResolved   EventType = "approval.resolved"
	ToolStarted        EventType = "tool.started"
	ToolCompletedEvent EventType = "tool.completed"
	UsageUpdated       EventType = "usage.updated"
	RunCompleted       EventType = "run.completed"
	RunFailed          EventType = "run.failed"
	RunCancelled       EventType = "run.cancelled"
)

type Event struct {
	Version   int       `json:"version"`
	Sequence  uint64    `json:"sequence"`
	Time      time.Time `json:"time"`
	SessionID string    `json:"sessionId"`
	RunID     string    `json:"runId"`
	Type      EventType `json:"type"`
	Data      EventData `json:"data"`
}

type EventData struct {
	Text     string      `json:"text,omitempty"`
	Message  *Message    `json:"message,omitempty"`
	Call     *ToolCall   `json:"call,omitempty"`
	Result   *ToolResult `json:"result,omitempty"`
	Approval *Approval   `json:"approval,omitempty"`
	Usage    *Usage      `json:"usage,omitempty"`
	Run      *Run        `json:"run,omitempty"`
	Error    string      `json:"error,omitempty"`
}

type Model struct {
	Provider   string `json:"provider"`
	ID         string `json:"id"`
	Configured bool   `json:"configured"`
	Tools      bool   `json:"tools"`
	Streaming  bool   `json:"streaming"`
}

type ModelRequest struct {
	Model           string
	Messages        []Message
	Tools           []ToolDefinition
	MaxOutputTokens int
}

type ModelResponse struct {
	Text         string     `json:"text"`
	ToolCalls    []ToolCall `json:"toolCalls,omitempty"`
	Usage        Usage      `json:"usage"`
	FinishReason string     `json:"finishReason"`
	Requests     int        `json:"requests"`
	Complete     bool       `json:"complete"`
}

type Provider interface {
	Models(context.Context) ([]Model, error)
	Complete(context.Context, ModelRequest, func(string) error) (ModelResponse, error)
}

type ToolRegistry interface {
	Definitions() []ToolDefinition
	Validate(context.Context, ToolCall) (ValidatedToolCall, error)
	Execute(context.Context, ValidatedToolCall) (ToolResult, error)
}

type PermissionDecision struct {
	Allowed  bool
	Approval *Approval
	Reason   string
}

type ApprovalDecision struct {
	ApprovalID    string
	SessionID     string
	RunID         string
	CallID        string
	ArgumentsHash string
	Allow         bool
}

type PermissionService interface {
	Check(context.Context, string, string, ValidatedToolCall) (PermissionDecision, error)
	Resolve(context.Context, ApprovalDecision) error
}

type SessionStore interface {
	Create(context.Context, Session) error
	Get(context.Context, string) (Session, error)
	List(context.Context) ([]Session, error)
	Append(context.Context, Event) (Event, error)
	Events(context.Context, string, uint64) ([]Event, error)
	Acquire(context.Context, string, string) (Lease, error)
}

type Lease interface{ Release() error }

type StartRequest struct {
	Workspace string
	Prompt    string
	ModelRef  string
	Limits    RunLimits
}

type TaskService interface {
	Start(context.Context, StartRequest) (Run, error)
	Continue(context.Context, string, string) (Run, error)
	Cancel(context.Context, string) error
	Events(context.Context, string, uint64) (<-chan Event, error)
}
