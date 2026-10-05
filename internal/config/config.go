// Package config loads a validated snapshot; it never stores credential values.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/fishinggoing/agent-continue/internal/domain"
)

const (
	ProtocolDeepSeek = "deepseek-chat-completions-v1"
	MaxConfigBytes   = 1 << 20
)

type Provider struct {
	ID               string `json:"id"`
	Protocol         string `json:"protocol"`
	Endpoint         string `json:"endpoint"`
	Model            string `json:"model"`
	CredentialEnv    string `json:"credentialEnv"`
	TimeoutSeconds   int    `json:"timeoutSeconds"`
	MaxRetries       int    `json:"maxRetries"`
	RetryDelayMillis int    `json:"retryDelayMillis"`
	MaxEventBytes    int    `json:"maxEventBytes"`
	MaxResponseBytes int    `json:"maxResponseBytes"`
	MaxOutputTokens  int    `json:"maxOutputTokens"`
}

type ToolPolicy struct {
	Mode               string   `json:"mode"`
	AllowedTools       []string `json:"allowedTools"`
	CommandEnvironment []string `json:"commandEnvironment"`
	Isolation          string   `json:"isolation"`
}

type Config struct {
	Version        int              `json:"version"`
	Provider       Provider         `json:"provider"`
	Limits         domain.RunLimits `json:"limits"`
	DataDir        string           `json:"dataDir"`
	WorkspaceRoots []string         `json:"workspaceRoots"`
	Tools          ToolPolicy       `json:"tools"`
}

type Overrides struct{ Path, Endpoint, Model, DataDir string }
type LookupEnv func(string) (string, bool)

func DefaultPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", errors.New("cannot locate user configuration directory; use --config")
	}
	return filepath.Join(base, "agent-continue", "config.json"), nil
}

func Path(explicit string, env LookupEnv) (string, error) {
	if explicit == "" {
		explicit, _ = env("AGENT_CONTINUE_CONFIG")
	}
	if explicit == "" {
		return DefaultPath()
	}
	return filepath.Abs(explicit)
}

func Defaults(configPath, workspace string) Config {
	return Config{
		Version:        domain.SchemaVersion,
		Provider:       Provider{ID: "deepseek", Protocol: ProtocolDeepSeek, Endpoint: "https://api.deepseek.com/chat/completions", Model: "deepseek-flash", CredentialEnv: "DEEPSEEK_API_KEY", TimeoutSeconds: 120, MaxRetries: 2, RetryDelayMillis: 250, MaxEventBytes: 1 << 20, MaxResponseBytes: 16 << 20, MaxOutputTokens: 8192},
		Limits:         domain.RunLimits{MaxSteps: 20, MaxDurationSeconds: 600, MaxOutputBytes: 64 << 10, MaxContextBytes: 1 << 20},
		DataDir:        filepath.Join(filepath.Dir(configPath), "data"),
		WorkspaceRoots: []string{workspace},
		Tools:          ToolPolicy{Mode: "readonly", AllowedTools: []string{}, CommandEnvironment: []string{"PATH", "SystemRoot", "WINDIR", "TMP", "TEMP", "LANG"}, Isolation: "none"},
	}
}

// Init uses exclusive creation, so existing user configuration is never replaced.
func Init(path, workspace string) (Config, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return Config{}, err
	}
	workspace, err = filepath.Abs(workspace)
	if err != nil {
		return Config{}, err
	}
	c := Defaults(path, workspace)
	if err = Validate(c); err != nil {
		return Config{}, err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return Config{}, err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return Config{}, errors.New("cannot create configuration directory")
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return Config{}, errors.New("configuration already exists; refusing to overwrite")
	}
	if err != nil {
		return Config{}, errors.New("cannot create configuration file")
	}
	_, err = f.Write(append(b, '\n'))
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
		return Config{}, errors.New("cannot persist configuration file")
	}
	return c, nil
}

