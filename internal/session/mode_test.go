package session

import (
	"strings"
	"testing"
)

func TestStorageModesCannotOpenEachOthersDatabase(t *testing.T) {
	for _, first := range []string{"web", "cli"} {
		t.Run(first, func(t *testing.T) {
			dir := t.TempDir()
			s, err := OpenMode(dir, first)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := OpenMode(dir, first); err == nil || !strings.Contains(err.Error(), "already in use") {
				t.Fatalf("storage mode checked without owning lock: %v", err)
			}
			s.Close()
			other := "cli"
			if first == "cli" {
				other = "web"
			}
			if s, err := OpenMode(dir, other); err == nil {
				s.Close()
				t.Fatal("opposite mode opened private histories")
			}
			s, err = OpenMode(dir, first)
			if err != nil {
				t.Fatal(err)
			}
			s.Close()
		})
	}
}

func TestUnmarkedExistingDatabaseBelongsToWeb(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("DELETE FROM metadata WHERE key='storage_mode'"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if s, err := OpenMode(dir, "cli"); err == nil {
		s.Close()
		t.Fatal("unmarked browser database accepted as CLI")
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
}
