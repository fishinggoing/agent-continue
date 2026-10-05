package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/task"
)

// Streams keeps terminal detection and process globals outside command execution.
type Streams struct {
	In          io.Reader
	Out         io.Writer
	Err         io.Writer
	Interactive bool
}

type ExitError struct {
	Code    int
	Message string
}

func (e *ExitError) Error() string { return e.Message }

func ExitCode(err error) int {
	if err == nil {
		return domain.ExitOK
	}
	var exit *ExitError
	if errors.As(err, &exit) {
		return exit.Code
	}
	return domain.ExitFailure
}

func cancelled() error {
	return &ExitError{Code: domain.ExitCancelled, Message: "task cancelled"}
}

func runtimeOptions(args []string, allowed string) (map[string]string, error) {
	flags := map[string]string{}
	valid := map[string]bool{}
	for _, name := range strings.Fields(allowed) {
		valid[name] = true
	}
	for i := 0; i < len(args); i++ {
		name := strings.TrimPrefix(args[i], "--")
		if !strings.HasPrefix(args[i], "--") || !valid[name] {
			return nil, errors.New("unknown option or unexpected positional argument")
		}
		if _, exists := flags[name]; exists {
			return nil, fmt.Errorf("duplicate option --%s", name)
		}
		if name == "json" {
			flags[name] = "true"
			continue
		}
		i++
		if i >= len(args) || args[i] == "" || strings.HasPrefix(args[i], "--") {
			return nil, fmt.Errorf("missing value for --%s", name)
		}
		flags[name] = args[i]
	}
	return flags, nil
}

// ExecuteContext runs model commands with injectable IO; legacy commands retain
// Execute's output and parsing contracts.
func ExecuteContext(ctx context.Context, args []string, streams Streams, env config.LookupEnv) (bool, error) {
	if streams.In == nil {
		streams.In = strings.NewReader("")
	}
	if streams.Out == nil {
		streams.Out = io.Discard
	}
	if streams.Err == nil {
		streams.Err = io.Discard
	}
	if len(args) == 0 {
		return Execute(args, streams.Out, env)
	}
	switch args[0] {
	case "run", "chat", "resume", "sessions":
		return true, executeRuntime(ctx, args, streams, env)
	default:
		return Execute(args, streams.Out, env)
	}
}

func executeRuntime(ctx context.Context, args []string, streams Streams, env config.LookupEnv) error {
	command, remaining := args[0], args[1:]
	id, subcommand, allowed := "", "", "config model"
	switch command {
	case "run":
		allowed += " cwd prompt json"
	case "chat":
		allowed += " cwd"
	case "resume":
		if len(remaining) == 0 || strings.HasPrefix(remaining[0], "--") {
			return errors.New("resume requires a session ID")
		}
		id, remaining = remaining[0], remaining[1:]
		allowed += " prompt json"
	case "sessions":
		if len(remaining) == 0 {
			return errors.New("sessions requires list, show or export")
		}
		subcommand, remaining = remaining[0], remaining[1:]
		allowed = "config"
		switch subcommand {
		case "list":
		case "show", "export":
			if len(remaining) == 0 || strings.HasPrefix(remaining[0], "--") {
				return errors.New("sessions show/export requires a session ID")
			}
			id, remaining = remaining[0], remaining[1:]
		default:
			return errors.New("unknown sessions subcommand")
		}
	}
	flags, err := runtimeOptions(remaining, allowed)
	if err != nil {
		return err
	}
	if command == "run" && flags["cwd"] == "" {
		return errors.New("run requires an explicit --cwd directory")
	}
	if err := ctx.Err(); err != nil {
		return cancelled()
	}
	path, err := config.Path(flags["config"], env)
	if err != nil {
		return err
	}
	c, err := config.Load(config.Overrides{Path: path, Model: flags["model"]}, env)
	if err != nil {
		return err
	}
	s, err := task.OpenLocal(c, env, path)
	if err != nil {
		return err
	}
	defer s.Close()
	if command == "sessions" {
		if subcommand == "list" {
			return output(streams.Out, s.List())
		}
		snap, err := s.Get(id)
		if err != nil {
			return err
		}
		return output(streams.Out, snap)
	}
	cwd := flags["cwd"]
	var after uint64
	if command == "resume" {
		snap, err := s.Get(id)
		if err != nil {
			return err
		}
		cwd, after = snap.Session.Workspace, snap.Sequence
	}
	if command == "chat" && cwd == "" {
		cwd, err = os.Getwd()
		if err != nil {
			return errors.New("cannot locate current workspace; use --cwd")
		}
	}
	if cwd != "" {
		cwd, err = filepath.Abs(cwd)
		if err != nil {
			return errors.New("cannot resolve workspace directory")
		}
	}
	input := newLineInput(ctx, streams.In)
	defer input.close()
	if command == "chat" || command == "resume" && flags["prompt"] == "" && flags["json"] == "" && streams.Interactive {
		return chat(ctx, s, streams, input, cwd, id, after)
	}
	prompt := flags["prompt"]
	if prompt == "" {
		if streams.Interactive && flags["json"] == "" {
			if err := terminalWrite(streams.Err, "Prompt: "); err != nil {
				return err
			}
			prompt, err = input.read(ctx)
		} else {
			prompt, err = stdinPrompt(ctx, streams.In)
		}
		if err != nil {
			return err
		}
	}
	run, err := startTurn(ctx, s, cwd, id, prompt)
	if err != nil {
		return err
	}
	return consumeRun(ctx, s, run, after, streams, input, flags["json"] != "")
}

