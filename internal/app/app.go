// Package app shares the migration workflow between local CLI and HTTP.
package app

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/fishinggoing/agent-continue/internal/migrate"
	_ "modernc.org/sqlite"
)

type Object = map[string]any

const Usage = `agent-continue inspect --from codex|dsh --input FILE
agent-continue migrate --from codex|dsh --input FILE --cwd ABSOLUTE_DIR --target-home ABSOLUTE_DIR [--dry-run] [--id UUID]
DSH -> Codex additionally requires --cli-version VERSION --model-provider PROVIDER.
Optional Codex registration fields: --model MODEL --title TITLE.
agent-continue install --from codex|dsh --input FILE --cwd ABSOLUTE_DIR --target-home ABSOLUTE_DIR [--dry-run] [--model MODEL] [--title TITLE]
agent-continue serve [--listen 127.0.0.1:8080]
Set AGENT_CONTINUE_TOKEN for HTTP access. Non-loopback listeners require a token.
No model requests, tool execution, implicit user home, or overwrite are performed.`

var IDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

type Options struct{ Cwd, ID, CLIVersion, ModelProvider, Model, Title string }
type Prepared struct {
	Report                                                                   Object
	Content                                                                  []byte
	Filename, ID, Target, Cwd, Title, Provider, Model, CLIVersion, FirstUser string
	Created                                                                  time.Time
}

