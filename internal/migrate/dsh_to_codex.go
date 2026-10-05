package migrate

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

const (
	d2cHistoryMode   = "paginated"
	d2cContentBlocks = "message.content-blocks"
)

type d2cTurnState struct {
	turn      float64
	turnID    string
	startedAt float64
}

type d2cModelSource struct {
	provider    string
	model       string
	hasProvider bool
	hasModel    bool
}

type d2cCallIdentity struct {
	name      string
	arguments string
}

// AssertDshMigrationSource applies the DSH eligibility rules before any
// surface reconstruction or output generation.  Subagent and forked sources
// are deliberately refused because they are not visible to ACP session/list
// and session/resume.
func AssertDshMigrationSource(header Object) error {
	if d2cStringValue(header["origin"]) == "subagent" {
		return fmt.Errorf("Refusing migration: DSH subagent sources are excluded from ACP session/list and session/resume")
	}
	if _, present := header["parentSession"]; present {
		return fmt.Errorf("Refusing migration: DSH forked sources with parentSession are excluded from ACP session/list and session/resume")
	}
	cwd, ok := header["cwd"].(string)
	if !ok || !isAbsolute(cwd) {
		return fmt.Errorf("Refusing migration: DSH source cwd must be an absolute path for ACP visibility; --cwd remapping does not override source eligibility")
	}
	return nil
}