func startTurn(ctx context.Context, s *task.Service, cwd, id, prompt string) (domain.Run, error) {
	if ctx.Err() != nil {
		return domain.Run{}, cancelled()
	}
	var run domain.Run
	var err error
	if id != "" {
		run, err = s.Continue(ctx, id, prompt)
	} else {
		run, err = s.Start(ctx, domain.StartRequest{Workspace: cwd, Prompt: prompt, ModelRef: s.ProviderID()})
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return domain.Run{}, cancelled()
	}
	return run, err
}

func chat(ctx context.Context, s *task.Service, streams Streams, input *lineInput, cwd, id string, after uint64) error {
	if id != "" {
		if err := terminalWrite(streams.Err, "Session: "+id+"\n"); err != nil {
			return err
		}
	}
	for {
		if streams.Interactive {
			if err := terminalWrite(streams.Err, "> "); err != nil {
				return err
			}
		}
		prompt, err := input.read(ctx)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		switch strings.TrimSpace(prompt) {
		case "":
			continue
		case "/exit", "/quit":
			return nil
		case "/new":
			id, after = "", 0
			continue
		case "/help":
			if err := terminalWrite(streams.Err, "/new  /exit  /quit\n"); err != nil {
				return err
			}
			continue
		}
		run, err := startTurn(ctx, s, cwd, id, prompt)
		if err != nil {
			return err
		}
		id = run.SessionID
		if err := consumeRun(ctx, s, run, after, streams, input, false); err != nil {
			return err
		}
		snap, err := s.Get(id)
		if err != nil {
			return err
		}
		after = snap.Sequence
	}
}

