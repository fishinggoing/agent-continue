package migrate

import (
	"fmt"
	"math"
	"reflect"
)

// SurfaceEventTypes are the DSH event kinds that can participate in the
// projected conversation.  Keep this list in step with the DSH adapter's
// surface event set; log-only events are deliberately rejected when they carry
// a projection marker.
var d2cSurfaceEventTypes = map[string]bool{
	"system/message":    true,
	"developer/message": true,
	"user/message":      true,
	"assistant/message": true,
	"tool/result":       true,
}

// CurrentSurface reconstructs the conversation represented by DSH surface
// operations.  The source log remains append-only: a replacement shadows the
// nodes in its current surface slot while the replacement event itself keeps
// its original source sequence number.
func CurrentSurface(events []Object) ([]Object, error) {
	nodes := make([]Object, 0)
	for index, event := range events {
		seq, ok := d2cSafeEventSeq(event)
		if !ok || seq != index {
			return nil, fmt.Errorf("Refusing migration: noncontiguous DSH surface log")
		}
		typ := d2cStringValue(event["type"])
		if typ == "image/offload" {
			return nil, fmt.Errorf("Refusing migration: image/offload requires its owning message projection interpreter")
		}

		operation, hasOperation := event["surfaceOp"]
		if !hasOperation {
			continue
		}
		if !d2cSurfaceEventTypes[typ] {
			return nil, fmt.Errorf("Refusing migration: unsupported surface projection %s", typ)
		}

		references, ok := d2cReferences(event["sourceEventSeqs"])
		if !ok {
			return nil, fmt.Errorf("Refusing migration: invalid DSH surface provenance")
		}
		seenReferences := make(map[int]bool, len(references))
		for _, reference := range references {
			if reference < 0 || reference >= seq || seenReferences[reference] {
				return nil, fmt.Errorf("Refusing migration: invalid DSH surface provenance")
			}
			seenReferences[reference] = true
		}

		if operation == "append" {
			nodes = append(nodes, event)
			continue
		}

		marker, ok := d2cObject(operation)
		if !ok || d2cStringValue(marker["op"]) != "replace" {
			return nil, fmt.Errorf("Refusing migration: replacement endpoints are not in the current DSH surface")
		}
		start, startOK := d2cSafeNumber(marker["startSeq"])
		end, endOK := d2cSafeNumber(marker["endSeq"])
		first := -1
		last := -1
		if startOK {
			for nodeIndex, node := range nodes {
				if nodeSeq, valid := d2cSafeEventSeq(node); valid && nodeSeq == start {
					first = nodeIndex
					break
				}
			}
		}
		if endOK {
			for nodeIndex, node := range nodes {
				if nodeSeq, valid := d2cSafeEventSeq(node); valid && nodeSeq == end {
					last = nodeIndex
					break
				}
			}
		}
		if first < 0 || last < first {
			return nil, fmt.Errorf("Refusing migration: replacement endpoints are not in the current DSH surface")
		}

		shadowed := nodes[first : last+1]
		for _, node := range shadowed {
			nodeSeq, valid := d2cSafeEventSeq(node)
			if !valid || !seenReferences[nodeSeq] {
				return nil, fmt.Errorf("Refusing migration: DSH surface replacement omits shadowed provenance")
			}
		}

		if first == 0 && d2cStringValue(nodes[0]["type"]) == "system/message" {
			if typ != "system/message" || len(shadowed) != 1 {
				return nil, fmt.Errorf("Refusing migration: replacement overwrites the protected DSH system head")
			}
		}

		if typ == "tool/result" {
			original := shadowed[0]
			if len(shadowed) != 1 || d2cStringValue(original["type"]) != "tool/result" ||
				!d2cDeepEqual(d2cWithoutMessageContent(original["data"]), d2cWithoutMessageContent(event["data"])) {
				return nil, fmt.Errorf("Refusing migration: DSH tool-result replacement may change only content")
			}
		}

		replaced := make([]Object, 0, len(nodes)-last+first)
		replaced = append(replaced, nodes[:first]...)
		replaced = append(replaced, event)
		replaced = append(replaced, nodes[last+1:]...)
		nodes = replaced
	}
	return nodes, nil
}