// Load precedence: explicit flags > AGENT_CONTINUE_* > file > built-in defaults.
// A schema version must be explicit in the file, even when defaults are used.
func Load(o Overrides, env LookupEnv) (Config, error) {
	path, err := Path(o.Path, env)
	if err != nil {
		return Config{}, err
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, errors.New("configuration does not exist; run config init")
	}
	if err != nil {
		return Config{}, errors.New("cannot read configuration file")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Config{}, errors.New("configuration must be a regular file")
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxConfigBytes+1))
	if err != nil {
		return Config{}, errors.New("cannot read configuration file")
	}
	if len(b) > MaxConfigBytes {
		return Config{}, errors.New("configuration exceeds 1 MiB limit")
	}
	if err = uniqueKeys(b); err != nil {
		return Config{}, err
	}
	c := Defaults(path, "")
	c.Version = 0
	c.WorkspaceRoots = nil
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&c); err != nil {
		// Decoder errors can contain user-provided text, including inline secrets.
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			return Config{}, fmt.Errorf("config JSON: invalid syntax at byte %d", syntax.Offset)
		}
		var mismatch *json.UnmarshalTypeError
		if errors.As(err, &mismatch) {
			return Config{}, fmt.Errorf("config.%s: invalid value type at byte %d", mismatch.Field, mismatch.Offset)
		}
		return Config{}, fmt.Errorf("config JSON: unrecognized field near byte %d", decoder.InputOffset())
	}
	if decoder.Decode(new(any)) != io.EOF {
		return Config{}, errors.New("configuration must contain exactly one JSON object")
	}
	for _, entry := range []struct {
		flag, variable string
		field          *string
	}{
		{o.Endpoint, "AGENT_CONTINUE_ENDPOINT", &c.Provider.Endpoint},
		{o.Model, "AGENT_CONTINUE_MODEL", &c.Provider.Model},
		{o.DataDir, "AGENT_CONTINUE_DATA_DIR", &c.DataDir},
	} {
		if value, exists := env(entry.variable); exists {
			*entry.field = value
		}
		if entry.flag != "" {
			*entry.field = entry.flag
		}
	}
	if err = Validate(c); err != nil {
		return Config{}, err
	}
	return c, nil
}

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

func Validate(c Config) error {
	bad := func(field, requirement string) error { return fmt.Errorf("config.%s: %s", field, requirement) }
	if c.Version != domain.SchemaVersion {
		return bad("version", "unsupported or missing schema version; expected 1")
	}
	if c.Provider.ID != "deepseek" {
		return bad("provider.id", "only deepseek is implemented")
	}
	if c.Provider.Protocol != ProtocolDeepSeek {
		return bad("provider.protocol", "unsupported protocol")
	}
	u, err := url.Parse(c.Provider.Endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || u.Path != "/chat/completions" && u.Path != "/v1/chat/completions" {
		return bad("provider.endpoint", "use a full /chat/completions URL without credentials, query or fragment")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || ip != nil && ip.IsLoopback())) {
		return bad("provider.endpoint", "HTTPS is required; HTTP is allowed only for loopback protocol tests")
	}
	if c.Provider.Model != "deepseek-flash" && c.Provider.Model != "deepseek-v4-pro" {
		return bad("provider.model", "unsupported model; expected deepseek-flash or deepseek-v4-pro")
	}
	if !envName.MatchString(c.Provider.CredentialEnv) || strings.EqualFold(c.Provider.CredentialEnv, "AGENT_CONTINUE_TOKEN") {
		return bad("provider.credentialEnv", "use a separate model credential environment variable")
	}
	if c.Provider.TimeoutSeconds < 1 || c.Provider.TimeoutSeconds > 3600 {
		return bad("provider.timeoutSeconds", "expected 1..3600")
	}
	if c.Provider.MaxRetries < 0 || c.Provider.MaxRetries > 5 {
		return bad("provider.maxRetries", "expected 0..5")
	}
	if c.Provider.RetryDelayMillis < 1 || c.Provider.RetryDelayMillis > 60000 {
		return bad("provider.retryDelayMillis", "expected 1..60000")
	}
	if c.Provider.MaxEventBytes < 128 || c.Provider.MaxEventBytes > 4<<20 {
		return bad("provider.maxEventBytes", "expected 128..4194304")
	}
	if c.Provider.MaxResponseBytes < c.Provider.MaxEventBytes || c.Provider.MaxResponseBytes > 64<<20 {
		return bad("provider.maxResponseBytes", "expected event limit..67108864")
	}
	if c.Provider.MaxOutputTokens < 1 || c.Provider.MaxOutputTokens > 393216 {
		return bad("provider.maxOutputTokens", "expected 1..393216")
	}
	if !filepath.IsAbs(c.DataDir) {
		return bad("dataDir", "expected an absolute local path")
	}
	if len(c.WorkspaceRoots) == 0 {
		return bad("workspaceRoots", "configure at least one explicit workspace")
	}
	for _, root := range c.WorkspaceRoots {
		if !filepath.IsAbs(root) {
			return bad("workspaceRoots", "all roots must be absolute local paths")
		}
	}
	if c.Limits.MaxSteps < 1 || c.Limits.MaxSteps > 1000 {
		return bad("limits.maxSteps", "expected 1..1000")
	}
	if c.Limits.MaxDurationSeconds < 1 || c.Limits.MaxDurationSeconds > 86400 {
		return bad("limits.maxDurationSeconds", "expected 1..86400")
	}
	if c.Limits.MaxOutputBytes < 128 || c.Limits.MaxOutputBytes > 16<<20 {
		return bad("limits.maxOutputBytes", "expected 128..16777216")
	}
	if c.Limits.MaxContextBytes < 128 || c.Limits.MaxContextBytes > 16<<20 {
		return bad("limits.maxContextBytes", "expected 128..16777216")
	}
	if c.Tools.Mode != "readonly" && c.Tools.Mode != "ask" && c.Tools.Mode != "allow" {
		return bad("tools.mode", "expected readonly, ask or allow")
	}
	// OS execution containment will be introduced in C07, before enabling it.
	if c.Tools.Isolation != "none" {
		return bad("tools.isolation", "no OS isolation mode is implemented yet")
	}
	for _, variable := range c.Tools.CommandEnvironment {
		if !envName.MatchString(variable) || strings.EqualFold(variable, c.Provider.CredentialEnv) || strings.EqualFold(variable, "AGENT_CONTINUE_TOKEN") || sensitiveEnv(variable) {
			return bad("tools.commandEnvironment", "credential variables cannot be inherited by commands")
		}
	}
	for _, tool := range c.Tools.AllowedTools {
		switch tool {
		case "list_files", "read_file", "search", "apply_patch", "diff", "exec":
		default:
			return bad("tools.allowedTools", "unknown tool name")
		}
	}
	return nil
}

