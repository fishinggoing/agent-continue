package task

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/session"
)

const maxLocalFiles = 2000
const maxLocalEntries = 20000

type localPolicy struct {
	dir       string
	protected []string
	secrets   []string
}

// OpenLocal never loads or writes browser model settings or browser histories.
func OpenLocal(c config.Config, env config.LookupEnv, configPath string) (*Service, error) {
	if err := config.Validate(c); err != nil {
		return nil, err
	}
	if env == nil {
		env = os.LookupEnv
	}
	key, err := config.Credential(c.Provider, env)
	rawKey, hasKey := env(c.Provider.CredentialEnv)
	if err != nil && hasKey && strings.TrimSpace(rawKey) != "" {
		return nil, err
	}
	if configPath == "" || !filepath.IsAbs(configPath) {
		return nil, errors.New("local runtime requires the absolute configuration path")
	}
	if err := noLinkComponents(configPath, true); err != nil {
		return nil, errors.New("local configuration path contains an unsupported link or alias")
	}
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return nil, errors.New("cannot locate local workspace lease directory")
	}
	leaseDir := filepath.Join(cacheDir, "agent-continue", "local-workspaces")
	if err := noLinkComponents(c.DataDir, true); err != nil {
		return nil, errors.New("local data directory contains an unsupported link")
	}
	dir := filepath.Join(filepath.Clean(c.DataDir), "cli-v1")
	if err := noLinkComponents(dir, true); err != nil {
		return nil, errors.New("local data directory contains an unsupported link")
	}
	store, err := session.OpenMode(dir, "cli")
	if err != nil {
		return nil, err
	}
	s := &Service{store: store, dir: dir, config: c, modelKey: key, local: true,
		protected:       []string{filepath.Clean(c.DataDir), filepath.Clean(configPath), leaseDir},
		protectedValues: []string{key},
		leaseDir:        leaseDir,
		sessions:        map[string]*Snapshot{}, active: map[string]*activeRun{}}
	if token, ok := env("AGENT_CONTINUE_TOKEN"); ok && token != "" {
		s.protectedValues = append(s.protectedValues, token)
	}
	if err := s.loadSessions(); err != nil {
		store.Close()
		return nil, err
	}
	return s, nil
}

func insidePath(dir, name string) bool {
	rel, err := filepath.Rel(dir, name)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// Lstat each component because os.Root also permits symlinks within its root.
func noLinkComponents(name string, allowMissing bool) error {
	name = filepath.Clean(name)
	volume := filepath.VolumeName(name)
	current := volume + string(filepath.Separator)
	rest := strings.TrimLeft(strings.TrimPrefix(name, volume), string(filepath.Separator))
	parts := strings.Split(rest, string(filepath.Separator))
	for _, part := range parts {
		if part != "" && !portableComponent(part) {
			return errors.New("unsupported path component")
		}
	}
	for _, part := range parts {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if allowMissing && errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsupported or unavailable path")
		}
	}
	return nil
}

func (s *Service) localWorkspace(name string) (string, error) {
	if containsProtectedText(name, s.protectedValues) {
		return "", errors.New("workspace path contains a protected credential")
	}
	if !filepath.IsAbs(name) {
		return "", errors.New("local workspace must be an absolute path")
	}
	name = filepath.Clean(name)
	if err := noLinkComponents(name, false); err != nil {
		return "", errors.New("local workspace is unavailable or contains a link")
	}
	info, err := os.Stat(name)
	if err != nil || !info.IsDir() {
		return "", errors.New("local workspace must be an existing directory")
	}
	allowed := false
	for _, root := range s.config.WorkspaceRoots {
		if insidePath(filepath.Clean(root), name) && noLinkComponents(root, false) == nil {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", errors.New("local workspace is outside configured workspace roots")
	}
	for _, protected := range s.protected {
		if insidePath(protected, name) {
			return "", errors.New("private runtime storage cannot be a workspace")
		}
	}
	return name, nil
}

func (s *Service) startLocal(ctx context.Context, req domain.StartRequest) (domain.Run, error) {
	if err := ctx.Err(); err != nil {
		return domain.Run{}, err
	}
	if strings.TrimSpace(req.Prompt) == "" || len(req.Prompt) > 8192 {
		return domain.Run{}, errors.New("prompt must contain 1 to 8192 bytes")
	}
	if containsProtectedText(req.Prompt, s.protectedValues) {
		return domain.Run{}, errors.New("prompt contains a protected model credential")
	}
	workspace, err := s.localWorkspace(req.Workspace)
	if err != nil {
		return domain.Run{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return domain.Run{}, errors.New("service is closing")
	}
	if !s.modelReadyLocked() {
		return domain.Run{}, errors.New("model credential environment variable is not set")
	}
	if req.ModelRef != "" && req.ModelRef != s.config.Provider.ID {
		return domain.Run{}, errors.New("model mode does not match the local configuration")
	}
	if len(s.sessions) >= 100 {
		return domain.Run{}, errors.New("local session limit reached (100)")
	}
	if err := s.localRunCapacityLocked(workspace); err != nil {
		return domain.Run{}, err
	}
	now := time.Now().UTC()
	title := []rune(req.Prompt)
	if len(title) > 48 {
		title = title[:48]
	}
	snap := &Snapshot{OwnerID: session.DefaultOwnerID, Session: domain.Session{Version: domain.SchemaVersion,
		ID: newID(), Workspace: workspace, CreatedAt: now, UpdatedAt: now, ModelRef: s.config.Provider.ID, Status: domain.Queued},
		Title: string(title), Messages: []domain.Message{}, Runs: []domain.Run{}, Tools: []ToolEntry{}}
	s.sessions[snap.Session.ID] = snap
	run, err := s.launchLocked(snap, req.Prompt)
	if err != nil {
		delete(s.sessions, snap.Session.ID)
	}
	return run, err
}

func (s *Service) localRunCapacityLocked(workspace string) error {
	for id := range s.active {
		other := s.sessions[id].Session.Workspace
		if insidePath(workspace, other) || insidePath(other, workspace) {
			return errors.New("an overlapping local workspace already has an active run")
		}
	}
	return nil
}

func (s *Service) localFiles(workspace string) (*Files, error) {
	workspace, err := s.localWorkspace(workspace)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, errors.New("cannot open local workspace")
	}
	return &Files{root: root, generic: true, local: &localPolicy{dir: workspace, protected: s.protected, secrets: s.protectedValues}}, nil
}

func localPathAllowed(name string) bool {
	if !validPath(name) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if !portableComponent(part) {
			return false
		}
		lower := strings.ToLower(part)
		switch lower {
		case "node_modules", "vendor", "venv", "__pycache__", "target", "dist", "build", "coverage", "research-deepseek", "reference-orchestrator", "pdf_text.txt", "model-settings.json", "workbench.lock":
			return false
		}
		if strings.Contains(lower, "secret") || strings.Contains(lower, "credential") || strings.Contains(lower, "api_key") || strings.Contains(lower, "apikey") || strings.Contains(lower, "password") || lower == "token" || strings.HasPrefix(lower, "token.") {
			return false
		}
		for _, suffix := range []string{".db", ".sqlite", ".sqlite3", ".sqlite-wal", ".sqlite-shm", ".p12", ".pfx", ".jks", ".keystore", ".key", ".pem", ".env", ".env.local"} {
			if strings.HasSuffix(lower, suffix) {
				return false
			}
		}
		if lower == "id_rsa" || lower == "id_ed25519" || lower == "id_dsa" || lower == "id_ecdsa" {
			return false
		}
	}
	return true
}

