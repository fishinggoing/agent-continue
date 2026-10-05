package migrate

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/klauspost/compress/zstd"
)

const MaxInputBytes = 128 << 20
const MaxDecodedBytes = 256 << 20
const MaxUploadBytes = 16 << 20
const MaxUploadDecodedBytes = 32 << 20

const (
	maxUploadJSONDepth  = 256
	maxUploadJSONTokens = 1000000
)

type Source struct {
	Kind    string
	Header  Object
	Records []Object
	Events  []Object
}

func (s *Source) Cwd() string {
	if s.Kind == "dsh" {
		return str(s.Header["cwd"])
	}
	if len(s.Records) > 0 {
		return str(obj(s.Records[0]["payload"])["cwd"])
	}
	return ""
}
func (s *Source) Count() int {
	if s.Kind == "dsh" {
		return len(s.Events)
	}
	return len(s.Records)
}

var knownTypes = stringSet(`agent-preset/selected agent/inbox/spliced approval/asked approval/decided approval/policy assistant/attempt assistant/message command/done command/run compaction/end compaction/prune compaction/start compaction/summary deliverables/presented developer/message feedback/message-delete feedback/message-put feedback/record goal/change hook/invoked hook/result image/offload llm/retry llm/retry-started model/selection permission/preset plan/mode request/context request/header sandbox/mode schedule/change session-log-deepseek/delivery-accepted session/end-seed session/title session/title-llm-request step/end step/start subagent/catalog subagent/descriptor subagent/model-selection-policy system/message team/member team/message/delivered team/message/queued team/task todo/write tool-workflow/agent-end tool-workflow/agent-start tool-workflow/run-end tool-workflow/run-start tool/call tool/ptc-dispatch tool/ptc-dispatch-start tool/result turn/end turn/start user/message web/deepseek-search-llm-request workspace/changes`)
var surfaceTypes = stringSet(`system/message developer/message user/message assistant/message tool/result`)

func stringSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, v := range strings.Fields(s) {
		m[v] = true
	}
	return m
}
func ParseSource(kind, filename string, data []byte) (*Source, error) {
	return parseSource(kind, filename, data, MaxDecodedBytes, 0)
}

// ParseUpload applies tighter resource limits to the shared server than to local CLI use.
func ParseUpload(kind, filename string, data []byte) (*Source, error) {
	if len(data) > MaxUploadBytes {
		return nil, fmt.Errorf("Web upload exceeds the 16 MiB limit; use the local CLI for larger files")
	}
	return parseSource(kind, filename, data, MaxUploadDecodedBytes, 100000)
}

