package session

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type WorkspaceLease struct{ file *os.File }

// OpenWorkspaceLease coordinates an identical local root across configurations.
func OpenWorkspaceLease(dir, workspace string) (*WorkspaceLease, error) {
	if runtime.GOOS == "windows" {
		workspace = strings.ToLower(workspace)
	}
	hash := sha256.Sum256([]byte(filepath.Clean(workspace)))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, errors.New("cannot create private workspace lease directory")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, errors.New("cannot protect workspace lease directory")
	}
	f, err := openPrivateFile(filepath.Join(dir, hex.EncodeToString(hash[:])+".lock"))
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, errors.New("local workspace is already in use by another run")
	}
	return &WorkspaceLease{file: f}, nil
}

func (lease *WorkspaceLease) Close() error { return lease.file.Close() }
