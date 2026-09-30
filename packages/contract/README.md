# @agent-continue/contract

两侧会话格式之间的字段级映射。Codex rollout ↔ DSH session v4。

零依赖，靠相对路径直接引用两个 adapter 的 `src/`，不需要包管理器或构建步骤。

```
node --test "tests/**/*.test.ts"
```

## 已完成方向：Codex → DSH

`convertCodexToDsh(records, options)` 返回 `{header, events, tallies, losses}`。
`losses` 是给人看的丢失清单，`tallies` 是逐类计数。

### 实测结果（2026-09-30）

拿真实会话库里的一个 rollout 跑通：

```
source: ...\rollout-2026-05-29T15-45-03-019e72b1-....jsonl   (27 条记录)
      -> 25 个 DSH 事件
wrote  ...\--F-agent-kaoyan--\codex-019e72b1-...\session.v4.jsonl.zstd (6046 bytes, 2 frames)
session/list 找到它，session/resume 成功打开
```

### 映射表

| Codex | DSH | 说明 |
|---|---|---|
| `response_item/message` role=user | `user/message`（surface） | `data` 就是消息对象本体 |
| `response_item/message` role=assistant | `assistant/message`（surface） | 需要 `{turn, step, message, stream}` |
| `response_item/function_call` | `tool/call` | `arguments` 保持未解析字符串 |
| `response_item/custom_tool_call` | `tool/call` | `input` 序列化后放入 `arguments` |
| `response_item/function_call_output` | `tool/result`（surface） | `output` 是字符串 |
| `response_item/custom_tool_call_output` | `tool/result`（surface） | `output` 是内容块数组，先归一 |
| `event_msg/task_started` | `turn/start` | |
| `event_msg/task_complete` | `turn/end` reason `{kind:'completed'}` | |
| `token_usage_record` | `assistant/message.usage` | 字段逐个对应 |
| `turn_context` | 无（只取 `model` 作为兜底） | |

`assistant/message.source` 用 **Codex 原值**（`model_provider` / `turn_context.model`），
不替换成 DSH 的 provider —— 记录"这条消息实际由谁产生"才是诚实的。

### 丢失项（转换器会逐条报告）

| 来源 | 处理 | 原因 |
|---|---|---|
| `response_item/reasoning` | 丢弃 | 文本在 `encrypted_content` 里，厂商不透明；DSH 也没有独立推理事件 |
| `response_item/message` role=developer | 丢弃 | 那是 Codex 注入的环境块与系统指令，不是对话；回放会把外来系统文本塞进 DSH |
| `event_msg/item_completed` | 丢弃 | Codex 的 UI 层并行记录，与 `response_item/message` 重复 |
| `event_msg/token_count` | 丢弃 | 逐请求计数器与限流信息，DSH 没有对应事件 |
| `event_msg/turn_aborted` | 丢弃 | 被中止的 turn 收尾为 `{kind:'interrupted'}`，Codex 的中止细节无处安放 |
| `world_state` / `compacted` / `realtime_item` / `inter_agent_communication_metadata` | 丢弃 | 没有 DSH 对应物 |

`assistant/message.stream` 一律写空数组：DSH 的流式分片记录在 Codex 里没有对应物。
`request/header` 也不写 —— 我们不知道原始请求头，编造比留空更糟。

## 未完成方向：DSH → Codex

尚未实现。DSH 侧的事件词汇更丰富（62 种），需要决定哪些能落到 Codex 的 9 种顶层记录上。
