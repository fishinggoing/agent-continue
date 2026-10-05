package migrate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// c2dTurnState is the state held while a Codex rollout is projected into a
// DSH turn.  openCalls deliberately retains the source sequence of each call:
// DSH recovery uses that sequence when it writes an unknown result.
type c2dTurnState struct {
	turn              int
	turnID            string
	startedAt         float64
	step              int
	openStep          bool
	lastAssistantSeen bool
	openCalls         map[string]int
	callOrder         []string
	usage             Object
}

type c2dUsageResult struct {
	usage  Object
	losses []string
}

// CodexToDsh converts Codex rollout records into DSH session events.
//
// The input and output intentionally use Object rather than a second set of
// public wire types.  Rollout payloads are owned by Codex and are deliberately
// permissive; preserving that property here is part of the migration contract.
func CodexToDsh(records []Object, options Object) (result Conversion, err error) {
	// push reports malformed replacement ranges in the same way the TypeScript
	// implementation throws.  Keep the public Go API error based while allowing
	// the local event builder to stay close to the source state machine.
	defer func() {
		if recovered := recover(); recovered != nil {
			switch value := recovered.(type) {
			case error:
				err = value
				result = Conversion{}
			default:
				panic(recovered)
			}
		}
	}()

	meta := Object(nil)
	for _, record := range records {
		if str(record["type"]) == "session_meta" {
			meta = obj(record["payload"])
			break
		}
	}
	if str(meta["cwd"]) == "" || !isAbsolute(str(meta["cwd"])) {
		return Conversion{}, errors.New("Refusing migration: Codex source cwd must be an absolute path; --cwd remapping does not override source eligibility")
	}
	sourceCwd := str(meta["cwd"])
	targetCwd := str(options["cwd"])
	if targetCwd == "" || !isAbsolute(targetCwd) {
		return Conversion{}, errors.New("Refusing migration: DSH target cwd must be an absolute path for ACP visibility")
	}

	tallies := map[string]*Tally{}
	tally := func(kind string, outcome string, reason string, count int) {
		entry := tallies[kind]
		if entry == nil {
			entry = &Tally{}
		}
		if outcome == "mapped" {
			entry.Mapped += count
		} else {
			entry.Dropped += count
			if reason != "" {
				entry.Reason = reason
			}
		}
		tallies[kind] = entry
	}

	provider := "unknown"
	if value, ok := meta["model_provider"].(string); ok {
		provider = value
	}
	createdAt := c2dCreatedAt(records, options)

	events := []Object{}
	surface := []int{}
	var turn *c2dTurnState
	turnCount := 0
	fallbackModel := "unknown"

	// Once an unresolved call is the final source tail, DSH recovery must close
	// the step and turn.  No later source record can be represented after that
	// point.
	stopped := false
	stoppedAtIndex := -1
	currentIndex := -1
	startsAtOrAfter := make([]int, len(records)+1)
	for index := len(records) - 1; index >= 0; index-- {
		isStart := str(records[index]["type"]) == "event_msg" &&
			str(obj(records[index]["payload"])["type"]) == "task_started"
		startsAtOrAfter[index] = startsAtOrAfter[index+1]
		if isStart {
			startsAtOrAfter[index]++
		}
	}

	push := func(eventType string, data Object, surfaceOp any) Object {
		event := Object{
			"type": str(eventType),
			"seq":  len(events),
			"time": c2dEventTime(records, len(events), createdAt),
			"data": data,
		}
		if surfaceOp != nil {
			event["surfaceOp"] = surfaceOp
		}
		events = append(events, event)
		switch operation := surfaceOp.(type) {
		case string:
			if operation == "append" {
				surface = append(surface, len(events)-1)
			}
		case Object:
			first := -1
			last := -1
			start := int(num(operation["startSeq"]))
			end := int(num(operation["endSeq"]))
			for index, sequence := range surface {
				if sequence == start {
					first = index
				}
				if sequence == end {
					last = index
				}
			}
			if first < 0 || last < first {
				panic(errors.New("Invalid compaction replacement range"))
			}
			surface = append(append(append([]int{}, surface[:first]...), len(events)-1), surface[last+1:]...)
		}
		return event
	}

	closeStep := func() {
		if turn == nil || !turn.openStep || len(turn.openCalls) > 0 {
			return
		}
		push("step/end", Object{"turn": turn.turn, "step": turn.step}, nil)
		turn.openStep = false
	}

	var closeTurn func(Object)
	closeTurn = func(reason Object) {
		if turn == nil {
			return
		}
		if len(turn.openCalls) > 0 {
			if currentIndex >= 0 && currentIndex < len(startsAtOrAfter) && startsAtOrAfter[currentIndex] > 0 {
				// A later turn follows.  Resolve each unresolved call with the
				// same explicit unknown outcome DSH recovery writes.
				for _, callID := range turn.callOrder {
					callSeq, ok := turn.openCalls[callID]
					if !ok {
						continue
					}
					unknownResult := push("tool/result", Object{
						"turn": turn.turn,
						"step": turn.step,
						"message": Object{
							"id":         fmt.Sprintf("interrupted-tool-result-%s-%d", callID, len(events)),
							"role":       "tool",
							"toolCallId": callID,
							"isError":    true,
							"source":     Object{"kind": "tool", "callId": callID},
							"content":    []any{Object{"type": "text", "text": UnknownText}},
						},
						"error": Object{"name": "ToolOutcomeUnknownError", "code": Unknown},
					}, "append")
					unknownResult["sourceEventSeqs"] = []int{callSeq}
					if unknownResult != nil {
						tally("tool/result.synthesized-unknown", "mapped", "", 1)
					}
					delete(turn.openCalls, callID)
					_ = unknownResult
				}
				turn.callOrder = nil
				turn.openCalls = map[string]int{}
			} else {
				// The unresolved call is the end of the rollout.  Leave its
				// step and turn open for DSH repair.
				stopped = true
				turn = nil
				return
			}
		}
		closeStep()
		push("turn/end", Object{"turn": turn.turn, "reason": reason}, nil)
		turn = nil
	}

	openTurn := func(turnID string, startedAt float64) bool {
		closeTurn(Object{"kind": "interrupted"})
		if stopped {
			return false
		}
		turnCount++
		turn = &c2dTurnState{
			turn:      turnCount,
			turnID:    turnID,
			startedAt: startedAt,
			openCalls: map[string]int{},
			callOrder: []string{},
		}
		push("turn/start", Object{"turn": turn.turn}, nil)
		return true
	}

	ensureTurn := func(atMs float64) bool {
		if turn != nil {
			return true
		}
		return openTurn(fmt.Sprintf("turn-%d", turnCount+1), atMs)
	}

	beginStep := func() *c2dTurnState {
		current := turn
		if current == nil {
			panic(errors.New("cannot begin a step without an open turn"))
		}
		if !current.openStep || (current.lastAssistantSeen && len(current.openCalls) == 0) {
			closeStep()
			current.step++
			current.lastAssistantSeen = false
			push("step/start", Object{"turn": current.turn, "step": current.step}, nil)
			current.openStep = true
			if len(surface) == 0 {
				push("system/message", Object{
					"turn": current.turn,
					"step": current.step,
					"message": Object{
						"id":      fmt.Sprintf("empty-system-head-%s", str(options["sessionId"])),
						"role":    "system",
						"content": []any{},
						"source":  Object{"kind": "system-prompt", "migration": "agent-continue-empty-system-head"},
					},
				}, "append")
				tally("system/message.empty-head", "mapped", "", 1)
			}
		}
		return current
	}

	for index := 0; index < len(records); index++ {
		record := records[index]
		currentIndex = index
		if stopped {
			if str(record["type"]) == "compacted" {
				return Conversion{}, errors.New("Refusing compaction migration after an unresolved source tail")
			}
			if stoppedAtIndex < 0 {
				stoppedAtIndex = index
			}
			continue
		}

		kind := c2dKindOf(record)
		payload := obj(record["payload"])
		switch kind {
		case "compacted":
			snapshot, snapshotErr := c2dCompactionSnapshot(payload)
			if snapshotErr != nil {
				return Conversion{}, snapshotErr
			}
			unknown := map[string]int{}
			unknownOrder := []string{}
			calls := map[string]Object{}
			pending := map[string]Object{}
			pendingOrder := []string{}
			for _, previous := range events {
				previousData := obj(previous["data"])
				previousType := str(previous["type"])
				if previousType == "tool/call" {
					calls[jsString(previousData["callId"])] = previousData
				}
				if previousType == "user/message" {
					operations, pendingErr := PendingOutcomes(previousData["source"])
					if pendingErr != nil {
						return Conversion{}, pendingErr
					}
					for _, operation := range operations {
						callID := str(operation["callId"])
						if _, exists := pending[callID]; !exists {
							pendingOrder = append(pendingOrder, callID)
						}
						pending[callID] = operation
					}
				}
				if previousType != "tool/result" {
					continue
				}
				callID := jsString(obj(previousData["message"])["toolCallId"])
				if str(obj(previousData["error"])["code"]) == Unknown {
					if _, exists := unknown[callID]; !exists {
						unknownOrder = append(unknownOrder, callID)
					}
					unknown[callID] = int(num(previous["seq"]))
					name := "unknown"
					if call, exists := calls[callID]; exists && call["name"] != nil {
						name = jsString(call["name"])
					}
					if _, exists := pending[callID]; !exists {
						pendingOrder = append(pendingOrder, callID)
					}
					pending[callID] = Object{"callId": callID, "name": name, "state": "unknown"}
				} else {
					delete(unknown, callID)
					delete(pending, callID)
				}
			}

			retained := make([]Object, 0, len(snapshot)+len(unknownOrder)*2)
			retained = append(retained, snapshot...)
			for _, callID := range unknownOrder {
				resultSeq, exists := unknown[callID]
				if !exists {
					continue
				}
				alreadyRetained := false
				for _, item := range snapshot {
					itemType := str(item["type"])
					if (itemType == "function_call_output" || itemType == "custom_tool_call_output") && str(item["call_id"]) == callID {
						alreadyRetained = true
						break
					}
				}
				if alreadyRetained {
					continue
				}
				call, exists := calls[callID]
				if !exists {
					return Conversion{}, errors.New("Refusing compaction migration: unknown outcome has no recorded tool identity")
				}
				if resultSeq < 0 || resultSeq >= len(events) {
					return Conversion{}, errors.New("Refusing compaction migration: unknown outcome has no recorded tool identity")
				}
				resultData := obj(events[resultSeq]["data"])
				message := obj(resultData["message"])
				output := Object{
					"type":     "function_call_output",
					"id":       message["id"],
					"call_id":  callID,
					"output":   c2dContentText(message["content"]),
					"recovery": Unknown,
					"isError":  true,
				}
				retained = append(retained,
					Object{"type": "function_call", "call_id": callID, "name": call["name"], "arguments": call["arguments"]},
					output,
				)
			}
			if turn != nil && len(turn.openCalls) > 0 {
				return Conversion{}, errors.New("Refusing compaction migration over unresolved source tool calls; their outcome cannot be inferred from a summary")
			}
			closeTurn(Object{"kind": "interrupted"})
			ordinal := c2dStringOr(record["ordinal"], "undefined")
			if !openTurn("compaction-"+ordinal, c2dParsedOr(record["timestamp"], createdAt)) {
				return Conversion{}, errors.New("Refusing compaction migration after an unresolved source tail")
			}

			nestedRecords := make([]Object, 0, len(retained)+1)
			if len(records) == 0 {
				return Conversion{}, errors.New("Refusing compaction migration without a session metadata record")
			}
			first := c2dClone(records[0])
			first["type"] = "session_meta"
			first["payload"] = meta
			nestedRecords = append(nestedRecords, first)
			for offset, retainedPayload := range retained {
				nestedPayload := c2dClone(retainedPayload)
				if str(nestedPayload["type"]) == "function_call_output" || str(nestedPayload["type"]) == "custom_tool_call_output" {
					if _, isUnknown := unknown[str(nestedPayload["call_id"])]; isUnknown {
						nestedPayload["recovery"] = Unknown
						nestedPayload["isError"] = true
					}
				}
				nestedRecords = append(nestedRecords, Object{
					"type":      "response_item",
					"ordinal":   offset + 1,
					"timestamp": str(record["timestamp"]),
					"payload":   nestedPayload,
				})
			}
			nestedOptions := c2dClone(options)
			nestedOptions["cwd"] = sourceCwd
			context, nestedErr := CodexToDsh(nestedRecords, nestedOptions)
			if nestedErr != nil {
				return Conversion{}, nestedErr
			}

			current := turn
			shadowed := []int{}
			for _, sequence := range surface {
				if str(events[sequence]["type"]) != "system/message" {
					shadowed = append(shadowed, sequence)
				}
			}
			sequences := map[int]int{}
			firstSurface := true
			for _, child := range context.Events {
				childType := str(child["type"])
				if childType == "turn/start" || childType == "turn/end" {
					continue
				}
				if childType == "system/message" && len(surface) > 0 {
					continue
				}
				data := c2dClone(obj(child["data"]))
				if _, exists := data["turn"]; exists {
					data["turn"] = current.turn
				}
				var operation any
				if value, exists := child["surfaceOp"]; exists {
					operation = value
				}
				if childType == "user/message" {
					source := c2dClone(obj(data["source"]))
					source["kind"] = "agent-continue-codex-compaction"
					source["sourceOrdinal"] = record["ordinal"]
					if windowID, ok := record["payload"].(Object); ok {
						if value, isString := windowID["window_id"].(string); isString {
							source["sourceWindowId"] = value
						}
					}
					data["source"] = source
				}
				if operation != nil && childType != "system/message" && firstSurface {
					if childType != "user/message" {
						return Conversion{}, errors.New("Compaction context must start with a user message")
					}
					if len(shadowed) > 0 {
						operation = Object{"op": "replace", "startSeq": shadowed[0], "endSeq": shadowed[len(shadowed)-1]}
					}
					firstSurface = false
				}
				appended := push(childType, data, operation)
				sequences[int(num(child["seq"]))] = int(num(appended["seq"]))
				if operation != nil && operation != "append" {
					appended["sourceEventSeqs"] = append([]int{}, shadowed...)
				} else if sourceSeqs, exists := child["sourceEventSeqs"]; exists {
					mapped := []int{}
					for _, sourceSeq := range c2dArray(sourceSeqs) {
						mapped = append(mapped, sequences[int(num(sourceSeq))])
					}
					appended["sourceEventSeqs"] = mapped
				}
				if childType == "tool/result" {
					originalSeq, exists := unknown[jsString(obj(data["message"])["toolCallId"])]
					if exists {
						appended["sourceEventSeqs"] = []int{originalSeq}
					}
				}
				if value, exists := data["step"]; exists && isNum(value) {
					current.step = int(num(value))
				}
				switch childType {
				case "step/start":
					current.openStep = true
				case "step/end":
					current.openStep = false
				case "assistant/message":
					current.lastAssistantSeen = true
				case "tool/call":
					c2dRememberCall(current, jsString(data["callId"]), int(num(appended["seq"])))
				case "tool/result":
					c2dForgetCall(current, jsString(obj(data["message"])["toolCallId"]))
				}
			}
			if len(pending) > 0 {
				beginStep()
				pendingValues := []any{}
				for _, callID := range pendingOrder {
					if value, exists := pending[callID]; exists {
						pendingValues = append(pendingValues, value)
					}
				}
				notice := push("user/message", Object{
					"id":   fmt.Sprintf("compaction-unknown-%s", ordinal),
					"role": "user",
					"source": Object{
						"kind":              "agent-continue-unknown-outcomes",
						"sourceOrdinal":     record["ordinal"],
						"recovery":          Unknown,
						"pendingOperations": pendingValues,
					},
					"content": []any{Object{"type": "text", "text": fmt.Sprintf("Recorded tool outcomes remain %s after compaction: %s. Check the actual workspace or external state before retrying; compaction does not prove success or failure. %s", Unknown, strings.Join(pendingOrder, ", "), UnknownText)}},
				}, "append")
				unknownSequences := []int{}
				for _, callID := range unknownOrder {
					if sequence, exists := unknown[callID]; exists {
						unknownSequences = append(unknownSequences, sequence)
					}
				}
				notice["sourceEventSeqs"] = unknownSequences
				tally("compacted.unknown-outcomes", "mapped", "", 1)
			}
			for childKind, counts := range context.Tallies {
				if childKind == "session_meta" || counts == nil {
					continue
				}
				if counts.Mapped > 0 {
					tally("compacted.context/"+childKind, "mapped", "", counts.Mapped)
				}
				if counts.Dropped > 0 {
					tally("compacted.context/"+childKind, "dropped", counts.Reason, counts.Dropped)
				}
			}
			tally(kind, "mapped", "", 1)
			for key := range payload {
				if key != "message" && key != "replacement_history" {
					tally("compacted.metadata", "dropped", "Codex window lineage, retained-context annotations and resume/token bookkeeping are not DSH native state", 1)
					break
				}
			}

		case "session_meta":
			tally(kind, "mapped", "", 1)

		case "event_msg/turn_aborted":
			tally(kind, "dropped", "Codex aborts a turn without a DSH equivalent reason payload", 1)

		case "event_msg/task_started":
			turnID := c2dStringOr(payload["turn_id"], fmt.Sprintf("turn-%d", turnCount+1))
			startedAt := float64(time.Now().UnixMilli())
			if isNum(payload["started_at"]) {
				startedAt = num(payload["started_at"]) * 1000
			}
			if !openTurn(turnID, startedAt) {
				tally(kind, "dropped", "no turn may open after a tail was left open for DSH recovery", 1)
			} else {
				tally(kind, "mapped", "", 1)
			}

		case "event_msg/task_complete":
			closeTurn(Object{"kind": "completed"})
			tally(kind, "mapped", "", 1)

		case "event_msg/token_count":
			tally(kind, "dropped", "per-request token counters and rate limits have no DSH event", 1)

		case "turn_context":
			if model, ok := payload["model"].(string); ok {
				fallbackModel = model
			}
			if turn == nil {
				turnID := c2dStringOr(payload["turn_id"], fmt.Sprintf("turn-%d", turnCount+1))
				if !openTurn(turnID, c2dParsedOr(record["timestamp"], float64(time.Now().UnixMilli()))) {
					tally(kind, "dropped", "no turn may open after a tail was left open for DSH recovery", 1)
					break
				}
			}
			tally(kind, "mapped", "", 1)

		case "token_usage_record":
			usageValue := c2dNullish(payload["turn_token_usage"], payload["usage"])
			if turn == nil {
				tally(kind, "dropped", "usage record had no open turn", 1)
				break
			}
			converted := c2dConvertUsage(usageValue)
			turn.usage = converted.usage
			if converted.usage == nil {
				tally(kind, "dropped", strings.Join(converted.losses, "; "), 1)
			} else {
				tally(kind, "mapped", "", 1)
				if len(converted.losses) > 0 {
					tally("token_usage_record.fields", "dropped", strings.Join(converted.losses, "; "), 1)
				}
			}

		case "response_item/reasoning":
			tally(kind, "dropped", "Codex reasoning text is encrypted (encrypted_content); DSH has no standalone reasoning event", 1)

		case "response_item/message":
			role := c2dStringOr(payload["role"], "")
			if role == "developer" || role == "system" {
				tally(kind, "dropped", fmt.Sprintf("role=%s is Codex-injected harness context, not conversation", role), 1)
				break
			}
			contentValue := payload["content"]
			text := c2dContentText(contentValue)
			if text == "" && !c2dIsArray(contentValue) {
				tally(kind, "dropped", "message carried no content blocks", 1)
				break
			}
			if !ensureTurn(c2dParsedOr(record["timestamp"], float64(time.Now().UnixMilli()))) {
				tally(kind, "dropped", "no turn may open after a tail was left open for DSH recovery", 1)
				break
			}
			if role == "assistant" {
				current := beginStep()
				content, dropped := c2dToDshContent(contentValue)
				if dropped > 0 {
					tally("message.content-blocks", "dropped", "Codex content blocks with no DSH equivalent (only text survives)", dropped)
				}
				message := Object{
					"id":      c2dStringOr(payload["id"], fmt.Sprintf("msg-%d", len(events))),
					"role":    "assistant",
					"content": content,
					"source":  Object{"kind": "model", "provider": provider, "model": c2dModelOf(record, fallbackModel)},
				}
				data := Object{"turn": current.turn, "step": current.step, "message": message}
				if current.usage != nil {
					data["usage"] = current.usage
				}
				data["stream"] = []any{}
				push("assistant/message", data, "append")
				current.lastAssistantSeen = true
				current.usage = nil
			} else {
				beginStep()
				content, dropped := c2dToDshContent(contentValue)
				if dropped > 0 {
					tally("message.content-blocks", "dropped", "Codex content blocks with no DSH equivalent (only text survives)", dropped)
				}
				source := Object{"kind": "user"}
				if payload["recovery"] == Unknown {
					pending, pendingErr := PendingOutcomes(payload)
					if pendingErr != nil {
						return Conversion{}, pendingErr
					}
					operations := make([]any, len(pending))
					for index := range pending {
						operations[index] = pending[index]
					}
					source["recovery"] = Unknown
					source["pendingOperations"] = operations
				}
				push("user/message", Object{
					"id":      c2dStringOr(payload["id"], fmt.Sprintf("msg-%d", len(events))),
					"role":    "user",
					"content": content,
					"source":  source,
				}, "append")
			}
			tally(kind, "mapped", "", 1)

		case "response_item/function_call", "response_item/custom_tool_call":
			if !ensureTurn(c2dParsedOr(record["timestamp"], float64(time.Now().UnixMilli()))) {
				tally(kind, "dropped", "no turn may open after a tail was left open for DSH recovery", 1)
				break
			}
			current := beginStep()
			type c2dCall struct {
				callID string
				name   string
				args   string
				kind   string
			}
			run := []c2dCall{}
			probe := index
			for probe < len(records) {
				candidate := records[probe]
				candidateKind := c2dKindOf(candidate)
				if candidateKind != "response_item/function_call" && candidateKind != "response_item/custom_tool_call" {
					break
				}
				candidatePayload := obj(candidate["payload"])
				callID := c2dStringOr(candidatePayload["call_id"], fmt.Sprintf("call-%d", probe))
				name := c2dStringOr(candidatePayload["name"], "unknown")
				args := ""
				if candidateKind == "response_item/function_call" {
					args = c2dStringOr(candidatePayload["arguments"], "")
				} else {
					input := c2dNullish(candidatePayload["input"], "")
					args = c2dJSONStringify(input)
				}
				run = append(run, c2dCall{callID: callID, name: name, args: args, kind: candidateKind})
				probe++
			}
			advertised := []any{}
			for _, call := range run {
				advertised = append(advertised, Object{"type": "tool-call", "id": call.callID, "name": call.name, "arguments": call.args})
			}
			push("assistant/message", Object{
				"turn": current.turn,
				"step": current.step,
				"message": Object{
					"id":      fmt.Sprintf("msg-advertise-%d-%d-%d", current.turn, current.step, len(run)),
					"role":    "assistant",
					"content": advertised,
					"source":  Object{"kind": "model", "provider": provider, "model": fallbackModel},
				},
				"stream": []any{},
			}, "append")
			for _, call := range run {
				callEvent := push("tool/call", Object{"turn": current.turn, "step": current.step, "callId": call.callID, "name": call.name, "arguments": call.args}, nil)
				c2dRememberCall(current, call.callID, int(num(callEvent["seq"])))
				tally(call.kind, "mapped", "", 1)
			}
			index = probe - 1

		case "response_item/function_call_output", "response_item/custom_tool_call_output":
			if turn == nil {
				tally(kind, "dropped", "tool result appeared before any turn opened", 1)
				break
			}
			current := beginStep()
			callID := c2dStringOr(payload["call_id"], "")
			recovery := payload["recovery"] == Unknown
			message := Object{
				"id":         c2dStringOr(payload["id"], fmt.Sprintf("tool-%d", len(events))),
				"role":       "tool",
				"source":     Object{"kind": "tool", "callId": callID},
				"toolCallId": callID,
				"content":    []any{Object{"type": "text", "text": c2dToolOutputText(payload)}},
			}
			if value, ok := payload["isError"].(bool); ok {
				message["isError"] = value
				if recovery {
					message["isError"] = true
				}
			} else if recovery {
				message["isError"] = true
			} else {
				tally("tool/result.error-status", "dropped", "Codex tool output carries no error flag, so DSH isError is left unset rather than asserted false", 1)
			}
			data := Object{"turn": current.turn, "step": current.step, "message": message}
			if recovery {
				data["error"] = Object{"name": "ToolOutcomeUnknownError", "code": Unknown}
			}
			push("tool/result", data, "append")
			c2dForgetCall(current, callID)
			tally(kind, "mapped", "", 1)

		default:
			tally(kind, "dropped", "no DSH event corresponds to this Codex record", 1)
		}
	}
	closeTurn(Object{"kind": "interrupted"})

	if targetCwd != sourceCwd {
		if len(surface) == 0 {
			ensureTurn(createdAt)
			beginStep()
		}
		push("user/message", Object{
			"id":   "workspace-remap-" + str(options["sessionId"]),
			"role": "user",
			"source": Object{
				"kind":    "agent-continue-workspace-remap",
				"fromCwd": sourceCwd,
				"toCwd":   targetCwd,
			},
			"content": []any{Object{"type": "text", "text": fmt.Sprintf("This imported conversation has moved workspaces. Current workspace: %s. Previous workspace: %s. Earlier absolute paths and tool working directories are historical references, not the current execution location. Continue only in the current workspace; do not read, write or run commands in the previous workspace. Resolve project-relative paths against the current workspace and inspect its actual files before continuing. Migration does not copy project files.", jsonText(targetCwd), jsonText(sourceCwd))}},
		}, "append")
		tally("workspace.remapped-context", "mapped", "", 1)
		closeTurn(Object{"kind": "interrupted"})
	}

	if stoppedAtIndex >= 0 {
		tally("records-after-open-tail", "dropped", fmt.Sprintf("import stopped at record %d: an earlier turn was left open for DSH recovery, and DSH rejects opening a turn while one is open", stoppedAtIndex), len(records)-stoppedAtIndex)
	}

	header := Object{
		"type":            "session",
		"version":         4,
		"id":              str(options["sessionId"]),
		"createdAt":       createdAt,
		"cwd":             targetCwd,
		"isSeeded":        false,
		"delegationDepth": 0,
	}
	return Conversion{Header: header, Events: events, Tallies: tallies, Losses: c2dDescribeLosses(tallies)}, nil
}

