package task

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/session"
)

func TestUserServiceIsolationAndForeignMutationsHaveNoEffect(t *testing.T) {
	s := openTestService(t)
	ctx := context.Background()
	alice, _, err := s.CreateUser(ctx, "Alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := s.CreateUser(ctx, "Bob")
	if err != nil {
		t.Fatal(err)
	}
	a, b := s.ForUser(alice.ID), s.ForUser(bob.ID)
	run, err := a.StartWithFiles(ctx, domain.StartRequest{Prompt: "Alice private history", ModelRef: "demo"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	before := waitFor(t, s, run.SessionID, domain.AwaitingApproval)
	p := pendingApproval(t, before)
	beforeEvents, err := s.store.Events(ctx, run.SessionID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if before.OwnerID != alice.ID || len(a.List()) != 1 || len(b.List()) != 0 || len(s.ForUser(session.DefaultOwnerID).List()) != 0 {
		t.Fatal("session ownership or history filter is incorrect")
	}
	for name, call := range map[string]func() error{
		"snapshot": func() error { _, err := b.Get(run.SessionID); return err },
		"files":    func() error { _, err := b.FileList(run.SessionID); return err },
		"file":     func() error { _, err := b.File(run.SessionID, "pricing.json"); return err },
		"events":   func() error { _, err := b.Events(ctx, run.SessionID, 0); return err },
		"continue": func() error {
			_, err := b.ContinueWithFiles(ctx, run.SessionID, "Foreign prompt", []FileInput{{Path: "injected.txt", Content: "foreign file"}})
			return err
		},
		"cancel": func() error { return b.Cancel(ctx, run.SessionID) },
		"approve": func() error {
			return b.Resolve(run.SessionID, domain.ApprovalDecision{ApprovalID: p.ID, RunID: p.RunID, CallID: p.CallID, ArgumentsHash: p.ArgumentsHash, Allow: true})
		},
		"deny": func() error {
			return b.Resolve(run.SessionID, domain.ApprovalDecision{ApprovalID: p.ID, RunID: p.RunID, CallID: p.CallID, ArgumentsHash: p.ArgumentsHash, Allow: false})
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := call(); !errors.Is(err, ErrNotFound) {
				t.Fatalf("foreign operation did not hide session existence: %v", err)
			}
		})
	}
	after, err := a.Get(run.SessionID)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("foreign operation changed session state or messages")
	}
	afterEvents, err := s.store.Events(ctx, run.SessionID, 0)
	if err != nil || !reflect.DeepEqual(beforeEvents, afterEvents) {
		t.Fatal("foreign operation appended or changed events")
	}
	file, err := a.File(run.SessionID, "pricing.json")
	if err != nil || file != originalRules {
		t.Fatal("foreign approval modified disk")
	}
	if _, err := os.Stat(filepath.Join(s.dir, "projects", run.SessionID, "injected.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("foreign continuation uploaded a file")
	}
	eventCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	events, err := a.Events(eventCtx, run.SessionID, 0)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case event, ok := <-events:
		if !ok || event.SessionID != run.SessionID || event.Sequence != 1 {
			t.Fatal("owner cannot replay own session events")
		}
	case <-eventCtx.Done():
		t.Fatal("owner event replay timed out")
	}
	cancel()
	if err := a.Resolve(run.SessionID, domain.ApprovalDecision{ApprovalID: p.ID, RunID: p.RunID, CallID: p.CallID, ArgumentsHash: p.ArgumentsHash, Allow: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, s, run.SessionID, domain.Completed)
	if file, err := a.File(run.SessionID, "pricing.json"); err != nil || file != fixedRules {
		t.Fatal("owner approval did not perform the intended write")
	}
	if _, err := s.ForUser("").Get(run.SessionID); !errors.Is(err, ErrNotFound) {
		t.Fatal("empty identity can access a session")
	}
	if _, err := s.ForUser("").StartWithFiles(ctx, domain.StartRequest{Prompt: "Anonymous", ModelRef: "demo"}, nil); !errors.Is(err, ErrNotFound) {
		t.Fatal("empty identity can create a session")
	}
}

func TestUsersAndOwnershipPersistWithoutPlaintextTokens(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	alice, token, err := s.CreateUser(ctx, " Alice ")
	if err != nil {
		s.Close()
		t.Fatal(err)
	}
	if alice.Name != "Alice" || alice.Admin {
		t.Fatal("created user name or privilege is incorrect")
	}
	for _, invalid := range []string{"Alice", " ", "Alice\nBob"} {
		if _, _, err := s.CreateUser(ctx, invalid); err == nil {
			t.Fatal("duplicate or invalid name accepted")
		}
	}
	authenticated, err := s.AuthenticateUser(ctx, token)
	if err != nil || authenticated != alice {
		t.Fatal("created user's token does not authenticate")
	}
	if _, err := s.AuthenticateUser(ctx, token+"changed"); err == nil {
		t.Fatal("altered token authenticates")
	}
	run, err := s.ForUser(alice.ID).StartWithFiles(ctx, domain.StartRequest{Prompt: "Alice private persistent history", ModelRef: "demo"}, nil)
	if err != nil {
		s.Close()
		t.Fatal(err)
	}
	p := pendingApproval(t, waitFor(t, s, run.SessionID, domain.AwaitingApproval))
	if err := s.ForUser(alice.ID).Resolve(run.SessionID, domain.ApprovalDecision{ApprovalID: p.ID, RunID: p.RunID, CallID: p.CallID, ArgumentsHash: p.ArgumentsHash, Allow: false}); err != nil {
		s.Close()
		t.Fatal(err)
	}
	before := waitFor(t, s, run.SessionID, domain.Completed)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := sql.Open("sqlite", filepath.Join(dir, "sessions-v1.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	var storedHash string
	err = db.QueryRowContext(ctx, "SELECT token_hash FROM users WHERE id=?", alice.ID).Scan(&storedHash)
	db.Close()
	digest := sha256.Sum256([]byte(token))
	if err != nil || storedHash != hex.EncodeToString(digest[:]) || storedHash == token {
		t.Fatal("database did not store only a token digest")
	}
	databaseBytes, err := os.ReadFile(filepath.Join(dir, "sessions-v1.sqlite"))
	if err != nil || bytes.Contains(databaseBytes, []byte(token)) {
		t.Fatal("database contains plaintext user token")
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	authenticated, err = s.AuthenticateUser(ctx, token)
	if err != nil || authenticated != alice {
		t.Fatal("user authentication did not survive restart")
	}
	loaded, err := s.ForUser(alice.ID).Get(run.SessionID)
	if err != nil || !reflect.DeepEqual(before, loaded) || len(s.ForUser(alice.ID).List()) != 1 || len(s.ForUser(session.DefaultOwnerID).List()) != 0 {
		t.Fatal("ownership or history changed on restart")
	}
}

func TestLegacySessionsMigrateToOwnerWithoutChangingEventSequence(t *testing.T) {
	t.Setenv("AGENT_CONTINUE_CONFIG", "")
	t.Setenv("DEEPSEEK_API_KEY", "")
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	alice, token, err := s.CreateUser(ctx, "Alice")
	if err != nil {
		s.Close()
		t.Fatal(err)
	}
	run, err := s.Start(ctx, domain.StartRequest{Prompt: "Legacy owner history", ModelRef: "demo"})
	if err != nil {
		s.Close()
		t.Fatal(err)
	}
	p := pendingApproval(t, waitFor(t, s, run.SessionID, domain.AwaitingApproval))
	if err := resolve(s, p, false); err != nil {
		s.Close()
		t.Fatal(err)
	}
	before := waitFor(t, s, run.SessionID, domain.Completed)
	beforeEvents, err := s.store.Events(ctx, run.SessionID, 0)
	if err != nil {
		s.Close()
		t.Fatal(err)
	}
	// Remove the field entirely to reproduce a pre-isolation persisted snapshot.
	body, _ := json.Marshal(before)
	var legacy map[string]json.RawMessage
	if err := json.Unmarshal(body, &legacy); err != nil {
		s.Close()
		t.Fatal(err)
	}
	delete(legacy, "ownerId")
	if err := s.store.Save(ctx, run.SessionID, legacy, nil); err != nil {
		s.Close()
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	loaded, err := s.ForUser(session.DefaultOwnerID).Get(run.SessionID)
	if err != nil || !reflect.DeepEqual(before, loaded) || loaded.Sequence != before.Sequence {
		t.Fatal("migration changed legacy history or event cursor")
	}
	afterEvents, err := s.store.Events(ctx, run.SessionID, 0)
	if err != nil || !reflect.DeepEqual(beforeEvents, afterEvents) {
		t.Fatal("ownership migration changed or appended events")
	}
	if _, err := s.AuthenticateUser(ctx, token); err != nil {
		t.Fatal("user authentication was lost during legacy migration")
	}
	if len(s.ForUser(alice.ID).List()) != 0 {
		t.Fatal("new user inherited legacy owner history")
	}
	if _, err := s.ForUser(alice.ID).Get(run.SessionID); !errors.Is(err, ErrNotFound) {
		t.Fatal("new user can access legacy owner history")
	}
	stored, err := s.store.Load(ctx)
	if err != nil || len(stored) != 1 {
		t.Fatal("cannot verify migrated snapshot persistence")
	}
	var persisted Snapshot
	if json.Unmarshal(stored[0], &persisted) != nil || persisted.OwnerID != session.DefaultOwnerID || persisted.Sequence != before.Sequence {
		t.Fatal("migrated owner was not saved without changing sequence")
	}
}

func TestPerUserRunAndSessionLimitsPreserveOtherUsersCapacity(t *testing.T) {
	s := openTestService(t)
	ctx := context.Background()
	alice, _, err := s.CreateUser(ctx, "Alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := s.CreateUser(ctx, "Bob")
	if err != nil {
		t.Fatal(err)
	}
	a := s.ForUser(alice.ID)
	run, err := a.StartWithFiles(ctx, domain.StartRequest{Prompt: "private", ModelRef: "demo"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, s, run.SessionID, domain.AwaitingApproval)
	if _, err := a.StartWithFiles(ctx, domain.StartRequest{Prompt: "another", ModelRef: "demo"}, nil); err == nil {
		t.Fatal("one user monopolized active runs")
	}
	projects, err := os.ReadDir(filepath.Join(s.dir, "projects"))
	if err != nil || len(projects) != 1 {
		t.Fatal("rejected run created an orphan workspace")
	}
	if _, err := s.ForUser(bob.ID).StartWithFiles(ctx, domain.StartRequest{Prompt: "Bob", ModelRef: "demo"}, nil); err != nil {
		t.Fatal("one active user blocked another user's run")
	}
	if err := a.Cancel(ctx, run.SessionID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, s, run.SessionID, domain.Cancelled)
	s.mu.Lock()
	for i := 1; i < 10; i++ {
		id := newID()
		s.sessions[id] = &Snapshot{OwnerID: alice.ID, Session: domain.Session{Version: 1, ID: id}}
	}
	s.mu.Unlock()
	if _, err := a.StartWithFiles(ctx, domain.StartRequest{Prompt: "eleventh", ModelRef: "demo"}, nil); err == nil {
		t.Fatal("per-user persistent session limit missing")
	}
	if _, err := s.Start(ctx, domain.StartRequest{Prompt: "Owner", ModelRef: "demo"}); err != nil {
		t.Fatal("regular users exhausted administrator capacity")
	}
}
