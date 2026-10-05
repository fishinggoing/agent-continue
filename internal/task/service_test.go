package task

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fishinggoing/agent-continue/internal/domain"
)

func openTestService(t *testing.T) *Service {
	t.Helper()
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func waitFor(t *testing.T, s *Service, id string, status domain.RunStatus) Snapshot {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		snap, err := s.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if snap.Session.Status == status {
			return snap
		}
		if snap.Session.Status == domain.Failed && status != domain.Failed {
			t.Fatalf("unexpected failure: %+v", snap)
		}
		time.Sleep(5 * time.Millisecond)
	}
	snap, _ := s.Get(id)
	t.Fatalf("waiting for %s: %+v", status, snap)
	return Snapshot{}
}
func pendingApproval(t *testing.T, snap Snapshot) domain.Approval {
	t.Helper()
	for _, entry := range snap.Tools {
		if entry.Approval != nil && entry.Approval.Status == "pending" {
			return *entry.Approval
		}
	}
	t.Fatal("missing approval")
	return domain.Approval{}
}
func resolve(s *Service, p domain.Approval, allow bool) error {
	return s.Resolve(p.SessionID, domain.ApprovalDecision{ApprovalID: p.ID, RunID: p.RunID, CallID: p.CallID, ArgumentsHash: p.ArgumentsHash, Allow: allow})
}

func TestDemoActualFilesApprovalTestsAndPersistence(t *testing.T) {
	s := openTestService(t)
	ctx := context.Background()
	run, err := s.Start(ctx, domain.StartRequest{Prompt: "Fix discount and verify", ModelRef: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	snap := waitFor(t, s, run.SessionID, domain.AwaitingApproval)
	p := pendingApproval(t, snap)
	before, _ := s.File(run.SessionID, "pricing.json")
	if before != originalRules {
		t.Fatal("unapproved write")
	}
	if _, err = s.Continue(ctx, run.SessionID, "duplicate"); err != ErrConflict {
		t.Fatalf("duplicate run: %v", err)
	}
	bad := p
	bad.ArgumentsHash = "different"
	if resolve(s, bad, true) == nil {
		t.Fatal("approval accepted changed parameters")
	}
	bad = p
	bad.RunID = "other-run"
	if resolve(s, bad, true) == nil {
		t.Fatal("approval accepted other run")
	}
	if err = resolve(s, p, true); err != nil {
		t.Fatal(err)
	}
	snap = waitFor(t, s, run.SessionID, domain.Completed)
	after, _ := s.File(run.SessionID, "pricing.json")
	if after != fixedRules {
		t.Fatalf("disk differs: %s", after)
	}
	if len(snap.Tools) != 4 || snap.Runs[0].ToolsExecuted != 4 || snap.Runs[0].ModelRequests != 0 {
		t.Fatalf("execution counts: %+v", snap)
	}
	if snap.Tools[1].Result.Status != domain.ToolFailed || *snap.Tools[1].Result.ExitCode != 1 || *snap.Tools[3].Result.ExitCode != 0 {
		t.Fatal("tests did not actually fail then pass")
	}
	if resolve(s, p, true) == nil {
		t.Fatal("approval replay accepted")
	}
	events, err := s.store.Events(ctx, run.SessionID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for i, e := range events {
		if e.Sequence != uint64(i+1) {
			t.Fatal("non-contiguous event sequence")
		}
	}
	if uint64(len(events)) != snap.Sequence {
		t.Fatal("snapshot/event cursor mismatch")
	}
	dir := s.dir
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	loaded, err := reopened.Get(run.SessionID)
	if err != nil || loaded.Session.Status != domain.Completed || len(loaded.Messages) != len(snap.Messages) {
		t.Fatal("session did not survive restart")
	}
	if _, err = reopened.Continue(ctx, run.SessionID, "Verify again"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, reopened, run.SessionID, domain.Completed)
}

func TestRejectedAndCancelledWritesHaveNoEffect(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{true: "cancel", false: "deny"}[cancel], func(t *testing.T) {
			s := openTestService(t)
			run, err := s.Start(context.Background(), domain.StartRequest{Prompt: "Fix pricing", ModelRef: "demo"})
			if err != nil {
				t.Fatal(err)
			}
			p := pendingApproval(t, waitFor(t, s, run.SessionID, domain.AwaitingApproval))
			status := domain.Completed
			if cancel {
				err = s.Cancel(context.Background(), run.SessionID)
				status = domain.Cancelled
			} else {
				err = resolve(s, p, false)
			}
			if err != nil {
				t.Fatal(err)
			}
			waitFor(t, s, run.SessionID, status)
			disk, _ := s.File(run.SessionID, "pricing.json")
			if disk != originalRules {
				t.Fatal("denied/cancelled write changed disk")
			}
		})
	}
}

func TestRecoveryMarksUnknownAndNeverReplays(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := newID()
	now := time.Now().UTC()
	project := filepath.Join(dir, "projects", id)
	os.MkdirAll(project, 0700)
	os.WriteFile(filepath.Join(project, "pricing.json"), []byte(fixedRules), 0600)
	snap := &Snapshot{Session: domain.Session{Version: 1, ID: id, CreatedAt: now, UpdatedAt: now, ModelRef: "demo", Status: domain.Running}, Runs: []domain.Run{{ID: "run", Status: domain.Running}}, Tools: []ToolEntry{{RunID: "run", Call: domain.ToolCall{ID: "call", Name: "apply_patch", Status: domain.ToolRunning}}}}
	s.sessions[id] = snap
	if err = s.recordLocked(snap, domain.ToolStarted, domain.EventData{}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, _ := s.Get(id)
	if got.Session.Status != domain.Interrupted || got.Tools[0].Call.Status != domain.ToolUnknown {
		t.Fatalf("recovery: %+v", got)
	}
	disk, _ := s.File(id, "pricing.json")
	if disk != fixedRules {
		t.Fatal("recovery replayed a write")
	}
}

func TestToolBoundariesConflictAndActualTests(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "pricing.json"), []byte(originalRules), 0600)
	os.WriteFile(filepath.Join(dir, "pricing.test.json"), []byte(testCases), 0600)
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	f := &Files{root: root}
	ctx := context.Background()
	for _, c := range []domain.ToolCall{
		{ID: "id", Name: "read_file", Arguments: json.RawMessage(`{"path":"../secret"}`)},
		{ID: "id", Name: "read_file", Arguments: json.RawMessage(`{"path":"pricing.json","cwd":"/"}`)},
		{ID: "id", Name: "run_tests", Arguments: json.RawMessage(`{"command":"shell"}`)},
		{ID: "id", Name: "execute", Arguments: json.RawMessage(`{}`)},
		{ID: "id", Name: "apply_patch", Arguments: json.RawMessage(`{"path":"pricing.test.json","before":"a","after":"b"}`)},
	} {
		if _, err = f.Validate(ctx, c); err == nil {
			t.Fatalf("accepted unsafe call: %+v", c)
		}
	}
	call := domain.ToolCall{ID: "patch", Name: "apply_patch", Arguments: json.RawMessage(`{"path":"pricing.json","before":"changed-before-approval","after":"new"}`)}
	v, err := f.Validate(ctx, call)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Execute(ctx, v); err == nil || !strings.Contains(err.Error(), "conflict") {
		t.Fatal("expected conflict rejection")
	}
	if err = os.Symlink("pricing.json", filepath.Join(dir, "pricing.test.json.link")); err == nil {
		os.Remove(filepath.Join(dir, "pricing.test.json"))
		os.Rename(filepath.Join(dir, "pricing.test.json.link"), filepath.Join(dir, "pricing.test.json"))
		if _, err = f.Read("pricing.test.json"); err == nil {
			t.Fatal("symbolic link accepted")
		}
	}
}