// DshToCodex converts a DSH session into Codex rollout drafts without invoking
// a model.  Header and Events are retained in Conversion for the shared
// bidirectional conversion shape; this direction populates Drafts, Tallies and
// Losses.
func DshToCodex(header Object, events []Object, options Object) (Conversion, error) {
	if err := AssertDshMigrationSource(header); err != nil {
		return Conversion{}, err
	}
	surface, err := CurrentSurface(events)
	if err != nil {
		return Conversion{}, err
	}
	activeSequences := make(map[int]bool, len(surface))
	for _, event := range surface {
		if seq, ok := d2cSafeEventSeq(event); ok {
			activeSequences[seq] = true
		}
	}

	tallies := make(map[string]*Tally)
	tally := func(kind, outcome, reason string, hasReason bool, count int) {
		d2cTally(tallies, kind, outcome, reason, hasReason, count)
	}

	headerCreatedAt := d2cNumberOr(header["createdAt"], 0)
	// ConvertOptions.startedAt is accepted as either an ISO string or epoch
	// milliseconds by the native API.  The TypeScript converter reads it for
	// compatibility but its rollout timestamps are defined by the source
	// header/event times, so validating/normalizing it has no output effect.
	if value, present := options["startedAt"]; present && value != nil {
		if _, err := d2cStartedAt(value); err != nil {
			return Conversion{}, err
		}
	}

	modelSource := d2cFirstModelSource(surface)
	provider := "unknown"
	if value, ok := options["modelProvider"].(string); ok {
		provider = value
	} else if modelSource.hasProvider {
		provider = modelSource.provider
	}
	model := "unknown"
	if modelSource.hasModel {
		model = modelSource.model
	}
	threadID := d2cStringValue(header["id"])
	if value, ok := options["threadId"].(string); ok {
		threadID = value
	}

	drafts := make([]Object, 0)
	var turn *d2cTurnState
	emittedCalls := make(map[string]d2cCallIdentity)
	loggedCalls := make(map[string]Object)
	advertisedCalls := make(map[string]bool)
	settledCalls := make(map[string]bool)
	unresolvedOutcomes := make(map[string]bool)
	owners := make(map[int]float64, len(events))
	sourceTurn := float64(1)
	loggedCallOrder := make([]string, 0)

	// First pass: establish ownership and the call/result audit indexes before
	// the current surface is exported.
	for _, event := range events {
		data := d2cEventData(event)
		seq, seqOK := d2cSafeEventSeq(event)
		if !seqOK {
			// CurrentSurface already rejects malformed seq values.  Keeping an
			// explicit fallback here makes this pass safe for future callers that
			// add events after surface reconstruction.
			continue
		}
		owner := sourceTurn
		if d2cEventType(event) == "turn/start" {
			if value, ok := d2cNumber(data["turn"]); ok {
				sourceTurn = value
				owner = value
			}
		} else if value, ok := d2cNumber(data["turn"]); ok {
			owner = value
		}
		owners[seq] = owner

		kind := d2cEventType(event)
		if kind == "tool/call" {
			callID := d2cJSString(d2cPropertyOrUndefined(data, "callId"))
			key := d2cOwnerCallKey(owner, callID)
			if _, exists := loggedCalls[key]; !exists {
				loggedCallOrder = append(loggedCallOrder, key)
			}
			loggedCalls[key] = event
		}
		if kind == "tool/result" {
			message := d2cObjectValue(data["message"])
			callID := d2cJSString(d2cNullish(message, "toolCallId", d2cNullish(data, "toolCallId", d2cUndefinedValue)))
			if source, ok := d2cObject(message["source"]); ok {
				callID = d2cJSString(d2cNullish(source, "callId", d2cNullish(message, "toolCallId", d2cNullish(data, "toolCallId", d2cUndefinedValue))))
			}
			settledCalls[d2cOwnerCallKey(owner, callID)] = true
			errorObject := d2cObjectValue(data["error"])
			if d2cStrictEqualString(errorObject["code"], Unknown) {
				unresolvedOutcomes[callID] = true
			} else {
				delete(unresolvedOutcomes, callID)
			}
		}
		if kind == "assistant/message" {
			message := d2cObjectValue(data["message"])
			for _, value := range d2cArray(message["content"]) {
				block, ok := d2cObject(value)
				if !ok || d2cStringValue(block["type"]) != "tool-call" {
					continue
				}
				advertisedCalls[d2cOwnerCallKey(owner, d2cJSString(d2cPropertyOrUndefined(block, "id")))] = true
			}
		}

		_, hasSurfaceOperation := event["surfaceOp"]
		if hasSurfaceOperation {
			if !activeSequences[seq] {
				tally(kind, "dropped", "not in the current DSH surface; retained only in the source audit log", true, 1)
			}
		} else if kind == "turn/start" || kind == "turn/end" {
			tally(kind, "mapped", "", false, 1)
		} else if kind == "step/start" || kind == "step/end" {
			tally(kind, "dropped", "Codex models turns but not steps", true, 1)
		} else if kind != "tool/call" {
			tally(kind, "dropped", "log-only DSH event, not current model history", true, 1)
		}
	}

	push := func(kind string, payload Object, timestamp string) {
		drafts = append(drafts, Object{"type": kind, "payload": payload, "timestamp": timestamp})
	}

	closeTurn := func(atMS float64) {
		if turn == nil {
			return
		}
		startedAt := d2cFloorSeconds(turn.startedAt)
		completedAt := d2cFloorSeconds(atMS)
		duration := atMS - turn.startedAt
		if duration < 0 {
			duration = 0
		}
		push("event_msg", Object{
			"type":         "task_complete",
			"turn_id":      turn.turnID,
			"started_at":   startedAt,
			"completed_at": completedAt,
			"duration_ms":  duration,
		}, d2cISO(atMS))
		turn = nil
	}

	openTurn := func(turnNumber, atMS float64) *d2cTurnState {
		created := &d2cTurnState{turn: turnNumber, turnID: uuid(), startedAt: atMS}
		push("event_msg", Object{
			"type":                 "task_started",
			"turn_id":              created.turnID,
			"started_at":           d2cFloorSeconds(atMS),
			"model_context_window": 272000,
		}, d2cISO(atMS))
		cwd := d2cStringValue(header["cwd"])
		workspaceRoots := []string{}
		if cwd != "" {
			workspaceRoots = []string{cwd}
		}
		push("turn_context", Object{
			"turn_id":         created.turnID,
			"root_turn_id":    created.turnID,
			"cwd":             cwd,
			"workspace_roots": workspaceRoots,
			"model":           model,
			"approval_policy": "never",
			"sandbox_policy":  Object{"type": "disabled"},
		}, d2cISO(atMS))
		return created
	}

	var emitCall func(Object, float64, float64) error
	emitCall = func(data Object, owner, atMS float64) error {
		callID, callIDOK := data["callId"].(string)
		name, nameOK := data["name"].(string)
		if !callIDOK || callID == "" || !nameOK || name == "" {
			return fmt.Errorf("Refusing migration: active DSH tool call is missing its identity")
		}
		arguments := d2cArguments(data)
		key := d2cOwnerCallKey(owner, callID)
		identity := d2cCallIdentity{name: name, arguments: arguments}
		if loggedEvent, ok := loggedCalls[key]; ok {
			loggedData := d2cEventData(loggedEvent)
			loggedName, loggedNameOK := loggedData["name"].(string)
			loggedArguments, loggedArgumentsOK := loggedData["arguments"].(string)
			if !loggedNameOK || !loggedArgumentsOK || loggedName != identity.name || loggedArguments != identity.arguments {
				return fmt.Errorf("Refusing migration: active tool advertisement does not match its recorded call")
			}
		}
		if previous, ok := emittedCalls[key]; ok {
			if previous != identity {
				return fmt.Errorf("Refusing migration: contradictory active tool advertisements")
			}
			return nil
		}
		if turn == nil {
			return fmt.Errorf("Refusing migration: active tool call has no owning turn")
		}
		emittedCalls[key] = identity
		push("response_item", Object{
			"type":      "function_call",
			"id":        "fc_" + callID,
			"name":      name,
			"arguments": arguments,
			"call_id":   callID,
			"internal_chat_message_metadata_passthrough": Object{"turn_id": turn.turnID},
		}, d2cISO(atMS))
		tally("tool/call", "mapped", "", false, 1)
		return nil
	}

	activeCalls := make(map[string]bool)
	activeUnknown := make(map[string]bool)
	exportEvents := append([]Object(nil), surface...)
	for _, event := range surface {
		data := d2cEventData(event)
		message := d2cObjectValue(data["message"])
		seq, _ := d2cSafeEventSeq(event)
		owner := owners[seq]
		if owner == 0 && !d2cOwnerExists(owners, seq) {
			owner = 1
		}
		if d2cEventType(event) == "user/message" {
			pending, pendingErr := d2cPendingOutcomes(data["source"])
			if pendingErr != nil {
				return Conversion{}, pendingErr
			}
			for _, operation := range pending {
				activeUnknown[d2cStringValue(operation["callId"])] = true
			}
		}
		for _, value := range d2cArray(message["content"]) {
			block, ok := d2cObject(value)
			if d2cEventType(event) == "assistant/message" && ok && d2cStringValue(block["type"]) == "tool-call" {
				activeCalls[d2cOwnerCallKey(owner, d2cJSString(d2cPropertyOrUndefined(block, "id")))] = true
			}
		}
		if d2cEventType(event) == "tool/result" {
			callID := d2cJSString(d2cResultCallID(data, message))
			activeCalls[d2cOwnerCallKey(owner, callID)] = true
			errorObject := d2cObjectValue(data["error"])
			if d2cStrictEqualString(errorObject["code"], Unknown) {
				activeUnknown[callID] = true
			}
		}
	}
	for callID := range unresolvedOutcomes {
		if !activeUnknown[callID] {
			return Conversion{}, fmt.Errorf("Refusing migration: an unknown tool outcome has no machine-readable carrier on the current DSH surface")
		}
	}
	for _, key := range loggedCallOrder {
		event := loggedCalls[key]
		if !advertisedCalls[key] && !activeCalls[key] && !settledCalls[key] {
			exportEvents = append(exportEvents, event)
		} else if !activeCalls[key] {
			tally("tool/call", "dropped", "advertisement and result are outside the current DSH surface", true, 1)
		}
	}

	for _, event := range exportEvents {
		kind := d2cEventType(event)
		atMS := d2cNumberOr(event["time"], headerCreatedAt)
		seq, _ := d2cSafeEventSeq(event)
		owner, ownerExists := owners[seq]
		if !ownerExists {
			owner = 1
		}
		if turn != nil && turn.turn != owner {
			closeTurn(atMS)
		}
		if turn == nil {
			turn = openTurn(owner, atMS)
		}
		data := d2cEventData(event)

		switch kind {
		case "user/message":
			contentBlocks, dropped := d2cToCodexContent(data["content"], "input_text")
			if dropped > 0 {
				tally(d2cContentBlocks, "dropped", "DSH content blocks with no Codex equivalent (only text survives)", true, dropped)
			}
			pending, pendingErr := d2cPendingOutcomes(data["source"])
			if pendingErr != nil {
				return Conversion{}, pendingErr
			}
			messageID := d2cPrefixedID("msg_", d2cPropertyOrUndefined(data, "id"))
			itemID := d2cPrefixedID("item_", d2cPropertyOrUndefined(data, "id"))
			messagePayload := Object{
				"type":    "message",
				"id":      messageID,
				"role":    "user",
				"content": contentBlocks,
				"internal_chat_message_metadata_passthrough": Object{"turn_id": turn.turnID},
			}
			if len(pending) > 0 {
				messagePayload["recovery"] = Unknown
				messagePayload["pending_operations"] = pending
			}
			push("response_item", messagePayload, d2cISO(atMS))
			push("event_msg", Object{
				"type":      "item_completed",
				"thread_id": threadID,
				"turn_id":   turn.turnID,
				"item": Object{
					"type":      "UserMessage",
					"id":        itemID,
					"client_id": nil,
					"content":   d2cUserItemContent(contentBlocks),
				},
				"started_at_ms":   atMS,
				"completed_at_ms": atMS,
			}, d2cISO(atMS))
			tally(kind, "mapped", "", false, 1)

		case "assistant/message":
			message := d2cObjectValue(data["message"])
			messageContent := d2cArray(message["content"])
			withoutToolCalls := make([]any, 0, len(messageContent))
			for _, value := range messageContent {
				block, ok := d2cObject(value)
				if ok && d2cStringValue(block["type"]) == "tool-call" {
					continue
				}
				withoutToolCalls = append(withoutToolCalls, value)
			}
			_, dropped := d2cToCodexContent(withoutToolCalls, "output_text")
			if dropped > 0 {
				tally(d2cContentBlocks, "dropped", "DSH content blocks with no Codex equivalent (only text survives)", true, dropped)
			}
			tally(kind, "mapped", "", false, 1)
			if stream, present := data["stream"]; present && stream != nil && len(d2cArray(stream)) > 0 {
				tally("assistant/message.stream", "dropped", "Codex has no streamed-fragment record", true, 1)
			}
			if _, present := data["usage"]; present {
				tally("assistant/message.usage", "dropped", "Codex token_usage_record needs thread-level counters; a partial record risks failing its schema", true, 1)
			}

			part := 0
			emitText := func(blocks []Object) {
				if len(blocks) == 0 {
					return
				}
				part++
				suffix := ""
				if part > 1 {
					suffix = fmt.Sprintf("_part%d", part)
				}
				messageID := d2cPrefixedID("msg_", d2cPropertyOrUndefined(message, "id")) + suffix
				itemID := d2cPrefixedID("item_", d2cPropertyOrUndefined(message, "id")) + suffix
				push("response_item", Object{
					"type":    "message",
					"id":      messageID,
					"role":    "assistant",
					"content": blocks,
					"internal_chat_message_metadata_passthrough": Object{"turn_id": turn.turnID},
				}, d2cISO(atMS))
				push("event_msg", Object{
					"type":      "item_completed",
					"thread_id": threadID,
					"turn_id":   turn.turnID,
					"item": Object{
						"type":      "AgentMessage",
						"id":        itemID,
						"client_id": nil,
						"content":   d2cAgentItemContent(blocks),
					},
					"started_at_ms":   atMS,
					"completed_at_ms": atMS,
				}, d2cISO(atMS))
			}

			group := make([]any, 0)
			for _, value := range messageContent {
				block, ok := d2cObject(value)
				if ok && d2cStringValue(block["type"]) == "tool-call" {
					groupBlocks, _ := d2cToCodexContent(group, "output_text")
					emitText(groupBlocks)
					group = group[:0]
					callData := Object{
						"callId":    d2cPropertyOrUndefined(block, "id"),
						"name":      d2cPropertyOrUndefined(block, "name"),
						"arguments": d2cPropertyOrUndefined(block, "arguments"),
					}
					if err := emitCall(callData, owner, atMS); err != nil {
						return Conversion{}, err
					}
				} else {
					group = append(group, value)
				}
			}
			groupBlocks, _ := d2cToCodexContent(group, "output_text")
			emitText(groupBlocks)

		case "tool/call":
			if err := emitCall(data, owner, atMS); err != nil {
				return Conversion{}, err
			}

		case "tool/result":
			message := d2cObjectValue(data["message"])
			callID, callIDValid := d2cResolvedCallID(data, message)
			if !callIDValid {
				return Conversion{}, fmt.Errorf("Refusing migration: active DSH tool result is missing or contradicts its call identity")
			}
			key := d2cOwnerCallKey(owner, callID)
			if _, emitted := emittedCalls[key]; !emitted {
				loggedEvent, logged := loggedCalls[key]
				if !logged || advertisedCalls[key] {
					return Conversion{}, fmt.Errorf("Refusing migration: active tool result %s has no current advertisement", callID)
				}
				if err := emitCall(d2cEventData(loggedEvent), owner, atMS); err != nil {
					return Conversion{}, err
				}
			}
			errorObject := d2cObjectValue(data["error"])
			unknown := d2cStrictEqualString(errorObject["code"], Unknown)
			payload := Object{
				"type":    "function_call_output",
				"id":      "fco_" + callID,
				"call_id": callID,
				"output":  d2cTextOf(message["content"]),
				"internal_chat_message_metadata_passthrough": Object{"turn_id": turn.turnID},
			}
			if unknown {
				payload["isError"] = true
				payload["recovery"] = Unknown
			} else if message["isError"] == true {
				payload["isError"] = true
			}
			push("response_item", payload, d2cISO(atMS))
			tally(kind, "mapped", "", false, 1)

		default:
			tally(kind, "dropped", "no Codex record corresponds to this DSH event", true, 1)
		}
	}

	if len(events) == 0 {
		closeTurn(headerCreatedAt)
	} else {
		closeTurn(d2cNumberOr(events[len(events)-1]["time"], headerCreatedAt))
	}

	metaPayload := Object{
		"session_id":     threadID,
		"id":             threadID,
		"timestamp":      d2cISO(headerCreatedAt),
		"cwd":            d2cStringValue(header["cwd"]),
		"originator":     "codex_exec",
		"source":         "exec",
		"thread_source":  "user",
		"model_provider": provider,
		"history_mode":   d2cHistoryMode,
	}
	if cwd := d2cStringValue(header["cwd"]); cwd != "" {
		metaPayload["runtime_workspace_roots"] = []string{cwd}
	} else {
		metaPayload["runtime_workspace_roots"] = []string{}
	}
	if cliVersion, ok := options["cliVersion"].(string); ok {
		metaPayload["cli_version"] = cliVersion
	}
	drafts = append([]Object{Object{
		"type":      "session_meta",
		"timestamp": d2cISO(headerCreatedAt),
		"payload":   metaPayload,
	}}, drafts...)
	tally("session_meta", "mapped", "", false, 1)

	return Conversion{Drafts: drafts, Tallies: tallies, Losses: d2cDescribeLosses(tallies)}, nil
}

