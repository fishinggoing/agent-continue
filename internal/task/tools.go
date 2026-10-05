package task

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/fishinggoing/agent-continue/internal/domain"
)

const originalRules = "{\n  \"currency\": \"CNY\",\n  \"discountBase\": \"total\",\n  \"roundDigits\": 2\n}\n"
const fixedRules = "{\n  \"currency\": \"CNY\",\n  \"discountBase\": \"subtotal\",\n  \"roundDigits\": 2\n}\n"
const testCases = `[
  {"name":"discount excludes shipping", "subtotal":100,"shipping":10,"discount":0.1,"expected":100},
  {"name":"free shipping", "subtotal":200,"shipping":0,"discount":0.2,"expected":160},
  {"name":"no discount", "subtotal":80,"shipping":12,"discount":0,"expected":92},
  {"name":"round to cents", "subtotal":99.99,"shipping":5,"discount":0.15,"expected":89.99}
]
`

type Files struct {
	root    *os.Root
	generic bool
	local   *localPolicy
}
type Patch struct {
	Path   string `json:"path"`
	Before string `json:"before"`
	After  string `json:"after"`
}
type TestResult struct {
	Name     string  `json:"name"`
	Actual   float64 `json:"actual"`
	Expected float64 `json:"expected"`
	Passed   bool    `json:"passed"`
}

func (f *Files) Definitions() []domain.ToolDefinition {
	if f.generic {
		return f.workspaceDefinitions()
	}
	return []domain.ToolDefinition{
		{Name: "list_files", Description: "List the server-owned pricing demo workspace files.", Parameters: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)},
		{Name: "read_file", Description: "Read a demo workspace text file.", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","enum":["pricing.json","pricing.test.json"]}},"required":["path"],"additionalProperties":false}`)},
		{Name: "apply_patch", Description: "Replace exact old text in pricing.json after explicit approval. Preserve the user's current content; fail on conflicts. No file deletion.", Writes: true, Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","enum":["pricing.json"]},"before":{"type":"string"},"after":{"type":"string"}},"required":["path","before","after"],"additionalProperties":false}`)},
		{Name: "run_tests", Description: "Execute all pricing.test.json cases against current pricing.json using the built-in pricing evaluator. This is a real rule test runner, not a shell command.", Parameters: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)},
	}
}

func strictJSON(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return errors.New("invalid tool parameters")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("expected one JSON object")
	}
	return nil
}

func (f *Files) Validate(ctx context.Context, call domain.ToolCall) (domain.ValidatedToolCall, error) {
	if err := ctx.Err(); err != nil {
		return domain.ValidatedToolCall{}, err
	}
	if len(call.Arguments) > 256<<10 || call.ID == "" {
		return domain.ValidatedToolCall{}, errors.New("invalid call size or identity")
	}
	if f.local != nil && containsProtectedJSON(call.Arguments, f.local.secrets) {
		return domain.ValidatedToolCall{}, errors.New("tool arguments contain a protected model credential")
	}
	var args any
	switch call.Name {
	case "list_files", "run_tests":
		v := struct{}{}
		if err := strictJSON(call.Arguments, &v); err != nil {
			return domain.ValidatedToolCall{}, err
		}
		args = v
	case "read_file":
		v := struct {
			Path string `json:"path"`
		}{}
		if err := strictJSON(call.Arguments, &v); err != nil {
			return domain.ValidatedToolCall{}, err
		}
		if !f.allowed(v.Path) {
			return domain.ValidatedToolCall{}, errors.New("file is outside demo tool scope")
		}
		args = v
	case "apply_patch":
		v := Patch{}
		if err := strictJSON(call.Arguments, &v); err != nil {
			return domain.ValidatedToolCall{}, err
		}
		if (!f.generic && (v.Path != "pricing.json" || len(v.After) > 8192)) || !f.allowed(v.Path) || v.Before == "" || len(v.After) > maxFileBytes || !utf8.ValidString(v.After) || strings.ContainsRune(v.After, 0) {
			return domain.ValidatedToolCall{}, errors.New("invalid patch scope or size")
		}
		args = v
	case "create_file":
		v := FileInput{}
		if !f.generic || strictJSON(call.Arguments, &v) != nil || validateUploads([]FileInput{v}) != nil {
			return domain.ValidatedToolCall{}, errors.New("invalid new file scope or content")
		}
		if !f.allowed(v.Path) || f.local != nil && containsProtectedText(v.Content, f.local.secrets) {
			return domain.ValidatedToolCall{}, errors.New("invalid new file scope or content")
		}
		args = v
	default:
		return domain.ValidatedToolCall{}, errors.New("unknown tool")
	}
	b, _ := json.Marshal(args)
	hash := sha256.Sum256(b)
	return domain.ValidatedToolCall{Call: call, CanonicalArguments: b, ArgumentsHash: hex.EncodeToString(hash[:])}, nil
}