func c2dCreatedAt(records []Object, options Object) float64 {
	if value, exists := options["createdAt"]; exists && value != nil {
		return num(value)
	}
	if len(records) > 0 {
		if parsed := parseTime(str(records[0]["timestamp"])); parsed != 0 {
			return parsed
		}
	}
	return float64(time.Now().UnixMilli())
}

func c2dEventTime(records []Object, index int, fallback float64) float64 {
	if len(records) == 0 {
		return fallback
	}
	if index >= len(records) {
		index = len(records) - 1
	}
	if index < 0 {
		return fallback
	}
	if parsed := parseTime(str(records[index]["timestamp"])); parsed != 0 {
		return parsed
	}
	return fallback
}

func c2dParsedOr(value any, fallback float64) float64 {
	if parsed := parseTime(str(value)); parsed != 0 {
		return parsed
	}
	return fallback
}

func c2dStringOr(value any, fallback string) string {
	if value == nil {
		return fallback
	}
	return jsString(value)
}

func c2dNullish(first any, second any) any {
	if first != nil {
		return first
	}
	return second
}

func c2dArray(value any) []any {
	if values := arr(value); values != nil {
		return values
	}
	return []any{}
}

func c2dIsArray(value any) bool {
	switch value.(type) {
	case []any, []Object:
		return true
	default:
		return false
	}
}