func object(v any) Object {
	if o, ok := v.(map[string]any); ok {
		return o
	}
	return Object{}
}
func text(v any) string { s, _ := v.(string); return s }
func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	}
	return 0
}
func jsonString(v any) string { b, _ := json.Marshal(v); return string(b) }
func ReadSource(kind, path string) (*migrate.Source, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	stat, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if !stat.Mode().IsRegular() {
		return nil, fmt.Errorf("Input must be a file")
	}
	if stat.Size() > migrate.MaxInputBytes {
		return nil, fmt.Errorf("Input exceeds the 128 MiB source limit")
	}
	data, e := io.ReadAll(io.LimitReader(f, migrate.MaxInputBytes+1))
	if e != nil {
		return nil, e
	}
	return migrate.ParseSource(kind, path, data)
}
func Inspect(s *migrate.Source, path string) (Object, error) {
	pending, e := s.Pending()
	if e != nil {
		return nil, e
	}
	return Object{"command": "inspect", "source": Object{"harness": s.Kind, "path": path, "records": s.Count(), "cwd": s.Cwd()}, "pendingOperations": pending, "toolsExecuted": 0}, nil
}
func Prepare(s *migrate.Source, o Options) (*Prepared, error) {
	if !migrate.IsAbsolute(o.Cwd) {
		return nil, fmt.Errorf("Working directory must be an absolute path")
	}
	if o.ID == "" {
		o.ID = migrate.NewID()
	}
	if !IDPattern.MatchString(o.ID) {
		return nil, fmt.Errorf("--id must be a UUID")
	}
	pending, e := s.Pending()
	if e != nil {
		return nil, e
	}
	p := &Prepared{ID: o.ID, Cwd: o.Cwd, Model: o.Model, Title: o.Title, Provider: o.ModelProvider, CLIVersion: o.CLIVersion}
	var c migrate.Conversion
	if s.Kind == "codex" {
		if o.CLIVersion != "" || o.ModelProvider != "" || o.Model != "" || o.Title != "" {
			return nil, fmt.Errorf("Codex registration options are only used when the target is Codex")
		}
		p.Target = "dsh"
		c, e = migrate.CodexToDsh(s.Records, Object{"sessionId": o.ID, "cwd": o.Cwd})
		if e != nil {
			return nil, e
		}
		p.Created = time.UnixMilli(int64(number(c.Header["createdAt"])))
		p.Content, e = migrate.EncodeDSH(c.Header, c.Events)
		p.Filename = "session.v4.jsonl.zstd"
	} else {
		if e = migrate.AssertDshMigrationSource(s.Header); e != nil {
			return nil, e
		}
		if o.CLIVersion == "" {
			return nil, fmt.Errorf("Required option --cli-version is missing")
		}
		if o.ModelProvider == "" {
			return nil, fmt.Errorf("Required option --model-provider is missing")
		}
		p.Target = "codex"
		h := Object{}
		for k, v := range s.Header {
			h[k] = v
		}
		h["cwd"] = o.Cwd
		c, e = migrate.DshToCodex(h, s.Events, Object{"cliVersion": o.CLIVersion, "modelProvider": o.ModelProvider, "threadId": o.ID})
		if e != nil {
			return nil, e
		}
		p.Created = time.UnixMilli(int64(number(h["createdAt"])))
		if p.Created.Year() < 1 || p.Created.Year() > 9999 {
			return nil, fmt.Errorf("Source creation time is outside the supported date range")
		}
		p.Content, e = migrate.EncodeCodex(c.Drafts, p.Created.UTC().Format("2006-01-02T15:04:05.000Z"))
		p.Filename = RolloutFilename(p.Created, o.ID)
		for _, d := range c.Drafts {
			m := object(d["payload"])
			if d["type"] == "response_item" && m["type"] == "message" && m["role"] == "user" {
				if a, ok := m["content"].([]any); ok {
					for _, v := range a {
						p.FirstUser += text(object(v)["text"])
					}
				} else if a, ok := m["content"].([]Object); ok {
					for _, v := range a {
						p.FirstUser += text(v["text"])
					}
				}
				break
			}
		}
		if p.Title == "" {
			p.Title = "Imported DSH conversation"
		}
	}
	if e != nil {
		return nil, e
	}
	count := len(c.Events)
	if p.Target == "codex" {
		count = len(c.Drafts)
	}
	p.Report = Object{"command": "migrate", "status": "planned", "source": Object{"harness": s.Kind, "records": s.Count(), "cwd": s.Cwd()}, "target": Object{"harness": p.Target, "cwd": o.Cwd, "sessionId": o.ID}, "pendingOperations": pending, "toolsExecuted": 0, "modelRequests": 0, "nativeValidation": "not-run", "cwdRemapped": s.Cwd() != o.Cwd, "output": Object{"records": count}, "tallies": c.Tallies, "losses": c.Losses}
	if p.Target == "codex" {
		target := object(p.Report["target"])
		target["model"] = p.Model
		target["title"] = p.Title
		target["modelProvider"] = p.Provider
		target["cliVersion"] = p.CLIVersion
	}
	return p, nil
}
func Hash(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }
func RolloutFilename(t time.Time, id string) string {
	return "rollout-" + t.Local().Format("2006-01-02T15-04-05") + "-" + id + ".jsonl"
}
func EncodeSegment(s string) string {
	if s == "." {
		return "~002E"
	}
	if s == ".." {
		return "~002E~002E"
	}
	var b strings.Builder
	for _, c := range utf16.Encode([]rune(s)) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' {
			b.WriteByte(byte(c))
		} else {
			fmt.Fprintf(&b, "~%04X", c)
		}
	}
	return b.String()
}
func ProjectKey(s string) string {
	var b strings.Builder
	sep := false
	for _, c := range utf16.Encode([]rune(s)) {
		if c == '/' || c == '\\' || c == ':' {
			if !sep {
				b.WriteByte('-')
			}
			sep = true
		} else {
			sep = false
			if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' {
				b.WriteByte(byte(c))
			} else {
				fmt.Fprintf(&b, "~%04X", c)
			}
		}
	}
	slug := strings.TrimLeft(b.String(), "-")
	if slug == "" {
		slug = "root"
	}
	if len(slug) > 251 {
		slug = slug[:251]
	}
	return "--" + slug + "--"
}
func (p *Prepared) Path(home string) string {
	if p.Target == "dsh" {
		return filepath.Join(home, "sessions", ProjectKey(p.Cwd), EncodeSegment(p.ID), p.Filename)
	}
	t := p.Created.Local()
	return filepath.Join(home, "sessions", t.Format("2006"), t.Format("01"), t.Format("02"), p.Filename)
}
func validateDirectory(path string, mustExist bool) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("Working directory and target home must be absolute local paths")
	}
	path = filepath.Clean(path)
	info, e := os.Stat(path)
	if e != nil {
		if !mustExist && errors.Is(e, os.ErrNotExist) {
			return path, nil
		}
		return "", e
	}
	if !info.IsDir() {
		return "", fmt.Errorf("Working directory and target home must be directories")
	}
	return path, nil
}
func exclusiveWrite(path string, data []byte) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".agent-continue-*")
	if e != nil {
		return e
	}
	temp := f.Name()
	defer os.Remove(temp)
	if _, e = f.Write(data); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	// A hard-link publication is atomic and refuses an existing destination on both Windows and Linux.
	if e = os.Link(temp, path); e != nil {
		return fmt.Errorf("Refusing to overwrite or publish target: %w", e)
	}
	return nil
}