func sensitiveEnv(name string) bool {
	n := strings.ToUpper(name)
	return strings.Contains(n, "TOKEN") || strings.Contains(n, "SECRET") || strings.Contains(n, "PASSWORD") || strings.Contains(n, "API_KEY") || strings.Contains(n, "APIKEY")
}

func Credential(p Provider, env LookupEnv) (string, error) {
	value, exists := env(p.CredentialEnv)
	if !exists || strings.TrimSpace(value) == "" {
		return "", errors.New("model credential environment variable is not set")
	}
	if len(value) > 4096 || strings.ContainsAny(value, " \t\r\n") {
		return "", errors.New("model credential contains invalid whitespace")
	}
	for _, character := range value {
		if character < 33 || character > 126 {
			return "", errors.New("model credential contains invalid header characters")
		}
	}
	return value, nil
}

// CommandEnv copies only explicitly allowed entries and excludes all secrets.
func CommandEnv(c Config, env LookupEnv) []string {
	result := []string{}
	for _, name := range c.Tools.CommandEnvironment {
		if sensitiveEnv(name) || strings.EqualFold(name, c.Provider.CredentialEnv) || strings.EqualFold(name, "AGENT_CONTINUE_TOKEN") {
			continue
		}
		if value, exists := env(name); exists {
			result = append(result, name+"="+value)
		}
	}
	return result
}

// Check inspects local readiness only; it does not contact the model or write.
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

func Checks(c Config, env LookupEnv) []Check {
	_, err := Credential(c.Provider, env)
	checks := []Check{{Name: "modelCredential", OK: err == nil, Detail: "environment reference only"}}
	for _, root := range c.WorkspaceRoots {
		f, err := os.Open(root)
		ok := false
		if err == nil {
			info, e := f.Stat()
			if e == nil && info.IsDir() {
				_, e = f.Readdirnames(1)
				ok = e == nil || errors.Is(e, io.EOF)
			}
			_ = f.Close()
		}
		checks = append(checks, Check{Name: "workspace", OK: ok, Detail: root})
	}
	return checks
}

func uniqueKeys(b []byte) error {
	d := json.NewDecoder(bytes.NewReader(b))
	invalid := func(err error) error {
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			return fmt.Errorf("config JSON: invalid syntax at byte %d", syntax.Offset)
		}
		return fmt.Errorf("config JSON: invalid syntax near byte %d", d.InputOffset())
	}
	var value func(int) error
	value = func(depth int) error {
		if depth > 16 {
			return errors.New("configuration JSON exceeds nesting limit")
		}
		token, err := d.Token()
		if err != nil {
			return invalid(err)
		}
		if token == nil {
			return errors.New("configuration does not support null values")
		}
		delim, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		seen := map[string]bool{}
		for d.More() {
			if delim == '{' {
				key, err := d.Token()
				if err != nil {
					return invalid(err)
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return fmt.Errorf("config JSON: duplicate field near byte %d", d.InputOffset())
				}
				seen[name] = true
			}
			if err := value(depth + 1); err != nil {
				return err
			}
		}
		if _, err := d.Token(); err != nil {
			return invalid(err)
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("configuration must contain exactly one JSON object")
	}
	if len(bytes.TrimSpace(b)) == 0 || bytes.TrimSpace(b)[0] != '{' {
		return errors.New("configuration must be a JSON object")
	}
	return nil
}