func d2cTally(tallies map[string]*Tally, kind, outcome, reason string, hasReason bool, count int) {
	if count <= 0 {
		return
	}
	entry := tallies[kind]
	if entry == nil {
		entry = &Tally{}
		tallies[kind] = entry
	}
	if outcome == "mapped" {
		entry.Mapped += count
	} else {
		entry.Dropped += count
		if hasReason {
			entry.Reason = reason
		}
	}
}

func d2cDescribeLosses(tallies map[string]*Tally) []string {
	losses := make([]string, 0)
	for kind, entry := range tallies {
		if entry == nil || entry.Dropped <= 0 {
			continue
		}
		reason := entry.Reason
		if reason == "" {
			reason = "no mapping"
		}
		losses = append(losses, fmt.Sprintf("%s: %d dropped — %s", kind, entry.Dropped, reason))
	}
	sort.Strings(losses)
	return losses
}

func d2cFirstModelSource(events []Object) d2cModelSource {
	for _, event := range events {
		if d2cEventType(event) != "assistant/message" {
			continue
		}
		message := d2cObjectValue(d2cEventData(event)["message"])
		source, ok := d2cObject(message["source"])
		if !ok {
			continue
		}
		provider, hasProvider := source["provider"].(string)
		model, hasModel := source["model"].(string)
		return d2cModelSource{provider: provider, model: model, hasProvider: hasProvider, hasModel: hasModel}
	}
	return d2cModelSource{}
}