func c2dKindOf(record Object) string {
	recordType := str(record["type"])
	payloadType, isString := obj(record["payload"])["type"].(string)
	if !isString || payloadType == recordType {
		return recordType
	}
	return recordType + "/" + payloadType
}

func c2dModelOf(record Object, fallback string) string {
	passthrough := obj(obj(record["payload"])["internal_chat_message_metadata_passthrough"])
	if model, ok := passthrough["model"].(string); ok {
		return model
	}
	return fallback
}

func c2dContentText(content any) string {
	if !c2dIsArray(content) {
		return ""
	}
	parts := []string{}
	for _, block := range c2dArray(content) {
		entry := obj(block)
		if text, ok := entry["text"].(string); ok {
			parts = append(parts, text)
		} else {
			parts = append(parts, "")
		}
	}
	return strings.Join(parts, "")
}

func c2dToolOutputText(payload Object) string {
	output := payload["output"]
	if text, ok := output.(string); ok {
		return text
	}
	if c2dIsArray(output) {
		return c2dContentText(output)
	}
	return ""
}

// c2dJSONStringify is used for custom_tool_call input, whose JSON text is part
// of the tool-call identity DSH validates.  A json.RawMessage is retained by
// the Codex source reader so this path can preserve object insertion order.
// The ordered parser below then applies JSON.stringify's normalization to
// strings, numbers, arrays and integer-index object keys.
func c2dJSONStringify(value any) string {
	if raw, ok := value.(json.RawMessage); ok {
		if node, err := c2dParseJSONNode(raw); err == nil {
			return c2dJSONNodeString(node)
		}
		return jsonText(value)
	}
	if raw, ok := value.(*json.RawMessage); ok && raw != nil {
		if node, err := c2dParseJSONNode(*raw); err == nil {
			return c2dJSONNodeString(node)
		}
		return jsonText(*raw)
	}
	return c2dJSONStringifyUnordered(value)
}

