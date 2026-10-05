package task

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/fishinggoing/agent-continue/internal/domain"
)

// DemoProvider is a deterministic fixture. File operations and tests remain real.
type DemoProvider struct{}

func (DemoProvider) Models(context.Context) ([]domain.Model, error) {
	return []domain.Model{{Provider: "demo", ID: "demo", Tools: true, Streaming: true}}, nil
}
func (DemoProvider) Complete(ctx context.Context, req domain.ModelRequest, delta func(string) error) (domain.ModelResponse, error) {
	response := domain.ModelResponse{Complete: true, FinishReason: "stop"}
	last := req.Messages[len(req.Messages)-1]
	name, text := "", ""
	args := any(struct{}{})
	if last.Role == domain.RoleUser {
		text = "演示流程开始。我会读取定价规则，运行现有测试，并在修改前提交审批。"
		name = "read_file"
		args = map[string]string{"path": "pricing.json"}
	} else if last.Role == domain.RoleTool {
		var toolName string
		for _, m := range req.Messages {
			for _, c := range m.ToolCalls {
				if c.ID == last.ToolCallID {
					toolName = c.Name
				}
			}
		}
		output := ""
		for _, p := range last.Content {
			output += p.Text
		}
		switch toolName {
		case "read_file":
			text = "已读取当前文件。接下来执行四个规则测试，核实折扣是否影响运费。"
			name = "run_tests"
		case "run_tests":
			if strings.Contains(output, "FAIL") {
				patched := false
				for _, m := range req.Messages {
					for _, c := range m.ToolCalls {
						if c.Name == "apply_patch" {
							patched = true
						}
					}
				}
				if !patched {
					text = "测试发现折扣被应用到了运费。拟将 discountBase 从 total 改为 subtotal，等待本次修改的批准。"
					name = "apply_patch"
					args = Patch{Path: "pricing.json", Before: `"discountBase": "total"`, After: `"discountBase": "subtotal"`}
				} else {
					text = "规则测试仍有失败，任务没有达到验收结果。请审阅测试输出。"
				}
			} else {
				text = "四个规则测试均通过。当前折扣只作用于商品小计，运费保持原值。实际文件差异与测试输出已保存。"
			}
		case "apply_patch":
			if strings.Contains(output, "\"status\":\"completed\"") {
				text = "修改已写入文件，现在重新运行规则测试。"
				name = "run_tests"
			} else {
				text = "本次修改未执行成功；工程保持当前状态，尚不能宣布修复完成。"
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return response, err
	}
	if err := delta(text); err != nil {
		return response, err
	}
	response.Text = text
	if name != "" {
		b, _ := json.Marshal(args)
		response.ToolCalls = []domain.ToolCall{{ID: newID(), Name: name, Arguments: b, Status: domain.ToolProposed}}
		response.FinishReason = "tool_calls"
	}
	return response, nil
}