func d2cToCodexContent(content any, textType string) ([]Object, int) {
	values := d2cArray(content)
	if values == nil {
		return []Object{}, 0
	}
	blocks := make([]Object, 0, len(values))
	dropped := 0
	for _, value := range values {
		entry, ok := d2cObject(value)
		if !ok {
			dropped++
			continue
		}
		typ := d2cStringValue(entry["type"])
		text, textOK := entry["text"].(string)
		if (typ == "text" || typ == "input_text" || typ == "output_text") && textOK {
			blocks = append(blocks, Object{"type": textType, "text": text})
		} else {
			dropped++
		}
	}
	return blocks, dropped
}

func d2cTextOf(content any) string {
	values := d2cArray(content)
	if values == nil {
		return ""
	}
	var builder strings.Builder
	for _, value := range values {
		entry, ok := d2cObject(value)
		if !ok {
			continue
		}
		if text, ok := entry["text"].(string); ok {
			builder.WriteString(text)
		}
	}
	return builder.String()
}

func d2cUserItemContent(blocks []Object) []Object {
	content := make([]Object, 0, len(blocks))
	for _, block := range blocks {
		content = append(content, Object{"type": "text", "text": d2cStringValue(block["text"]), "text_elements": []Object{}})
	}
	return content
}

func d2cAgentItemContent(blocks []Object) []Object {
	content := make([]Object, 0, len(blocks))
	for _, block := range blocks {
		content = append(content, Object{"type": "Text", "text": d2cStringValue(block["text"])})
	}
	return content
}