type c2dJSONPair struct {
	key   string
	value *c2dJSONNode
}

type c2dJSONNode struct {
	kind   byte
	text   string
	number float64
	bool   bool
	object []c2dJSONPair
	array  []*c2dJSONNode
}

func c2dParseJSONNode(raw []byte) (*c2dJSONNode, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	node, err := c2dParseJSONDecoder(decoder)
	if err != nil {
		return nil, err
	}
	if extra, extraErr := decoder.Token(); extraErr == nil || extra != nil {
		return nil, errors.New("JSON value has trailing data")
	}
	return node, nil
}

func c2dParseJSONDecoder(decoder *json.Decoder) (*c2dJSONNode, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			node := &c2dJSONNode{kind: '{', object: []c2dJSONPair{}}
			positions := make(map[string]int)
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, keyErr
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("JSON object key is not a string")
				}
				child, childErr := c2dParseJSONDecoder(decoder)
				if childErr != nil {
					return nil, childErr
				}
				if index, duplicate := positions[key]; duplicate {
					node.object[index].value = child
				} else {
					positions[key] = len(node.object)
					node.object = append(node.object, c2dJSONPair{key: key, value: child})
				}
			}
			closing, closeErr := decoder.Token()
			if closeErr != nil || closing != json.Delim('}') {
				if closeErr != nil {
					return nil, closeErr
				}
				return nil, errors.New("JSON object is not closed")
			}
			return node, nil
		case '[':
			node := &c2dJSONNode{kind: '[', array: []*c2dJSONNode{}}
			for decoder.More() {
				child, childErr := c2dParseJSONDecoder(decoder)
				if childErr != nil {
					return nil, childErr
				}
				node.array = append(node.array, child)
			}
			closing, closeErr := decoder.Token()
			if closeErr != nil || closing != json.Delim(']') {
				if closeErr != nil {
					return nil, closeErr
				}
				return nil, errors.New("JSON array is not closed")
			}
			return node, nil
		default:
			return nil, errors.New("unexpected JSON delimiter")
		}
	case string:
		return &c2dJSONNode{kind: 's', text: value}, nil
	case json.Number:
		number, numberErr := strconv.ParseFloat(string(value), 64)
		if numberErr != nil && !errors.Is(numberErr, strconv.ErrRange) {
			return nil, numberErr
		}
		return &c2dJSONNode{kind: 'n', number: number}, nil
	case bool:
		return &c2dJSONNode{kind: 'b', bool: value}, nil
	case nil:
		return &c2dJSONNode{kind: '0'}, nil
	default:
		return nil, fmt.Errorf("unsupported JSON token %T", token)
	}
}