func TestDatabaseHasOneProcessOwner(t *testing.T) {
	s := openTestService(t)
	second, err := Open(s.dir)
	if err == nil {
		second.Close()
		t.Fatal("two writers opened same data directory")
	}
}

func TestReadonlyPolicyCannotBeOverriddenByApproval(t *testing.T) {
	s := openTestService(t)
	s.config.Tools.Mode = "readonly"
	run, err := s.Start(context.Background(), domain.StartRequest{Prompt: "Fix pricing", ModelRef: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	snap := waitFor(t, s, run.SessionID, domain.Completed)
	for _, entry := range snap.Tools {
		if entry.Call.Name == "apply_patch" && (entry.Approval != nil || entry.Call.Status != domain.ToolDenied) {
			t.Fatal("readonly write reached approval/execution")
		}
	}
	disk, _ := s.File(run.SessionID, "pricing.json")
	if disk != originalRules {
		t.Fatal("readonly policy changed disk")
	}
}

func TestDurationLimitIsNotReportedAsUserCancellation(t *testing.T) {
	s := openTestService(t)
	s.config.Limits.MaxDurationSeconds = 1
	run, err := s.Start(context.Background(), domain.StartRequest{Prompt: "Fix pricing", ModelRef: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, s, run.SessionID, domain.AwaitingApproval)
	snap := waitFor(t, s, run.SessionID, domain.Failed)
	if snap.Runs[0].EndReason != domain.EndLimit {
		t.Fatalf("wrong end reason: %s", snap.Runs[0].EndReason)
	}
	disk, _ := s.File(run.SessionID, "pricing.json")
	if disk != originalRules {
		t.Fatal("duration limit allowed a write")
	}
}