func parseSource(kind, filename string, data []byte, decodedLimit, recordLimit int) (*Source, error) {
	if len(data) > MaxInputBytes {
		return nil, fmt.Errorf("Input exceeds the 128 MiB source limit")
	}
	if kind != "codex" && kind != "dsh" {
		return nil, fmt.Errorf("--from must be codex or dsh")
	}
	if kind == "dsh" && strings.HasSuffix(filename, ".zstd") {
		var err error
		data, err = decodeFrames(data, decodedLimit)
		if err != nil {
			return nil, err
		}
	}
	if len(data) > decodedLimit {
		return nil, fmt.Errorf("decoded source exceeds %d MiB limit", decodedLimit>>20)
	}
	s := &Source{Kind: kind, Records: []Object{}, Events: []Object{}}
	var jsonBudget *jsonResourceBudget
	if recordLimit > 0 {
		jsonBudget = &jsonResourceBudget{maxTokens: maxUploadJSONTokens}
	}
	// IndexByte visits one line at a time without allocating a slice per blank line.
	for i := 0; len(data) > 0; i++ {
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			end = len(data)
		}
		line := data[:end]
		if end < len(data) {
			data = data[end+1:]
		} else {
			data = nil
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if recordLimit > 0 && s.Count() >= recordLimit {
			return nil, fmt.Errorf("Web session exceeds the %d record limit; use the local CLI", recordLimit)
		}
		if jsonBudget != nil {
			if err := checkJSONResources(line, jsonBudget); err != nil {
				return nil, err
			}
		}
		var o Object
		if err := json.Unmarshal(line, &o); err != nil || o == nil {
			return nil, fmt.Errorf("Damaged %s source at line %d; refusing partial migration", kind, i+1)
		}
		if kind == "codex" {
			preserveCustomInputs(o, line)
			_, hasTime := o["timestamp"].(string)
			_, hasType := o["type"].(string)
			_, hasPayload := o["payload"].(map[string]any)
			// Codex permits array payloads in its envelope; converters only interpret objects.
			if _, ok := o["payload"].([]any); ok {
				hasPayload = true
			}
			if !hasTime || !hasType || !hasPayload || (present(o, "ordinal") && !safeInt(o["ordinal"])) {
				return nil, fmt.Errorf("Damaged Codex source at line %d; refusing partial migration", i+1)
			}
			s.Records = append(s.Records, o)
		} else if s.Header == nil {
			s.Header = o
			if err := ValidateHeader(o); err != nil {
				return nil, err
			}
		} else {
			if err := ValidateEvent(o, len(s.Events)); err != nil {
				return nil, err
			}
			s.Events = append(s.Events, o)
		}
	}
	if kind == "codex" {
		if len(s.Records) == 0 || s.Records[0]["type"] != "session_meta" {
			return nil, fmt.Errorf("Codex source must begin with session_meta")
		}
	} else {
		if s.Header == nil {
			return nil, fmt.Errorf("session log is empty")
		}
		v := int(num(s.Header["version"]))
		if v != 3 && v != 4 {
			return nil, fmt.Errorf("Unsupported DSH format version %d", v)
		}
		m := regexp.MustCompile(`session\.v(\d+)\.jsonl(?:\.zstd)?$`).FindStringSubmatch(filename)
		if len(m) > 0 {
			expected, _ := strconv.Atoi(m[1])
			if expected != v {
				return nil, fmt.Errorf("DSH header version does not match artifact filename")
			}
		}
	}
	return s, nil
}

// JSON.stringify uses insertion order for non-index keys. Retain raw custom
// inputs, including calls nested in compaction snapshots, before maps lose it.
func preserveCustomInputs(value any, raw json.RawMessage) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	_ = preserveJSONValue(decoder, raw, value)
}

// preserveJSONValue consumes exactly one JSON value from decoder. It walks the
// decoded value alongside the token stream, so raw child values are retained
// as slices of the original input instead of being decoded again at every
// level. A duplicate object key is consumed in source order; assigning each
// occurrence consequently retains the last occurrence, matching json.Unmarshal.
func preserveJSONValue(decoder *json.Decoder, raw []byte, value any) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	switch delim := token.(type) {
	case json.Delim:
		switch delim {
		case '{':
			object, isObject := value.(map[string]any)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("JSON object key is not a string")
				}
				keyEnd := decoder.InputOffset()
				var child any
				if isObject {
					child = object[key]
				}
				if isObject && key == "input" && object["type"] == "custom_tool_call" && child != nil {
					if err := consumeJSONValue(decoder); err != nil {
						return err
					}
					end := decoder.InputOffset()
					if start, finish, ok := rawValueBounds(raw, keyEnd, end); ok {
						object[key] = json.RawMessage(raw[start:finish])
					}
					continue
				}
				if err := preserveJSONValue(decoder, raw, child); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil {
				return err
			}
			if closing != json.Delim('}') {
				return fmt.Errorf("JSON object is not closed")
			}
		case '[':
			array, isArray := value.([]any)
			index := 0
			for decoder.More() {
				var child any
				if isArray && index < len(array) {
					child = array[index]
				}
				if err := preserveJSONValue(decoder, raw, child); err != nil {
					return err
				}
				index++
			}
			closing, err := decoder.Token()
			if err != nil {
				return err
			}
			if closing != json.Delim(']') {
				return fmt.Errorf("JSON array is not closed")
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter")
		}
	}
	return nil
}