func c2dJSONNodeString(node *c2dJSONNode) string {
	var builder strings.Builder
	c2dWriteJSONNode(&builder, node)
	return builder.String()
}

// Write into one buffer so a deeply nested value does not copy its entire
// subtree into a new string at each ancestor.
func c2dWriteJSONNode(builder *strings.Builder, node *c2dJSONNode) {
	if node == nil {
		builder.WriteString("null")
		return
	}
	switch node.kind {
	case '{':
		numeric := []c2dJSONPair{}
		other := []c2dJSONPair{}
		for _, pair := range node.object {
			if c2dArrayIndex(pair.key) {
				numeric = append(numeric, pair)
			} else {
				other = append(other, pair)
			}
		}
		sort.SliceStable(numeric, func(left, right int) bool {
			leftValue, _ := strconv.ParseUint(numeric[left].key, 10, 32)
			rightValue, _ := strconv.ParseUint(numeric[right].key, 10, 32)
			return leftValue < rightValue
		})
		builder.WriteByte('{')
		first := true
		for _, pairs := range [][]c2dJSONPair{numeric, other} {
			for _, pair := range pairs {
				if !first {
					builder.WriteByte(',')
				}
				first = false
				builder.WriteString(c2dJSONString(pair.key))
				builder.WriteByte(':')
				c2dWriteJSONNode(builder, pair.value)
			}
		}
		builder.WriteByte('}')
	case '[':
		builder.WriteByte('[')
		for index, child := range node.array {
			if index > 0 {
				builder.WriteByte(',')
			}
			c2dWriteJSONNode(builder, child)
		}
		builder.WriteByte(']')
	case 's':
		builder.WriteString(c2dJSONString(node.text))
	case 'n':
		builder.WriteString(c2dJSONNumber(node.number))
	case 'b':
		if node.bool {
			builder.WriteString("true")
		} else {
			builder.WriteString("false")
		}
	default:
		builder.WriteString("null")
	}
}