// Windows normalizes these names or treats them as devices rather than files.
func portableComponent(part string) bool {
	if strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || strings.ContainsAny(part, "<>\"|?*~") {
		return false
	}
	for _, char := range part {
		if char < 32 || char == 127 {
			return false
		}
	}
	stem := strings.TrimRight(strings.SplitN(strings.ToUpper(part), ".", 2)[0], " ")
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return false
	}
	if strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT") {
		suffix := strings.TrimPrefix(strings.TrimPrefix(stem, "COM"), "LPT")
		if len(suffix) == 1 && suffix[0] >= '1' && suffix[0] <= '9' || suffix == "\u00b9" || suffix == "\u00b2" || suffix == "\u00b3" {
			return false
		}
	}
	return true
}

func (f *Files) localCheck(name string, allowMissing bool) error {
	if !localPathAllowed(name) || containsProtectedText(name, f.local.secrets) {
		return errors.New("file path is protected or outside local tool scope")
	}
	full := filepath.Join(f.local.dir, filepath.FromSlash(name))
	for _, protected := range f.local.protected {
		if insidePath(protected, full) {
			return errors.New("file path is protected or outside local tool scope")
		}
	}
	if err := noLinkComponents(full, allowMissing); err != nil {
		return errors.New("local file links are not permitted")
	}
	return nil
}

func containsProtectedText(text string, secrets []string) bool {
	for _, secret := range secrets {
		if secret != "" && strings.Contains(text, secret) {
			return true
		}
	}
	return false
}

func containsProtectedJSON(data []byte, secrets []string) bool {
	if containsProtectedText(string(data), secrets) {
		return true
	}
	var value any
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	var inspect func(any) bool
	inspect = func(value any) bool {
		switch v := value.(type) {
		case string:
			return containsProtectedText(v, secrets)
		case []any:
			for _, item := range v {
				if inspect(item) {
					return true
				}
			}
		case map[string]any:
			for key, item := range v {
				if containsProtectedText(key, secrets) || inspect(item) {
					return true
				}
			}
		}
		return false
	}
	return inspect(value)
}

func redactProtectedText(text string, secrets []string) string {
	for _, secret := range secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[REDACTED]")
		}
	}
	return text
}

type localStream struct {
	secrets []string
	pending string
	emit    func(string) error
}

func (stream *localStream) push(text string, final bool) error {
	stream.pending = redactProtectedText(stream.pending+text, stream.secrets)
	keep := 0
	if !final {
		for _, secret := range stream.secrets {
			for n := min(len(secret)-1, len(stream.pending)); n > keep; n-- {
				if strings.HasSuffix(stream.pending, secret[:n]) {
					keep = n
					break
				}
			}
		}
	}
	text = stream.pending[:len(stream.pending)-keep]
	stream.pending = stream.pending[len(stream.pending)-keep:]
	if text != "" {
		return stream.emit(text)
	}
	return nil
}

func (f *Files) listLocal() ([]string, error) {
	names, entries := []string{}, 0
	err := fs.WalkDir(f.root.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return errors.New("cannot list local workspace")
		}
		if name == "." {
			return nil
		}
		entries++
		if entries > maxLocalEntries {
			return errors.New("local workspace scan limit exceeded (20000 entries)")
		}
		if f.localCheck(name, false) != nil {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() || !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || info.Size() > maxFileBytes {
			return nil
		}
		h, err := f.root.Open(name)
		if err != nil {
			return nil
		}
		linked := hasMultipleLinks(h)
		h.Close()
		if linked {
			return nil
		}
		names = append(names, name)
		if len(names) > maxLocalFiles {
			return errors.New("local workspace list limit exceeded (2000 files)")
		}
		return nil
	})
	return names, err
}