var registryColumns = strings.Fields("id rollout_path created_at updated_at source model_provider cwd title sandbox_policy approval_mode tokens_used has_user_event archived cli_version first_user_message memory_mode model reasoning_effort created_at_ms updated_at_ms thread_source preview recency_at recency_at_ms history_mode is_pinned originator")

func openRegistry(path string, readOnly bool) (*sql.DB, error) {
	if info, e := os.Stat(path); e != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("Target Codex home must already contain an initialized state_5.sqlite; no registry is guessed or copied")
	}
	pathname := filepath.ToSlash(path)
	if !strings.HasPrefix(pathname, "/") {
		pathname = "/" + pathname
	}
	u := url.URL{Scheme: "file", Path: pathname}
	q := u.Query()
	if readOnly {
		q.Set("mode", "ro")
	} else {
		q.Set("mode", "rw")
	}
	q.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = q.Encode()
	db, e := sql.Open("sqlite", u.String())
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	if e = db.Ping(); e != nil {
		db.Close()
		return nil, e
	}
	return db, nil
}
func preflight(db *sql.DB, id string) error {
	rows, e := db.Query("PRAGMA table_info(threads)")
	if e != nil {
		return e
	}
	cols := map[string]bool{}
	for rows.Next() {
		var cid, notNull, pk int
		var name, kind string
		var def any
		if e = rows.Scan(&cid, &name, &kind, &notNull, &def, &pk); e != nil {
			rows.Close()
			return e
		}
		cols[name] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, c := range registryColumns {
		if !cols[c] {
			return fmt.Errorf("Target Codex threads schema is incompatible with this adapter")
		}
	}
	var found string
	e = db.QueryRow("SELECT id FROM threads WHERE id = ?", id).Scan(&found)
	if e == nil {
		return fmt.Errorf("Refusing to overwrite an existing registered thread")
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return e
	}
	return nil
}
func extended(p string) string {
	if runtime.GOOS != "windows" || strings.HasPrefix(p, `\\?\`) {
		return p
	}
	if strings.HasPrefix(p, `\\`) {
		return `\\?\UNC\` + strings.TrimPrefix(p, `\\`)
	}
	return `\\?\` + p
}
func register(db *sql.DB, p *Prepared, path string) error {
	var model any
	if p.Model != "" {
		model = p.Model
	}
	at := p.Created.Unix()
	_, e := db.Exec(`INSERT INTO threads (id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,tokens_used,has_user_event,archived,cli_version,first_user_message,memory_mode,model,reasoning_effort,created_at_ms,updated_at_ms,thread_source,preview,recency_at,recency_at_ms,history_mode,is_pinned,originator) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,?,?,'enabled',?,NULL,?,?,'user',?,?,?,'paginated',0,'agent_continue')`, p.ID, path, at, at, "exec", p.Provider, extended(p.Cwd), p.Title, `{"type":"read-only"}`, "on-request", p.CLIVersion, p.FirstUser, model, at*1000, at*1000, p.FirstUser, at, at*1000)
	return e
}
func Write(p *Prepared, home string, dry bool) (Object, error) {
	var e error
	p.Cwd, e = validateDirectory(p.Cwd, true)
	if e != nil {
		return nil, e
	}
	home, e = validateDirectory(home, false)
	if e != nil {
		return nil, e
	}
	path := p.Path(home)
	if _, e = os.Lstat(path); e == nil {
		return nil, fmt.Errorf("Refusing to overwrite an existing session artifact")
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	out := object(p.Report["output"])
	out["path"] = path
	p.Report["output"] = out
	object(p.Report["target"])["home"] = home
	if p.Target == "codex" {
		target := object(p.Report["target"])
		target["model"] = p.Model
		target["title"] = p.Title
		target["modelProvider"] = p.Provider
		target["cliVersion"] = p.CLIVersion
	}
	if dry {
		return p.Report, nil
	}
	var db *sql.DB
	if p.Target == "codex" {
		db, e = openRegistry(filepath.Join(home, "state_5.sqlite"), false)
		if e != nil {
			return nil, e
		}
		defer db.Close()
		if e = preflight(db, p.ID); e != nil {
			return nil, e
		}
	}
	if e = exclusiveWrite(path, p.Content); e != nil {
		return nil, e
	}
	if db != nil {
		if e = register(db, p, path); e != nil {
			return nil, fmt.Errorf("Rollout was written but thread registration failed; inspect %s before retrying: %w", path, e)
		}
	}
	out["bytes"] = len(p.Content)
	p.Report["status"] = "written"
	return p.Report, nil
}
func ParseArgs(args []string) (string, map[string]string, error) {
	command := "help"
	if len(args) > 0 {
		command = args[0]
	}
	f := map[string]string{}
	if command == "help" || command == "--help" || command == "-h" {
		return "help", f, nil
	}
	allowed := map[string]bool{}
	fields := ""
	switch command {
	case "inspect":
		fields = "from input"
	case "migrate":
		fields = "from input cwd target-home dry-run id cli-version model-provider model title"
	case "install":
		fields = "from input cwd target-home dry-run model title"
	case "serve":
		fields = "listen"
	default:
		return "", nil, fmt.Errorf("Unknown command: %s", command)
	}
	for _, v := range strings.Fields(fields) {
		allowed[v] = true
	}
	for i := 1; i < len(args); i++ {
		token := args[i]
		if !strings.HasPrefix(token, "--") {
			return "", nil, fmt.Errorf("Expected a named option")
		}
		name := strings.TrimPrefix(token, "--")
		if !allowed[name] {
			return "", nil, fmt.Errorf("Unknown option --%s", name)
		}
		if _, ok := f[name]; ok {
			return "", nil, fmt.Errorf("Duplicate option --%s", name)
		}
		if name == "dry-run" {
			f[name] = "true"
			continue
		}
		i++
		if i >= len(args) || strings.HasPrefix(args[i], "--") || args[i] == "" {
			return "", nil, fmt.Errorf("Missing value for --%s", name)
		}
		f[name] = args[i]
	}
	return command, f, nil
}
func Execute(args []string) (Object, error) {
	command, f, e := ParseArgs(args)
	if e != nil {
		return nil, e
	}
	if command == "help" {
		return Object{"command": "help", "usage": Usage}, nil
	}
	if command == "serve" {
		return nil, fmt.Errorf("serve must be run through the CLI entry")
	}
	required := []string{"from", "input"}
	if command != "inspect" {
		required = append(required, "cwd", "target-home")
	}
	for _, k := range required {
		if f[k] == "" {
			return nil, fmt.Errorf("Required option --%s is missing", k)
		}
	}
	input, e := filepath.Abs(f["input"])
	if e != nil {
		return nil, e
	}
	s, e := ReadSource(f["from"], input)
	if e != nil {
		return nil, e
	}
	if command == "inspect" {
		return Inspect(s, input)
	}
	cwd, e := validateDirectory(f["cwd"], true)
	if e != nil {
		return nil, e
	}
	var p *Prepared
	if command == "install" {
		p, e = PrepareInstall(s, cwd)
		if e == nil && p.Target == "codex" {
			if f["model"] != "" {
				p.Model = f["model"]
			}
			if f["title"] != "" {
				p.Title = f["title"]
			}
		}
		if e == nil && p.Target != "codex" && (f["model"] != "" || f["title"] != "") {
			return nil, fmt.Errorf("--model and --title are only used when the target is Codex")
		}
	} else {
		p, e = Prepare(s, Options{Cwd: cwd, ID: f["id"], CLIVersion: f["cli-version"], ModelProvider: f["model-provider"], Model: f["model"], Title: f["title"]})
	}
	if e != nil {
		return nil, e
	}
	object(p.Report["source"])["path"] = input
	return Write(p, f["target-home"], f["dry-run"] == "true")
}

// PrepareInstall registers an already-converted artifact downloaded from the server.
func PrepareInstall(s *migrate.Source, cwd string) (*Prepared, error) {
	if filepath.Clean(s.Cwd()) != filepath.Clean(cwd) {
		return nil, fmt.Errorf("Artifact cwd differs from target directory; regenerate it with the correct target cwd")
	}
	p := &Prepared{Cwd: cwd, Target: s.Kind, Title: "Imported conversation"}
	var e error
	if s.Kind == "dsh" {
		if e = migrate.AssertDshMigrationSource(s.Header); e != nil {
			return nil, e
		}
		if _, e = migrate.CurrentSurface(s.Events); e != nil {
			return nil, e
		}
		p.ID = text(s.Header["id"])
		p.Created = time.UnixMilli(int64(number(s.Header["createdAt"])))
		// Native DSH validates that header.cwd derives the artifact's storage path.
		// Use the same canonical directory for both after accepting equivalent paths.
		header := Object{}
		for k, v := range s.Header {
			header[k] = v
		}
		header["cwd"] = cwd
		p.Content, e = migrate.EncodeDSH(header, s.Events)
		p.Filename = fmt.Sprintf("session.v%d.jsonl.zstd", int(number(s.Header["version"])))
	} else {
		meta := object(s.Records[0]["payload"])
		p.ID = text(meta["id"])
		p.Provider = text(meta["model_provider"])
		p.CLIVersion = text(meta["cli_version"])
		p.Created, e = time.Parse(time.RFC3339Nano, text(meta["timestamp"]))
		if e != nil {
			return nil, fmt.Errorf("Invalid artifact creation time")
		}
		if p.Provider == "" || p.CLIVersion == "" {
			return nil, fmt.Errorf("Artifact requires model_provider and cli_version")
		}
		p.Filename = RolloutFilename(p.Created, p.ID)
		p.Content, e = migrate.EncodeCodex(s.Records, p.Created.UTC().Format(time.RFC3339Nano))
		for _, r := range s.Records {
			m := object(r["payload"])
			if r["type"] == "response_item" && m["role"] == "user" {
				if a, ok := m["content"].([]any); ok {
					for _, v := range a {
						p.FirstUser += text(object(v)["text"])
					}
				}
				break
			}
		}
	}
	if e != nil {
		return nil, e
	}
	if !IDPattern.MatchString(p.ID) {
		return nil, fmt.Errorf("Artifact id must be a UUID")
	}
	pending, e := s.Pending()
	if e != nil {
		return nil, e
	}
	p.Report = Object{"command": "install", "status": "planned", "source": Object{"harness": s.Kind, "records": s.Count(), "cwd": s.Cwd()}, "target": Object{"harness": s.Kind, "cwd": cwd, "sessionId": p.ID}, "output": Object{"records": s.Count()}, "pendingOperations": pending, "toolsExecuted": 0, "modelRequests": 0, "nativeValidation": "not-run", "losses": []string{}}
	return p, nil
}
