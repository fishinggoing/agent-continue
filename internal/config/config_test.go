package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) (Config, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	c, err := Init(path, dir)
	if err != nil {
		t.Fatal(err)
	}
	return c, path
}

func environment(values map[string]string) LookupEnv {
	return func(key string) (string, bool) { value, ok := values[key]; return value, ok }
}

func TestConfigPrecedenceAndSnapshot(t *testing.T) {
	c, path := fixture(t)
	env := environment(map[string]string{"AGENT_CONTINUE_CONFIG": path, "AGENT_CONTINUE_MODEL": "deepseek-v4-pro", "AGENT_CONTINUE_ENDPOINT": "https://example.test/v1/chat/completions"})
	loaded, err := Load(Overrides{}, env)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Provider.Model != "deepseek-v4-pro" || loaded.Provider.Endpoint != "https://example.test/v1/chat/completions" {
		t.Fatal("environment overrides were not applied")
	}
	loaded, err = Load(Overrides{Path: path, Model: "deepseek-flash", Endpoint: c.Provider.Endpoint}, env)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Provider.Model != c.Provider.Model || loaded.Provider.Endpoint != c.Provider.Endpoint {
		t.Fatal("explicit overrides did not win")
	}
	c.Provider.Model = "deepseek-v4-pro"
	b, _ := json.Marshal(c)
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	if loaded.Provider.Model != "deepseek-flash" {
		t.Fatal("existing snapshot was mutated")
	}
	next, err := Load(Overrides{Path: path}, environment(nil))
	if err != nil || next.Provider.Model != "deepseek-v4-pro" {
		t.Fatalf("next snapshot = %+v, %v", next.Provider, err)
	}
}

func TestInitRefusesOverwriteAndNeverStoresCredential(t *testing.T) {
	c, path := fixture(t)
	before, _ := os.ReadFile(path)
	if _, err := Init(path, t.TempDir()); err == nil {
		t.Fatal("configuration was overwritten")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("existing configuration changed")
	}
	const key = "synthetic-credential-do-not-emit"
	value, err := Credential(c.Provider, environment(map[string]string{c.Provider.CredentialEnv: key}))
	if err != nil || value != key {
		t.Fatal("credential reference not resolved")
	}
	b, _ := json.Marshal(c)
	if strings.Contains(string(b), key) {
		t.Fatal("credential serialized")
	}
	if _, err := Credential(c.Provider, environment(map[string]string{c.Provider.CredentialEnv: key + "\n"})); err == nil || strings.Contains(err.Error(), key) {
		t.Fatal("unsafe credential error")
	}
}

func TestConfigRejectsInvalidAndAmbiguousJSONWithoutEchoingSecrets(t *testing.T) {
	_, path := fixture(t)
	cases := []string{
		`{"version":1,"apiKey":"synthetic-secret"}`,
		`{"version":1,"version":2}`,
		`{"version":1,"provider":{"model":"deepseek-flash","model":"deepseek-v4-pro"}}`,
		`{"version":"synthetic-secret"}`,
		`{"version":1} {}`,
		`null`,
		`{"version":1,"provider":null}`,
		`{`,
		`{}`,
		`{"version":2}`,
		strings.Repeat(" ", MaxConfigBytes+1),
	}
	for i, raw := range cases {
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(Overrides{Path: path}, environment(nil)); err == nil || strings.Contains(err.Error(), "synthetic-secret") {
			t.Fatalf("case %d: %v", i, err)
		}
	}
}

func TestValidateEndpointLimitsAndCredentialBoundary(t *testing.T) {
	c, _ := fixture(t)
	cases := []struct {
		name   string
		mutate func(*Config)
	}{
		{"remoteHTTP", func(c *Config) { c.Provider.Endpoint = "http://example.test/chat/completions" }},
		{"URLCredential", func(c *Config) { c.Provider.Endpoint = "https://secret@example.test/chat/completions" }},
		{"URLQuery", func(c *Config) { c.Provider.Endpoint += "?key=secret" }},
		{"URLFragment", func(c *Config) { c.Provider.Endpoint += "#secret" }},
		{"baseURL", func(c *Config) { c.Provider.Endpoint = "https://api.deepseek.com" }},
		{"unknownProtocol", func(c *Config) { c.Provider.Protocol = "compatible" }},
		{"unknownModel", func(c *Config) { c.Provider.Model = "unverified-model" }},
		{"relativeData", func(c *Config) { c.DataDir = "data" }},
		{"relativeRoot", func(c *Config) { c.WorkspaceRoots = []string{"."} }},
		{"noWorkspace", func(c *Config) { c.WorkspaceRoots = nil }},
		{"timeout", func(c *Config) { c.Provider.TimeoutSeconds = 0 }},
		{"retries", func(c *Config) { c.Provider.MaxRetries = 6 }},
		{"event", func(c *Config) { c.Provider.MaxEventBytes = 0 }},
		{"response", func(c *Config) { c.Provider.MaxResponseBytes = 1 }},
		{"tokens", func(c *Config) { c.Provider.MaxOutputTokens = 0 }},
		{"steps", func(c *Config) { c.Limits.MaxSteps = 0 }},
		{"duration", func(c *Config) { c.Limits.MaxDurationSeconds = 0 }},
		{"context", func(c *Config) { c.Limits.MaxContextBytes = 0 }},
		{"output", func(c *Config) { c.Limits.MaxOutputBytes = 0 }},
		{"webToken", func(c *Config) { c.Provider.CredentialEnv = "AGENT_CONTINUE_TOKEN" }},
		{"inheritSecret", func(c *Config) { c.Tools.CommandEnvironment = []string{"DEEPSEEK_API_KEY"} }},
		{"inheritOtherSecret", func(c *Config) { c.Tools.CommandEnvironment = []string{"AWS_SECRET_ACCESS_KEY"} }},
		{"isolation", func(c *Config) { c.Tools.Isolation = "container" }},
		{"unknownTool", func(c *Config) { c.Tools.AllowedTools = []string{"magic"} }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			copy := c
			test.mutate(&copy)
			if err := Validate(copy); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
	for _, endpoint := range []string{"http://127.0.0.1:1234/chat/completions", "http://[::1]:1234/v1/chat/completions"} {
		copy := c
		copy.Provider.Endpoint = endpoint
		if err := Validate(copy); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCommandEnvironmentIsAnAllowlist(t *testing.T) {
	c, _ := fixture(t)
	c.Tools.CommandEnvironment = []string{"PATH", "DEEPSEEK_API_KEY", "AGENT_CONTINUE_TOKEN", "OTHER_API_KEY", "PRIVATE_TOKEN", "CUSTOM_CREDENTIAL"}
	c.Provider.CredentialEnv = "CUSTOM_CREDENTIAL"
	env := environment(map[string]string{"PATH": "safe-path", "DEEPSEEK_API_KEY": "secret", "AGENT_CONTINUE_TOKEN": "secret", "OTHER_API_KEY": "secret", "PRIVATE_TOKEN": "secret", "CUSTOM_CREDENTIAL": "secret", "UNLISTED": "secret"})
	got := CommandEnv(c, env)
	if len(got) != 1 || got[0] != "PATH=safe-path" {
		t.Fatalf("environment = %v", got)
	}
}

func TestCreateFileIsAValidConfiguredWriteTool(t *testing.T) {
	c, _ := fixture(t)
	c.Tools.Mode = "allow"
	c.Tools.AllowedTools = []string{"create_file", "apply_patch"}
	if err := Validate(c); err != nil {
		t.Fatal(err)
	}
}