// d2cReferences decodes sourceEventSeqs.  An absent or null field is the
// empty reference list, matching the nullish-coalescing expression in DSH.
func d2cReferences(value any) ([]int, bool) {
	if value == nil {
		return []int{}, true
	}
	switch typed := value.(type) {
	case []int:
		refs := append([]int(nil), typed...)
		return refs, true
	case []int64:
		refs := make([]int, len(typed))
		for index, item := range typed {
			if item < 0 || int64(int(item)) != item {
				return nil, false
			}
			refs[index] = int(item)
		}
		return refs, true
	case []float64:
		refs := make([]int, len(typed))
		for index, item := range typed {
			if math.IsNaN(item) || math.IsInf(item, 0) || math.Trunc(item) != item || item < 0 || item > 9007199254740991 {
				return nil, false
			}
			refs[index] = int(item)
		}
		return refs, true
	}
	values := arr(value)
	if values == nil {
		return nil, false
	}
	refs := make([]int, 0, len(values))
	for _, value := range values {
		ref, ok := d2cSafeNumber(value)
		if !ok {
			return nil, false
		}
		refs = append(refs, ref)
	}
	return refs, true
}

func d2cSafeEventSeq(event Object) (int, bool) {
	return d2cSafeNumber(event["seq"])
}

func d2cSafeNumber(value any) (int, bool) {
	if !isNum(value) || !safeInt(value) {
		return 0, false
	}
	return int(num(value)), true
}

func d2cObject(value any) (Object, bool) {
	if value == nil {
		return nil, false
	}
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, false
	}
	return object, true
}

func d2cStringValue(value any) string {
	if value == nil {
		return ""
	}
	if stringValue, ok := value.(string); ok {
		return stringValue
	}
	return ""
}

func d2cWithoutMessageContent(value any) Object {
	data, _ := d2cObject(value)
	result := make(Object, len(data)+1)
	for key, item := range data {
		result[key] = item
	}
	message, _ := d2cObject(data["message"])
	messageCopy := make(Object, len(message)+1)
	for key, item := range message {
		messageCopy[key] = item
	}
	messageCopy["content"] = nil
	result["message"] = messageCopy
	return result
}

// d2cDeepEqual follows the JSON/JavaScript comparison relevant to decoded
// session objects.  JSON numbers have one JavaScript number type, whereas Go
// tests may construct the same values using int or float64.
func d2cDeepEqual(left, right any) bool {
	if isNum(left) && isNum(right) {
		return num(left) == num(right)
	}
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	switch leftValue := left.(type) {
	case map[string]any:
		rightValue, ok := right.(map[string]any)
		if !ok || len(leftValue) != len(rightValue) {
			return false
		}
		for key, item := range leftValue {
			other, exists := rightValue[key]
			if !exists || !d2cDeepEqual(item, other) {
				return false
			}
		}
		return true
	case []any:
		switch rightValue := right.(type) {
		case []any:
			if len(leftValue) != len(rightValue) {
				return false
			}
			for index, item := range leftValue {
				if !d2cDeepEqual(item, rightValue[index]) {
					return false
				}
			}
			return true
		case []Object:
			if len(leftValue) != len(rightValue) {
				return false
			}
			for index, item := range leftValue {
				if !d2cDeepEqual(item, rightValue[index]) {
					return false
				}
			}
			return true
		}
		return false
	case []Object:
		switch rightValue := right.(type) {
		case []any:
			if len(leftValue) != len(rightValue) {
				return false
			}
			for index, item := range leftValue {
				if !d2cDeepEqual(item, rightValue[index]) {
					return false
				}
			}
			return true
		case []Object:
			if len(leftValue) != len(rightValue) {
				return false
			}
			for index, item := range leftValue {
				if !d2cDeepEqual(item, rightValue[index]) {
					return false
				}
			}
			return true
		}
		return false
	}
	return reflect.DeepEqual(left, right)
}