func d2cEventData(event Object) Object {
	return d2cObjectValue(event["data"])
}

func d2cObjectValue(value any) Object {
	object, ok := d2cObject(value)
	if !ok {
		return Object{}
	}
	return object
}

func d2cArray(value any) []any {
	if value == nil {
		return nil
	}
	return arr(value)
}

func d2cNumber(value any) (float64, bool) {
	if !isNum(value) {
		return 0, false
	}
	return num(value), true
}

func d2cNumberOr(value any, fallback float64) float64 {
	if number, ok := d2cNumber(value); ok {
		return number
	}
	return fallback
}

func d2cFloorSeconds(value float64) int64 {
	return int64(math.Floor(value / 1000))
}

func d2cISO(value float64) string {
	return iso(value)
}

func d2cOwnerCallKey(owner float64, callID string) string {
	return d2cJSNumber(owner) + "/" + callID
}

func d2cJSNumber(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	if value == 0 {
		return "0"
	}
	return fmt.Sprintf("%g", value)
}

func d2cJSString(value any) string {
	if d2cIsUndefined(value) {
		return "undefined"
	}
	if value == nil {
		return "null"
	}
	switch typed := value.(type) {
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return d2cJSNumber(typed)
	case float32:
		return d2cJSNumber(float64(typed))
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case json.Number:
		return typed.String()
	case map[string]any:
		return "[object Object]"
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			if item == nil || d2cIsUndefined(item) {
				continue
			}
			parts[index] = d2cJSString(item)
		}
		return strings.Join(parts, ",")
	default:
		return fmt.Sprint(value)
	}
}