func c2dArrayIndex(key string) bool {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return false
	}
	value, err := strconv.ParseUint(key, 10, 32)
	return err == nil && value < 1<<32-1 && strconv.FormatUint(value, 10) == key
}

func c2dJSONNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "null"
	}
	if value == 0 {
		return "0"
	}
	if math.Abs(value) >= 1e-6 && math.Abs(value) < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	formatted := strconv.FormatFloat(value, 'e', -1, 64)
	parts := strings.SplitN(formatted, "e", 2)
	exponent, err := strconv.Atoi(parts[1])
	if err != nil {
		return formatted
	}
	exponentText := strconv.Itoa(exponent)
	if exponent >= 0 {
		exponentText = "+" + exponentText
	}
	return parts[0] + "e" + exponentText
}

func c2dJSONString(value string) string {
	var builder strings.Builder
	builder.WriteByte('"')
	for index := 0; index < len(value); index++ {
		character := value[index]
		switch character {
		case '"', '\\':
			builder.WriteByte('\\')
			builder.WriteByte(character)
		case '\b':
			builder.WriteString("\\b")
		case '\f':
			builder.WriteString("\\f")
		case '\n':
			builder.WriteString("\\n")
		case '\r':
			builder.WriteString("\\r")
		case '\t':
			builder.WriteString("\\t")
		default:
			if character < 0x20 {
				builder.WriteString(fmt.Sprintf("\\u%04x", character))
			} else {
				builder.WriteByte(character)
			}
		}
	}
	builder.WriteByte('"')
	return builder.String()
}