func allowedFile(path string) bool { return path == "pricing.json" || path == "pricing.test.json" }
func (f *Files) allowed(name string) bool {
	if f.local != nil {
		return f.localCheck(name, true) == nil
	}
	if f.generic {
		return validPath(name)
	}
	return allowedFile(name)
}
func (f *Files) Read(path string) (string, error) {
	if !f.allowed(path) {
		return "", errors.New("file is outside demo tool scope")
	}
	info, err := f.root.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFileBytes {
		return "", errors.New("expected a small regular file")
	}
	h, err := f.root.Open(path)
	if err != nil {
		return "", err
	}
	defer h.Close()
	if f.local != nil {
		if f.localCheck(path, false) != nil || hasMultipleLinks(h) {
			return "", errors.New("local file links are not permitted")
		}
	}
	b, err := io.ReadAll(io.LimitReader(h, maxFileBytes+1))
	if len(b) > maxFileBytes {
		return "", errors.New("file too large")
	}
	if !utf8.Valid(b) || strings.ContainsRune(string(b), 0) {
		return "", errors.New("expected UTF-8 text")
	}
	if f.local != nil && containsProtectedText(string(b), f.local.secrets) {
		return "", errors.New("file contains a protected model credential")
	}
	return string(b), err
}

func (f *Files) Execute(ctx context.Context, call domain.ValidatedToolCall) (domain.ToolResult, error) {
	r := domain.ToolResult{CallID: call.Call.ID, Status: domain.ToolCompleted}
	if err := ctx.Err(); err != nil {
		return r, err
	}
	switch call.Call.Name {
	case "list_files":
		files, err := f.List()
		if err != nil {
			return r, err
		}
		r.Output = strings.Join(files, "\n")
		if r.Output == "" {
			r.Output = "Workspace is empty. No files have been uploaded or created."
		}
	case "read_file":
		var args struct{ Path string }
		json.Unmarshal(call.CanonicalArguments, &args)
		text, err := f.Read(args.Path)
		if err != nil {
			return r, err
		}
		r.Output = text
	case "apply_patch":
		var p Patch
		json.Unmarshal(call.CanonicalArguments, &p)
		old, err := f.Read(p.Path)
		if err != nil {
			return r, err
		}
		if strings.Count(old, p.Before) != 1 {
			return r, errors.New("patch conflict: expected old text does not occur exactly once")
		}
		next := strings.Replace(old, p.Before, p.After, 1)
		if f.local != nil && containsProtectedText(next, f.local.secrets) {
			return r, errors.New("write contains a protected model credential")
		}
		if len(next) > maxFileBytes || !f.generic && (len(next) > 8192 || !json.Valid([]byte(next))) {
			return r, errors.New("patch must produce a small valid JSON rules file")
		}
		mode := os.FileMode(0600)
		if f.local != nil {
			info, err := f.root.Lstat(p.Path)
			if err != nil || !info.Mode().IsRegular() {
				return r, errors.New("patch target is no longer a regular file")
			}
			mode = info.Mode().Perm()
		}
		tempPath := path.Join(path.Dir(p.Path), ".patch-"+newID()+".tmp")
		tmp, err := f.root.OpenFile(tempPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return r, err
		}
		defer f.root.Remove(tempPath)
		_, err = tmp.WriteString(next)
		if err == nil && f.local != nil {
			err = tmp.Chmod(mode)
		}
		if err == nil {
			err = tmp.Sync()
		}
		closeErr := tmp.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return r, err
		}
		current, err := f.Read(p.Path)
		if err != nil {
			return r, err
		}
		if current != old {
			return r, errors.New("patch conflict: file changed while preparing write")
		}
		if err = f.root.Rename(tempPath, p.Path); err != nil {
			return r, err
		}
		r.Output = "Updated " + p.Path + "; exact old content matched."
	case "create_file":
		var file FileInput
		json.Unmarshal(call.CanonicalArguments, &file)
		names, err := f.List()
		if err != nil {
			return r, err
		}
		limit := maxWorkspaceFiles
		if f.local != nil {
			limit = maxLocalFiles
		}
		if len(names) >= limit {
			return r, errors.New("workspace file limit reached")
		}
		if f.local != nil && (f.localCheck(file.Path, true) != nil || containsProtectedText(file.Content, f.local.secrets)) {
			return r, errors.New("invalid new file scope or content")
		}
		if err := writeUpload(f.root, file); err != nil {
			return r, err
		}
		r.Output = "Created " + file.Path
	case "run_tests":
		if f.generic {
			return r, errors.New("no test runner is available in this workspace")
		}
		results, err := f.Test(ctx)
		if err != nil {
			return r, err
		}
		code := 0
		var out strings.Builder
		for _, test := range results {
			status := "PASS"
			if !test.Passed {
				status = "FAIL"
				code = 1
			}
			fmt.Fprintf(&out, "%s  %s  actual=%.2f expected=%.2f\n", status, test.Name, test.Actual, test.Expected)
		}
		r.Stdout = out.String()
		r.Output = r.Stdout
		r.ExitCode = &code
		if code != 0 {
			r.Status = domain.ToolFailed
		}
	}
	return r, nil
}

