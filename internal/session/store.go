// Package session owns the workbench database, separate from harness registries.
package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/fishinggoing/agent-continue/internal/domain"
	_ "modernc.org/sqlite"
)

type Store struct {
	db   *sql.DB
	lock *os.File
}

func Open(dir string) (*Store, error) {
	return OpenMode(dir, "web")
}

// OpenMode keeps local CLI histories outside the HTTP workbench boundary.
func OpenMode(dir, mode string) (*Store, error) {
	modeID := 1
	if mode == "cli" {
		modeID = 2
	} else if mode != "web" {
		return nil, errors.New("unsupported session storage mode")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, errors.New("cannot protect workbench data directory")
	}
	for _, name := range []string{"sessions-v1.sqlite", "sessions-v1.sqlite-wal", "sessions-v1.sqlite-shm", "model-settings.json"} {
		if err := protectFile(filepath.Join(dir, name)); err != nil {
			return nil, err
		}
	}
	lock, err := openPrivateFile(filepath.Join(dir, "workbench.lock"))
	if err != nil {
		return nil, err
	}
	if err = lockFile(lock); err != nil {
		lock.Close()
		return nil, errors.New("workbench data directory is already in use")
	}
	_, existingErr := os.Lstat(filepath.Join(dir, "sessions-v1.sqlite"))
	newDatabase := errors.Is(existingErr, os.ErrNotExist)
	if existingErr != nil && !newDatabase {
		lock.Close()
		return nil, errors.New("cannot inspect private workbench storage")
	}
	database, err := openPrivateFile(filepath.Join(dir, "sessions-v1.sqlite"))
	if err != nil {
		lock.Close()
		return nil, err
	}
	if err := database.Close(); err != nil {
		lock.Close()
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "sessions-v1.sqlite"))
	if err != nil {
		lock.Close()
		return nil, err
	}
	s := &Store{db: db, lock: lock}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
		CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
		INSERT OR IGNORE INTO metadata VALUES ('version', 1);
		CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body BLOB NOT NULL);
		CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE);
		CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(session_id, seq));`); err != nil {
		s.Close()
		return nil, err
	}
	var version int
	if err = db.QueryRow("SELECT value FROM metadata WHERE key='version'").Scan(&version); err != nil || version != 1 {
		s.Close()
		return nil, errors.New("unsupported workbench database version")
	}
	var storedMode int
	err = db.QueryRow("SELECT value FROM metadata WHERE key='storage_mode'").Scan(&storedMode)
	if errors.Is(err, sql.ErrNoRows) {
		storedMode = 1 // Existing unmarked databases belong to the web workbench.
		if newDatabase {
			storedMode = modeID
		}
		_, err = db.Exec("INSERT INTO metadata(key,value) VALUES('storage_mode',?)", storedMode)
	}
	if err != nil || storedMode != modeID {
		s.Close()
		return nil, errors.New("session database belongs to a different application mode")
	}
	return s, nil
}

func protectFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("private workbench storage must use regular files, never symlinks")
	}
	if err := os.Chmod(path, 0600); err != nil {
		return errors.New("cannot protect private workbench storage")
	}
	return nil
}

func openPrivateFile(path string) (*os.File, error) {
	if err := protectFile(path); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, errors.New("cannot open private workbench storage")
	}
	return f, nil
}

func (s *Store) Close() error { err := s.db.Close(); s.lock.Close(); return err }

func (s *Store) Load(ctx context.Context) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT body FROM sessions ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result [][]byte
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		result = append(result, b)
	}
	return result, rows.Err()
}

// Snapshot and event are committed together, before a tool can change disk.
func (s *Store) Save(ctx context.Context, id string, snapshot any, event *domain.Event) error {
	body, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", id, body); err != nil {
		return err
	}
	if event != nil {
		var seq uint64
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE session_id=?", id).Scan(&seq); err != nil {
			return err
		}
		event.Sequence = seq
		b, marshalErr := json.Marshal(event)
		if marshalErr != nil {
			return marshalErr
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO events VALUES(?,?,?)", id, seq, b); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) Events(ctx context.Context, id string, after uint64) ([]domain.Event, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT body FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 512", id, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []domain.Event{}
	for rows.Next() {
		var b []byte
		var e domain.Event
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &e); err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, rows.Err()
}