func consumeRun(ctx context.Context, s *task.Service, run domain.Run, after uint64, streams Streams, input *lineInput, jsonMode bool) error {
	// The task engine outlives its start context. Keep reading persisted events
	// after cancellation until the terminal run has been committed.
	eventCtx, stop := context.WithCancel(context.Background())
	defer stop()
	events, err := s.Events(eventCtx, run.SessionID, after)
	if err != nil {
		_ = s.Cancel(context.Background(), run.SessionID)
		return err
	}
	defer s.Cancel(context.Background(), run.SessionID)
	if !jsonMode {
		if err := terminalWrite(streams.Err, "Session: "+run.SessionID+"\n"); err != nil {
			return err
		}
	}
	encoder := json.NewEncoder(streams.Out)
	health := time.NewTicker(time.Second)
	defer health.Stop()
	done := ctx.Done()
	var deadline <-chan time.Time
	var cleanup *time.Timer
	defer func() {
		if cleanup != nil {
			cleanup.Stop()
		}
	}()
	printed := false
	var pending *domain.Approval
	var answer <-chan inputLine
	var stopAnswer context.CancelFunc
	defer func() {
		if stopAnswer != nil {
			stopAnswer()
		}
	}()
	resolve := func(approval *domain.Approval, allow bool) error {
		decision := domain.ApprovalDecision{ApprovalID: approval.ID, RunID: run.ID, CallID: approval.CallID, ArgumentsHash: approval.ArgumentsHash, Allow: allow}
		if err := s.Resolve(run.SessionID, decision); err != nil && ctx.Err() == nil {
			snap, getErr := s.Get(run.SessionID)
			if getErr == nil && len(snap.Runs) > 0 {
				last := snap.Runs[len(snap.Runs)-1]
				if last.ID == run.ID && last.Status != domain.Running && last.Status != domain.AwaitingApproval && last.Status != domain.Queued {
					return nil
				}
			}
			return errors.New("cannot resolve current write approval")
		}
		return nil
	}
	for {
		select {
		case <-done:
			_ = s.Cancel(context.Background(), run.SessionID)
			done = nil
			cleanup = time.NewTimer(10 * time.Second)
			deadline = cleanup.C
		case <-deadline:
			return cancelled()
		case line := <-answer:
			stopAnswer()
			stopAnswer = nil
			answer = nil
			allow := false
			if line.err != nil && !errors.Is(line.err, io.EOF) {
				_ = s.Cancel(context.Background(), run.SessionID)
				pending = nil
				continue
			} else {
				allow = strings.EqualFold(strings.TrimSpace(line.text), "y") || strings.EqualFold(strings.TrimSpace(line.text), "yes")
			}
			if err := resolve(pending, allow); err != nil {
				return err
			}
			pending = nil
		case <-health.C:
			snap, err := s.Get(run.SessionID)
			if err != nil {
				return errors.New("cannot inspect current task state")
			}
			if len(snap.Runs) > 0 && snap.Runs[len(snap.Runs)-1].ID == run.ID && snap.Runs[len(snap.Runs)-1].Status == domain.Interrupted {
				return errors.New("run interrupted because its terminal event could not be persisted")
			}
		case event, ok := <-events:
			if !ok {
				return errors.New("task event stream ended before a persisted terminal event")
			}
			if event.RunID != run.ID {
				continue
			}
			if jsonMode {
				if err := encoder.Encode(event); err != nil {
					return errors.New("cannot write task event output")
				}
			} else if err := renderEvent(streams, event, &printed); err != nil {
				return err
			}
			if event.Type == domain.ApprovalRequested && event.Data.Approval != nil {
				approval := event.Data.Approval
				if streams.Interactive && !jsonMode && ctx.Err() == nil {
					if err := terminalWrite(streams.Err, "\nWrite request "+approval.Scope+"\n"+approval.Summary+"\nAllow once? [y/N]: "); err != nil {
						return err
					}
					approvalCtx, cancel := context.WithDeadline(ctx, approval.ExpiresAt)
					stopAnswer, pending = cancel, approval
					reply := make(chan inputLine, 1)
					answer = reply
					go func() {
						text, err := input.read(approvalCtx)
						reply <- inputLine{text: text, err: err}
					}()
				} else if err := resolve(approval, false); err != nil {
					return err
				}
			}
			if event.Type == domain.RunCompleted || event.Type == domain.RunFailed || event.Type == domain.RunCancelled {
				if event.Data.Run == nil {
					return errors.New("terminal event lacks persisted run")
				}
				return runOutcome(*event.Data.Run, event.Data.Error)
			}
		}
	}
}