// consumeJSONValue skips one JSON value without allocating a decoded subtree.
// It is used for raw custom inputs, whose bytes are sliced after the value has
// been fully consumed.
func consumeJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok || (delim != '{' && delim != '[') {
		return nil
	}
	depth := 1
	for depth > 0 {
		token, err = decoder.Token()
		if err != nil {
			return err
		}
		delim, ok = token.(json.Delim)
		if !ok {
			continue
		}
		switch delim {
		case '{', '[':
			depth++
		case '}', ']':
			depth--
		}
	}
	return nil
}

// rawValueBounds returns the value bytes following an object key. InputOffset
// is at the end of the key before the colon, and after consuming the child it
// is at the end of that child. Keep the slice tied to raw so no subtree copy is
// made; only the colon and whitespace before the value are discarded.
func rawValueBounds(raw []byte, keyEnd, end int64) (int, int, bool) {
	start := keyEnd
	finish := end
	if start < 0 || finish < start || finish > int64(len(raw)) {
		return 0, 0, false
	}
	for start < finish && (raw[start] == ':' || raw[start] == ' ' || raw[start] == '\t' || raw[start] == '\r' || raw[start] == '\n') {
		start++
	}
	return int(start), int(finish), true
}

type jsonResourceBudget struct {
	maxTokens int
	tokens    int
}

// checkJSONResources performs a token-only pass before unmarshalling an upload.
// Syntax errors are left for the existing line-level validation so callers
// retain the normal damaged-source error; budget failures are deliberately
// generic and contain no source text.
func checkJSONResources(raw []byte, budget *jsonResourceBudget) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	depth := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return nil
		}
		budget.tokens++
		if budget.tokens > budget.maxTokens {
			return fmt.Errorf("Web session exceeds the %d JSON token limit", budget.maxTokens)
		}
		if delim, ok := token.(json.Delim); ok {
			switch delim {
			case '{', '[':
				depth++
				if depth > maxUploadJSONDepth {
					return fmt.Errorf("Web JSON exceeds the maximum nesting depth of %d", maxUploadJSONDepth)
				}
			case '}', ']':
				depth--
			}
		}
	}
}

func ValidateHeader(h Object) error {
	allowed := stringSet("type version id createdAt isSeeded delegationDepth cwd parentSession origin agentPreset")
	for k := range h {
		if !allowed[k] {
			return fmt.Errorf("session header has unknown key %q", k)
		}
	}
	for _, k := range []string{"version", "createdAt", "delegationDepth"} {
		if !safeInt(h[k]) || num(h[k]) < 0 {
			return fmt.Errorf("session header %s must be a non-negative safe integer", k)
		}
	}
	if h["type"] != "session" || str(h["id"]) == "" {
		return fmt.Errorf("invalid session header identity")
	}
	if _, ok := h["isSeeded"].(bool); !ok {
		return fmt.Errorf("session header isSeeded must be a boolean")
	}
	if v, ok := h["origin"]; ok && v != "subagent" {
		return fmt.Errorf("session header origin must be subagent when present")
	}
	for _, k := range []string{"cwd", "parentSession", "agentPreset"} {
		if v, ok := h[k]; ok {
			if _, ok := v.(string); !ok {
				return fmt.Errorf("session header %s must be a string", k)
			}
		}
	}
	return nil
}
func ValidateEvent(e Object, index int) error {
	allowed := stringSet("type seq time data surfaceOp sourceEventSeqs ignorable")
	for k := range e {
		if !allowed[k] {
			return fmt.Errorf("event %d has unknown envelope key %q", index, k)
		}
	}
	if str(e["type"]) == "" || !safeInt(e["seq"]) || num(e["seq"]) != float64(index) || !safeInt(e["time"]) || num(e["time"]) < 0 {
		return fmt.Errorf("invalid event %d type, seq or time", index)
	}
	if _, ok := e["data"]; !ok {
		return fmt.Errorf("event %d is missing data", index)
	}
	operation, hasOp := e["surfaceOp"]
	if surfaceTypes[str(e["type"])] != hasOp {
		return fmt.Errorf("event %d has invalid surfaceOp eligibility", index)
	}
	if hasOp && operation != "append" {
		o := obj(operation)
		if o["op"] != "replace" || !safeInt(o["startSeq"]) || num(o["startSeq"]) < 0 || !safeInt(o["endSeq"]) || num(o["endSeq"]) < 0 {
			return fmt.Errorf("event %d has invalid surfaceOp", index)
		}
	}
	if v, ok := e["ignorable"]; ok && v != true {
		return fmt.Errorf("event %d ignorable must be exactly true", index)
	}
	if !knownTypes[str(e["type"])] && e["ignorable"] != true {
		return fmt.Errorf("event %d has unknown type and no ignorable marker", index)
	}
	if v, ok := e["sourceEventSeqs"]; ok {
		a, ok := v.([]any)
		if !ok {
			if b, yes := v.([]int); yes {
				a = []any{}
				for _, x := range b {
					a = append(a, x)
				}
				ok = true
			}
		}
		if !ok {
			return fmt.Errorf("event %d sourceEventSeqs must be an array", index)
		}
		for _, x := range a {
			if !safeInt(x) || num(x) < 0 {
				return fmt.Errorf("event %d has invalid sourceEventSeqs", index)
			}
		}
	}
	return nil
}