func c2dJSONStringifyUnordered(value any) string {
	if object, ok := value.(Object); ok && object != nil {
		pairs := make([]c2dJSONPair, 0, len(object))
		keys := make([]string, 0, len(object))
		for key := range object {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			pairs = append(pairs, c2dJSONPair{key: key, value: c2dJSONNodeFromGo(object[key])})
		}
		return c2dJSONNodeString(&c2dJSONNode{kind: '{', object: pairs})
	}
	if values, ok := value.([]any); ok {
		parts := make([]string, len(values))
		for index, child := range values {
			parts[index] = c2dJSONStringifyUnordered(child)
		}
		return "[" + strings.Join(parts, ",") + "]"
	}
	if values, ok := value.([]Object); ok {
		parts := make([]string, len(values))
		for index, child := range values {
			parts[index] = c2dJSONStringifyUnordered(child)
		}
		return "[" + strings.Join(parts, ",") + "]"
	}
	return jsonText(value)
}

func c2dJSONNodeFromGo(value any) *c2dJSONNode {
	if raw, ok := value.(json.RawMessage); ok {
		if node, err := c2dParseJSONNode(raw); err == nil {
			return node
		}
	}
	if object, ok := value.(Object); ok && object != nil {
		pairs := make([]c2dJSONPair, 0, len(object))
		keys := make([]string, 0, len(object))
		for key := range object {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			pairs = append(pairs, c2dJSONPair{key: key, value: c2dJSONNodeFromGo(object[key])})
		}
		return &c2dJSONNode{kind: '{', object: pairs}
	}
	if values, ok := value.([]any); ok {
		array := make([]*c2dJSONNode, len(values))
		for index, child := range values {
			array[index] = c2dJSONNodeFromGo(child)
		}
		return &c2dJSONNode{kind: '[', array: array}
	}
	if values, ok := value.([]Object); ok {
		array := make([]*c2dJSONNode, len(values))
		for index, child := range values {
			array[index] = c2dJSONNodeFromGo(child)
		}
		return &c2dJSONNode{kind: '[', array: array}
	}
	switch typed := value.(type) {
	case string:
		return &c2dJSONNode{kind: 's', text: typed}
	case bool:
		return &c2dJSONNode{kind: 'b', bool: typed}
	case float64:
		return &c2dJSONNode{kind: 'n', number: typed}
	case int:
		return &c2dJSONNode{kind: 'n', number: float64(typed)}
	case int64:
		return &c2dJSONNode{kind: 'n', number: float64(typed)}
	case nil:
		return &c2dJSONNode{kind: '0'}
	default:
		return &c2dJSONNode{kind: 's', text: jsString(typed)}
	}
}

func c2dToDshContent(content any) ([]any, int) {
	if !c2dIsArray(content) {
		return []any{}, 0
	}
	blocks := []any{}
	dropped := 0
	for _, block := range c2dArray(content) {
		entry, ok := block.(Object)
		if !ok || entry == nil {
			dropped++
			continue
		}
		blockType, typeOK := entry["type"].(string)
		text, textOK := entry["text"].(string)
		if typeOK && textOK && (blockType == "text" || blockType == "input_text" || blockType == "output_text") {
			blocks = append(blocks, Object{"type": "text", "text": text})
		} else {
			dropped++
		}
	}
	return blocks, dropped
}

func c2dIsTokenCount(value any) bool {
	return safeInt(value) && num(value) >= 0
}