func renderEvent(streams Streams, event domain.Event, printed *bool) error {
	switch event.Type {
	case domain.MessageDelta:
		*printed = true
		return terminalWrite(streams.Out, event.Data.Text)
	case domain.MessageCompleted:
		if !*printed && event.Data.Message != nil {
			for _, part := range event.Data.Message.Content {
				if part.Type == "text" {
					if err := terminalWrite(streams.Out, part.Text); err != nil {
						return err
					}
				}
			}
		}
		*printed = false
		return terminalWrite(streams.Out, "\n")
	case domain.ToolProposedEvent:
		if event.Data.Call != nil {
			return terminalWrite(streams.Err, "Tool: "+event.Data.Call.Name+"\n")
		}
	case domain.ToolCompletedEvent:
		if event.Data.Result != nil {
			r := event.Data.Result
			return terminalWrite(streams.Err, "Tool result: "+string(r.Status)+" "+r.Error+"\n")
		}
	case domain.RunCompleted, domain.RunFailed, domain.RunCancelled:
		if event.Data.Run != nil {
			r := event.Data.Run
			return terminalWrite(streams.Err, fmt.Sprintf("Run: %s (%s), requests=%d tools=%d\n", r.Status, r.EndReason, r.ModelRequests, r.ToolsExecuted))
		}
	}
	return nil
}

func runOutcome(run domain.Run, message string) error {
	code := domain.ExitFailure
	if run.EndReason == domain.EndCancelled {
		code = domain.ExitCancelled
	} else if run.EndReason == domain.EndLimit {
		code = domain.ExitLimit
	} else if run.Status == domain.Completed {
		return nil
	}
	if message == "" {
		message = "run ended: " + string(run.EndReason)
	}
	return &ExitError{Code: code, Message: message}
}

// Only printable text, LF and TAB may reach a terminal. Filtering each delta
// also removes ESC/C1 introducers when control sequences span model events.
func terminalWrite(w io.Writer, value string) error {
	value = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, value)
	if _, err := io.WriteString(w, value); err != nil {
		return errors.New("cannot write terminal output")
	}
	return nil
}

type inputLine struct {
	text string
	err  error
}

type lineInput struct {
	requests chan chan inputLine
	stop     context.CancelFunc
}

func newLineInput(ctx context.Context, r io.Reader) *lineInput {
	ctx, cancel := context.WithCancel(ctx)
	input := &lineInput{requests: make(chan chan inputLine), stop: cancel}
	go func() {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 1024), 8194)
		for {
			select {
			case <-ctx.Done():
				return
			case reply := <-input.requests:
				line := inputLine{err: io.EOF}
				if scanner.Scan() {
					line = inputLine{text: scanner.Text()}
					if len(line.text) > 8192 {
						line.err = errors.New("input line exceeds 8192 bytes")
					}
				} else if scanner.Err() != nil {
					line.err = errors.New("cannot read input line; maximum 8192 bytes")
				}
				reply <- line
			}
		}
	}()
	return input
}

func (input *lineInput) close() { input.stop() }

func (input *lineInput) read(ctx context.Context) (string, error) {
	if ctx.Err() != nil {
		return "", cancelled()
	}
	reply := make(chan inputLine, 1)
	select {
	case input.requests <- reply:
	case <-ctx.Done():
		return "", cancelled()
	}
	select {
	case line := <-reply:
		if ctx.Err() != nil {
			return "", cancelled()
		}
		return line.text, line.err
	case <-ctx.Done():
		return "", cancelled()
	}
}

func stdinPrompt(ctx context.Context, r io.Reader) (string, error) {
	result := make(chan inputLine, 1)
	go func() {
		b, err := io.ReadAll(io.LimitReader(r, 8193))
		if err != nil {
			err = errors.New("cannot read prompt from stdin")
		} else if len(b) > 8192 {
			err = errors.New("stdin prompt exceeds 8192 bytes")
		}
		result <- inputLine{text: string(b), err: err}
	}()
	select {
	case line := <-result:
		return line.text, line.err
	case <-ctx.Done():
		return "", cancelled()
	}
}
