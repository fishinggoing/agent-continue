package session

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPrivateStorageProtectsExistingAndNewFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "model-settings.json"), []byte(`{"model":"synthetic","apiKey":"synthetic-key"}`), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Save(context.Background(), "synthetic", map[string]string{"message": "synthetic conversation"}, nil); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", "workbench.lock", "sessions-v1.sqlite", "sessions-v1.sqlite-wal", "sessions-v1.sqlite-shm", "model-settings.json"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("private storage file missing: %s", name)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
			t.Fatalf("private storage is accessible by other OS users: %s (%o)", name, info.Mode().Perm())
		}
	}
}

func TestPrivateStorageRefusesSymlinkFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires Windows privileges; verified on Linux")
	}
	for _, name := range []string{"workbench.lock", "sessions-v1.sqlite", "sessions-v1.sqlite-wal", "sessions-v1.sqlite-shm", "model-settings.json"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			external := filepath.Join(t.TempDir(), "external")
			if err := os.WriteFile(external, []byte("unchanged"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(external, filepath.Join(dir, name)); err != nil {
				t.Fatal(err)
			}
			if s, err := Open(dir); err == nil {
				s.Close()
				t.Fatal("private storage symlink accepted")
			}
			content, _ := os.ReadFile(external)
			info, _ := os.Stat(external)
			if string(content) != "unchanged" || info.Mode().Perm() != 0644 {
				t.Fatal("external symlink target changed")
			}
		})
	}
}