func c2dConvertUsage(value any) c2dUsageResult {
	source, ok := value.(Object)
	if !ok || source == nil {
		return c2dUsageResult{losses: []string{"usage record had no recognizable counters; usage omitted"}}
	}
	if !c2dIsTokenCount(source["input_tokens"]) || !c2dIsTokenCount(source["output_tokens"]) {
		return c2dUsageResult{losses: []string{"input_tokens and output_tokens must both be non-negative safe integers; usage omitted rather than filled with zero"}}
	}
	input := num(source["input_tokens"])
	output := num(source["output_tokens"])
	usage := Object{"inputTokens": input, "outputTokens": output}
	losses := []string{}
	optional := []struct {
		source string
		target string
	}{
		{source: "cached_input_tokens", target: "cacheReadTokens"},
		{source: "cache_write_input_tokens", target: "cacheWriteTokens"},
	}
	for _, field := range optional {
		count, exists := source[field.source]
		if !exists {
			continue
		}
		if !c2dIsTokenCount(count) {
			return c2dUsageResult{losses: []string{fmt.Sprintf("%s is not a non-negative safe integer; usage omitted because uncached input cannot be determined", field.source)}}
		}
		usage[field.target] = num(count)
	}
	cached := num(usage["cacheReadTokens"]) + num(usage["cacheWriteTokens"])
	if !safeInt(cached) || cached > input {
		return c2dUsageResult{losses: []string{"cache counters exceed aggregate input_tokens; usage omitted rather than emitting negative uncached input"}}
	}
	usage["inputTokens"] = input - cached
	if total, exists := source["total_tokens"]; exists {
		if c2dIsTokenCount(total) && num(total) == input+output {
			usage["totalTokens"] = num(total)
		} else {
			losses = append(losses, "total_tokens is invalid or inconsistent with aggregate input/output; totalTokens omitted")
		}
	}
	if reasoning, exists := source["reasoning_output_tokens"]; exists {
		if c2dIsTokenCount(reasoning) && num(reasoning) <= output {
			usage["reasoningTokens"] = num(reasoning)
		} else {
			losses = append(losses, "reasoning_output_tokens is invalid or exceeds output_tokens; reasoningTokens omitted")
		}
	}
	return c2dUsageResult{usage: usage, losses: losses}
}

func c2dCompactionSnapshot(payload Object) ([]Object, error) {
	history, hasHistory := payload["replacement_history"]
	if !hasHistory {
		message, ok := payload["message"].(string)
		if !ok || message == "" {
			return nil, errors.New("Refusing compaction migration without a readable summary or replacement history")
		}
		return []Object{{"type": "message", "role": "user", "content": []any{Object{"type": "input_text", "text": message}}}}, nil
	}
	historyItems := c2dArray(history)
	if len(historyItems) == 0 || !c2dIsArray(history) {
		return nil, errors.New("Refusing compaction migration with invalid replacement history")
	}
	calls := map[string]bool{}
	messages := []Object{}
	for _, entry := range historyItems {
		item, ok := entry.(Object)
		if !ok || item == nil {
			return nil, errors.New("Invalid compaction context item")
		}
		itemType := str(item["type"])
		switch itemType {
		case "message":
			role := str(item["role"])
			if role != "user" && role != "assistant" {
				return nil, errors.New("Unsupported role in compaction context")
			}
			content, dropped := c2dToDshContent(item["content"])
			if dropped > 0 || len(content) == 0 {
				return nil, errors.New("Unreadable content in compaction context")
			}
		case "function_call", "custom_tool_call":
			callID, callOK := item["call_id"].(string)
			name, nameOK := item["name"].(string)
			if !callOK || callID == "" || !nameOK || name == "" {
				return nil, errors.New("Invalid tool call in compaction context")
			}
			if calls[callID] {
				return nil, errors.New("Duplicate tool call in compaction context")
			}
			calls[callID] = true
		case "function_call_output", "custom_tool_call_output":
			callID, callOK := item["call_id"].(string)
			if !callOK || !calls[callID] {
				return nil, errors.New("Unpaired tool output in compaction context")
			}
			delete(calls, callID)
		default:
			return nil, errors.New("Unsupported or encrypted item in compaction context; refusing partial migration")
		}
		messages = append(messages, item)
	}
	if len(calls) > 0 {
		return nil, errors.New("Unresolved tool call in compaction context; refusing partial migration")
	}
	if len(messages) == 0 || str(messages[0]["type"]) != "message" || str(messages[0]["role"]) != "user" {
		return nil, errors.New("Compaction context must begin with a user message")
	}
	return messages, nil
}

func c2dRememberCall(turn *c2dTurnState, callID string, sequence int) {
	if _, exists := turn.openCalls[callID]; !exists {
		turn.callOrder = append(turn.callOrder, callID)
	}
	turn.openCalls[callID] = sequence
}

func c2dForgetCall(turn *c2dTurnState, callID string) {
	delete(turn.openCalls, callID)
	for index, value := range turn.callOrder {
		if value == callID {
			turn.callOrder = append(turn.callOrder[:index], turn.callOrder[index+1:]...)
			break
		}
	}
}

func c2dClone(value Object) Object {
	cloned, ok := c2dCloneValue(value).(Object)
	if !ok || cloned == nil {
		return Object{}
	}
	return cloned
}

func c2dCloneValue(value any) any {
	switch typed := value.(type) {
	case json.RawMessage:
		copyValue := append(json.RawMessage(nil), typed...)
		return copyValue
	case *json.RawMessage:
		if typed == nil {
			return (*json.RawMessage)(nil)
		}
		copyValue := append(json.RawMessage(nil), (*typed)...)
		return &copyValue
	case Object:
		cloned := Object{}
		for key, child := range typed {
			cloned[key] = c2dCloneValue(child)
		}
		return cloned
	case []any:
		cloned := make([]any, len(typed))
		for index, child := range typed {
			cloned[index] = c2dCloneValue(child)
		}
		return cloned
	case []Object:
		cloned := make([]Object, len(typed))
		for index, child := range typed {
			cloned[index] = c2dClone(child)
		}
		return cloned
	default:
		return value
	}
}

func c2dDescribeLosses(tallies map[string]*Tally) []string {
	losses := []string{}
	for kind, entry := range tallies {
		if entry != nil && entry.Dropped > 0 {
			losses = append(losses, fmt.Sprintf("%s: %d record(s) dropped — %s", kind, entry.Dropped, c2dReason(entry.Reason)))
		}
	}
	sort.Strings(losses)
	return losses
}

func c2dReason(reason string) string {
	if reason == "" {
		return "no mapping"
	}
	return reason
}
