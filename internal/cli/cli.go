// Package cli owns independent runtime commands. Migration commands retain
// their existing parser and reports in internal/app.
package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/provider"
)

const Usage = `agent-continue config init [--config FILE] [--cwd DIR]
agent-continue config show|check [--config FILE] [--model MODEL] [--endpoint URL] [--data-dir DIR]
agent-continue models list [--config FILE] [--model MODEL]
agent-continue doctor [--config FILE]
agent-continue version
agent-continue run --cwd DIR [--prompt TEXT] [--config FILE] [--model MODEL] [--json]
agent-continue chat [--cwd DIR] [--config FILE] [--model MODEL]
agent-continue resume ID [--prompt TEXT] [--config FILE] [--model MODEL] [--json]
agent-continue sessions list [--config FILE]
agent-continue sessions show|export ID [--config FILE]
Configuration precedence: flags > AGENT_CONTINUE_* environment > file > defaults.
Model credentials are environment references. Run/resume read stdin if prompt is omitted.
Chat: /new, /exit, /quit. Resume without prompt opens chat in an interactive terminal.
JSON runs emit NDJSON events; approval-required writes are denied without a terminal.
Local sessions live in dataDir/cli-v1 and are inaccessible to the web workbench.`

var Version = "0.1.0-dev"
var Commit = "unknown"

type Build struct {
	Version  string `json:"version"`
	Commit   string `json:"commit"`
	Modified bool   `json:"modified"`
	Go       string `json:"go"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
}

func BuildInfo() Build {
	b := Build{Version: Version, Commit: Commit, Go: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" && b.Commit == "unknown" {
				b.Commit = setting.Value
			}
			if setting.Key == "vcs.modified" {
				b.Modified = setting.Value == "true"
			}
		}
	}
	return b
}

func options(args []string, allowed string) (map[string]string, error) {
	result := map[string]string{}
	valid := map[string]bool{}
	for _, name := range strings.Fields(allowed) {
		valid[name] = true
	}
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "--") {
			return nil, errors.New("Expected a named option")
		}
		name := strings.TrimPrefix(args[i], "--")
		if !valid[name] {
			return nil, errors.New("Unknown option for this command")
		}
		if _, exists := result[name]; exists {
			return nil, fmt.Errorf("Duplicate option --%s", name)
		}
		i++
		if i >= len(args) || args[i] == "" || strings.HasPrefix(args[i], "--") {
			return nil, fmt.Errorf("Missing value for --%s", name)
		}
		result[name] = args[i]
	}
	return result, nil
}

func output(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

// Execute returns handled=false so the caller can use the legacy parser.
func Execute(args []string, stdout io.Writer, env config.LookupEnv) (handled bool, err error) {
	if len(args) == 0 {
		return false, nil
	}
	command := args[0]
	switch command {
	case "config", "models", "doctor", "version":
	default:
		return false, nil
	}
	remaining := args[1:]
	subcommand, allowed := "", "config"
	if command == "config" || command == "models" {
		if len(remaining) == 0 {
			return true, errors.New("Required subcommand is missing")
		}
		subcommand, remaining = remaining[0], remaining[1:]
		if command == "config" {
			switch subcommand {
			case "init":
				allowed = "config cwd"
			case "show", "check":
				allowed = "config model endpoint data-dir"
			default:
				return true, errors.New("Unknown config subcommand")
			}
		} else {
			if subcommand != "list" {
				return true, errors.New("Unknown models subcommand")
			}
			allowed = "config model"
		}
	}
	if command == "version" {
		allowed = ""
	}
	flags, err := options(remaining, allowed)
	if err != nil {
		return true, err
	}
	if command == "version" {
		return true, output(stdout, BuildInfo())
	}
	path, err := config.Path(flags["config"], env)
	if err != nil {
		return true, err
	}
	if command == "config" && subcommand == "init" {
		cwd := flags["cwd"]
		if cwd == "" {
			cwd, err = os.Getwd()
			if err != nil {
				return true, errors.New("cannot locate current workspace; use --cwd")
			}
		}
		if _, err := config.Init(path, cwd); err != nil {
			return true, err
		}
		return true, output(stdout, struct {
			Command string `json:"command"`
			Path    string `json:"path"`
			Status  string `json:"status"`
		}{"config init", path, "created"})
	}
	c, err := config.Load(config.Overrides{Path: path, Model: flags["model"], Endpoint: flags["endpoint"], DataDir: flags["data-dir"]}, env)
	if err != nil {
		return true, err
	}
	if command == "config" && subcommand == "show" {
		return true, output(stdout, c)
	}
	if command == "models" {
		return true, output(stdout, provider.Models(c.Provider))
	}
	checks := config.Checks(c, env)
	if command == "doctor" {
		checks = append(checks, dataDirectoryCheck(c.DataDir))
	}
	ready := true
	for _, check := range checks {
		ready = ready && check.OK
	}
	report := struct {
		Command string         `json:"command"`
		Ready   bool           `json:"ready"`
		Checks  []config.Check `json:"checks"`
		Build   *Build         `json:"build,omitempty"`
	}{Command: command, Ready: ready, Checks: checks}
	if command == "config" {
		report.Command = "config check"
	} else {
		build := BuildInfo()
		report.Build = &build
	}
	if err := output(stdout, report); err != nil {
		return true, err
	}
	if !ready {
		return true, errors.New("local readiness checks failed; see checks in the JSON report")
	}
	return true, nil
}

func dataDirectoryCheck(path string) config.Check {
	result := config.Check{Name: "dataDirectory", Detail: "temporary write probe in data directory or nearest existing parent"}
	candidate := path
	for {
		info, err := os.Stat(candidate)
		if err == nil {
			if !info.IsDir() {
				return result
			}
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			return result
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return result
		}
		candidate = parent
	}
	f, err := os.CreateTemp(candidate, ".agent-continue-doctor-*")
	if err != nil {
		return result
	}
	name := f.Name()
	_, writeErr := f.Write([]byte("probe"))
	closeErr := f.Close()
	removeErr := os.Remove(name)
	result.OK = writeErr == nil && closeErr == nil && removeErr == nil
	return result
}