// DecodeFrames structurally validates every frame, including a truncated suffix.
// Output and decoder memory are bounded independently of compressed input size.
func DecodeFrames(data []byte) ([]byte, error) {
	return decodeFrames(data, MaxDecodedBytes)
}

func decodeFrames(data []byte, limit int) ([]byte, error) {
	decoder, err := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(uint64(limit)), zstd.WithDecoderMaxWindow(uint64(limit)))
	if err != nil {
		return nil, err
	}
	defer decoder.Close()
	out := []byte{}
	for offset := 0; offset < len(data); {
		if len(data)-offset < 4 {
			return nil, fmt.Errorf("DSH source has an incomplete trailing frame; refusing partial migration")
		}
		magic := binary.LittleEndian.Uint32(data[offset:])
		end := 0
		if magic >= 0x184d2a50 && magic <= 0x184d2a5f {
			if len(data)-offset < 8 {
				return nil, fmt.Errorf("incomplete trailing frame")
			}
			n := uint64(offset) + 8 + uint64(binary.LittleEndian.Uint32(data[offset+4:]))
			if n > uint64(len(data)) {
				return nil, fmt.Errorf("incomplete trailing frame")
			}
			offset = int(n)
			continue
		}
		if magic != 0xfd2fb528 {
			return nil, fmt.Errorf("not a zstd frame at byte %d", offset)
		}
		end, err = frameEnd(data, offset)
		if err != nil {
			return nil, err
		}
		frame, err := decoder.DecodeAll(data[offset:end], nil)
		if err != nil {
			return nil, fmt.Errorf("invalid zstd frame at byte %d", offset)
		}
		if len(frame) > limit-len(out) {
			return nil, fmt.Errorf("decoded source exceeds %d MiB limit", limit>>20)
		}
		out = append(out, frame...)
		offset = end
	}
	return out, nil
}
func frameEnd(b []byte, start int) (int, error) {
	torn := fmt.Errorf("DSH source has an incomplete trailing frame; refusing partial migration")
	p := start + 4
	if p >= len(b) {
		return 0, torn
	}
	d := b[p]
	p++
	if d&8 != 0 {
		return 0, fmt.Errorf("reserved frame header bit is set")
	}
	single := (d >> 5) & 1
	if single == 0 {
		p++
	}
	p += []int{0, 1, 2, 4}[d&3]
	if d>>6 == 0 {
		p += int(single)
	} else {
		p += []int{0, 2, 4, 8}[d>>6]
	}
	if p > len(b) {
		return 0, torn
	}
	for {
		if p+3 > len(b) {
			return 0, torn
		}
		h := uint32(b[p]) | uint32(b[p+1])<<8 | uint32(b[p+2])<<16
		p += 3
		kind := (h >> 1) & 3
		if kind == 3 {
			return 0, fmt.Errorf("reserved block type")
		}
		if kind == 1 {
			p++
		} else {
			p += int(h >> 3)
		}
		if p > len(b) {
			return 0, torn
		}
		if h&1 != 0 {
			break
		}
	}
	if d&4 != 0 {
		p += 4
	}
	if p > len(b) {
		return 0, torn
	}
	return p, nil
}
func EncodeDSH(header Object, events []Object) ([]byte, error) {
	if e := ValidateHeader(header); e != nil {
		return nil, e
	}
	for i, event := range events {
		if e := ValidateEvent(event, i); e != nil {
			return nil, e
		}
	}
	enc, e := zstd.NewWriter(nil, zstd.WithEncoderCRC(true), zstd.WithEncoderConcurrency(1))
	if e != nil {
		return nil, e
	}
	defer enc.Close()
	result := enc.EncodeAll(append([]byte(jsonText(header)), '\n'), nil)
	if len(events) > 0 {
		var batch bytes.Buffer
		for _, e := range events {
			batch.WriteString(jsonText(e))
			batch.WriteByte('\n')
		}
		result = append(result, enc.EncodeAll(batch.Bytes(), nil)...)
	}
	return result, nil
}
func EncodeCodex(drafts []Object, timestamp string) ([]byte, error) {
	var out bytes.Buffer
	for i, d := range drafts {
		record := Object{"type": d["type"], "payload": d["payload"], "ordinal": i, "timestamp": coalesce(d["timestamp"], timestamp)}
		b, e := json.Marshal(record)
		if e != nil {
			return nil, e
		}
		out.Write(b)
		out.WriteByte('\n')
	}
	return out.Bytes(), nil
}
func (s *Source) Pending() ([]Object, error) {
	pending := map[string]Object{}
	order := []string{}
	add := func(id, name string) {
		if _, ok := pending[id]; !ok {
			order = append(order, id)
		}
		pending[id] = Object{"callId": id, "name": name, "state": "unknown"}
	}
	notices := func(v any) error {
		p, e := PendingOutcomes(v)
		if e != nil {
			return e
		}
		for _, o := range p {
			add(str(o["callId"]), str(o["name"]))
		}
		return nil
	}
	if s.Kind == "codex" {
		for _, r := range s.Records {
			if r["type"] != "response_item" {
				continue
			}
			p := obj(r["payload"])
			if p["type"] == "message" {
				if e := notices(p); e != nil {
					return nil, e
				}
			}
			id, ok := p["call_id"].(string)
			if !ok {
				continue
			}
			switch p["type"] {
			case "function_call", "custom_tool_call":
				add(id, jsString(coalesce(p["name"], "unknown")))
			case "function_call_output", "custom_tool_call_output":
				if p["recovery"] == Unknown {
					if _, ok := pending[id]; !ok {
						add(id, "unknown")
					}
				} else {
					delete(pending, id)
				}
			}
		}
	} else {
		for _, r := range s.Events {
			d := obj(r["data"])
			if r["type"] == "user/message" {
				if e := notices(d["source"]); e != nil {
					return nil, e
				}
			}
			if r["type"] == "tool/call" {
				if id, ok := d["callId"].(string); ok {
					add(id, jsString(coalesce(d["name"], "unknown")))
				}
			} else if r["type"] == "tool/result" {
				m := obj(d["message"])
				id, ok := coalesce(obj(m["source"])["callId"], d["toolCallId"], m["toolCallId"]).(string)
				if !ok {
					continue
				}
				if obj(d["error"])["code"] == Unknown {
					if _, ok := pending[id]; !ok {
						add(id, "unknown")
					}
				} else {
					delete(pending, id)
				}
			}
		}
	}
	out := []Object{}
	seen := map[string]bool{}
	for _, id := range order {
		if p, ok := pending[id]; ok && !seen[id] {
			out = append(out, p)
			seen[id] = true
		}
	}
	return out, nil
}