func (f *Files) workspaceDefinitions() []domain.ToolDefinition {
	definitions := []domain.ToolDefinition{
		{Name: "list_files", Description: "List files explicitly uploaded or created in this session's isolated workspace.", Parameters: json.RawMessage(`{"type":"object","properties":{},"required":[],"additionalProperties":false}`)},
		{Name: "read_file", Description: "Read an uploaded or created UTF-8 text file, up to 64 KiB, using its relative path.", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}`)},
		{Name: "apply_patch", Description: "Replace exact old text in a workspace file after approval. The old text must occur exactly once. No deletion.", Writes: true, Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"},"before":{"type":"string"},"after":{"type":"string"}},"required":["path","before","after"],"additionalProperties":false}`)},
		{Name: "create_file", Description: "Create a new UTF-8 text file after approval; existing files cannot be overwritten. Maximum 64 KiB per file, 32 files.", Writes: true, Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}`)},
	}
	if f.local != nil {
		definitions[0].Description = "List permitted local workspace text files, excluding protected paths, dependencies, links and large files. Bounded to 2000 files and 20000 scanned entries."
		definitions[1].Description = "Read a permitted local UTF-8 text file, up to 64 KiB, using its relative path. Credential files and links are protected."
		definitions[2].Description = "Replace exact old text in a permitted local file according to configured write policy. Old text must occur exactly once. No deletion."
		definitions[3].Description = "Create a permitted new local UTF-8 text file according to configured write policy; existing files cannot be overwritten. Maximum 64 KiB."
	}
	return definitions
}

func (f *Files) Test(ctx context.Context) ([]TestResult, error) {
	rules, err := f.Read("pricing.json")
	if err != nil {
		return nil, err
	}
	var config struct {
		Currency     string `json:"currency"`
		DiscountBase string `json:"discountBase"`
		RoundDigits  int    `json:"roundDigits"`
	}
	if err = strictJSON([]byte(rules), &config); err != nil {
		return nil, err
	}
	if (config.DiscountBase != "total" && config.DiscountBase != "subtotal") || config.RoundDigits < 0 || config.RoundDigits > 4 {
		return nil, errors.New("invalid pricing rule configuration")
	}
	data, err := f.Read("pricing.test.json")
	if err != nil {
		return nil, err
	}
	var cases []struct {
		Name                                   string
		Subtotal, Shipping, Discount, Expected float64
	}
	if err = json.Unmarshal([]byte(data), &cases); err != nil || len(cases) != 4 {
		return nil, errors.New("invalid demo test cases")
	}
	result := []TestResult{}
	scale := math.Pow10(config.RoundDigits)
	for _, c := range cases {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		base := c.Subtotal
		if config.DiscountBase == "total" {
			base += c.Shipping
		}
		actual := math.Round((c.Subtotal+c.Shipping-base*c.Discount)*scale) / scale
		result = append(result, TestResult{Name: c.Name, Actual: actual, Expected: c.Expected, Passed: math.Abs(actual-c.Expected) < 0.00001})
	}
	return result, nil
}