type d2cUndefinedType struct{}

var d2cUndefinedValue = d2cUndefinedType{}

func d2cIsUndefined(value any) bool {
	_, ok := value.(d2cUndefinedType)
	return ok
}

func d2cPropertyOrUndefined(object Object, key string) any {
	if value, ok := object[key]; ok {
		return value
	}
	return d2cUndefinedValue
}

func d2cNullish(object Object, key string, fallback any) any {
	value, ok := object[key]
	if !ok || value == nil || d2cIsUndefined(value) {
		return fallback
	}
	return value
}

func d2cStrictEqualString(value any, expected string) bool {
	stringValue, ok := value.(string)
	return ok && stringValue == expected
}

func d2cOwnerExists(owners map[int]float64, seq int) bool {
	_, ok := owners[seq]
	return ok
}

func d2cArguments(data Object) string {
	value, present := data["arguments"]
	if present {
		if stringValue, ok := value.(string); ok {
			return stringValue
		}
		if value != nil && !d2cIsUndefined(value) {
			return d2cJSONText(value)
		}
	}
	return d2cJSONText(Object{})
}

func d2cJSONText(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func d2cPrefixedID(prefix string, value any) string {
	if value == nil || d2cIsUndefined(value) {
		return prefix + uuid()
	}
	return prefix + d2cJSString(value)
}

func d2cResultCallID(data, message Object) any {
	callID := d2cNullish(data, "toolCallId", d2cNullish(message, "toolCallId", d2cUndefinedValue))
	source, _ := d2cObject(message["source"])
	return d2cNullish(source, "callId", d2cNullish(message, "toolCallId", callID))
}

func d2cResolvedCallID(data, message Object) (string, bool) {
	callIDRaw := d2cNullish(data, "toolCallId", d2cNullish(message, "toolCallId", d2cUndefinedValue))
	source, _ := d2cObject(message["source"])
	resolvedRaw := d2cNullish(source, "callId", callIDRaw)
	resolved, ok := resolvedRaw.(string)
	if !ok || resolved == "" {
		return "", false
	}
	if !d2cIsUndefined(callIDRaw) && !d2cStrictEqualAny(callIDRaw, resolvedRaw) {
		return "", false
	}
	return resolved, true
}

func d2cStrictEqualAny(left, right any) bool {
	if d2cIsUndefined(left) || d2cIsUndefined(right) {
		return d2cIsUndefined(left) && d2cIsUndefined(right)
	}
	if isNum(left) && isNum(right) {
		return num(left) == num(right)
	}
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	leftString, leftOK := left.(string)
	rightString, rightOK := right.(string)
	return leftOK && rightOK && leftString == rightString
}

func d2cPendingOutcomes(value any) ([]Object, error) {
	metadata, ok := d2cObject(value)
	if !ok {
		return []Object{}, nil
	}
	if !d2cStrictEqualString(metadata["recovery"], Unknown) {
		if d2cStrictEqualString(metadata["kind"], "agent-continue-unknown-outcomes") {
			return nil, fmt.Errorf("Refusing migration: unknown-outcome notice lacks a machine-readable recovery marker; reimport its original source")
		}
		return []Object{}, nil
	}
	operations := d2cArray(d2cNullish(metadata, "pendingOperations", d2cNullish(metadata, "pending_operations", d2cUndefinedValue)))
	if operations == nil || len(operations) == 0 {
		return nil, fmt.Errorf("Refusing migration: unknown-outcome context is missing machine-readable pending operations")
	}
	result := make([]Object, 0, len(operations))
	for _, operation := range operations {
		entry, valid := d2cObject(operation)
		if !valid {
			return nil, fmt.Errorf("Refusing migration: malformed pending operation")
		}
		callID, callIDOK := entry["callId"].(string)
		name, nameOK := entry["name"].(string)
		if !callIDOK || callID == "" || !nameOK || name == "" || !d2cStrictEqualString(entry["state"], "unknown") {
			return nil, fmt.Errorf("Refusing migration: malformed pending operation identity or state")
		}
		result = append(result, Object{"callId": callID, "name": name, "state": "unknown"})
	}
	return result, nil
}

func d2cStartedAt(value any) (float64, error) {
	if number, ok := d2cNumber(value); ok {
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, fmt.Errorf("Refusing migration: startedAt must be an ISO timestamp or epoch milliseconds")
		}
		return number, nil
	}
	if text, ok := value.(string); ok {
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			return 0, fmt.Errorf("Refusing migration: startedAt must be an ISO timestamp or epoch milliseconds")
		}
		return float64(parsed.UnixMilli()), nil
	}
	return 0, fmt.Errorf("Refusing migration: startedAt must be an ISO timestamp or epoch milliseconds")
}

func d2cEventType(event Object) string {
	return d2cStringValue(event["type"])
}
