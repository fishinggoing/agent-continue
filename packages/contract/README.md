# @agent-continue/contract

两侧会话格式之间的字段级映射。Codex rollout ↔ DSH session v4。

零依赖，靠相对路径直接引用两个 adapter 的 `src/`，不需要包管理器或构建步骤。

```
node --test "tests/**/*.test.ts"
```

## 双向都已用真实 harness 验证（2026-09-30）

| 方向 | 源 | 产物 | 验收证据 |
|---|---|---|---|
| Codex → DSH | 真实 rollout（27 条记录） | 25 个 DSH 事件 | `session/list` 列出 + `session/resume` 成功 |
| DSH → Codex | 真实 DSH 会话（70 个事件） | 44 条 Codex 记录 | `codex exec resume` 退出码 0，且 rollout `51981 → 67599` 字节 |

两个验收判据都不是"看起来对"：

- DSH 侧用 ACP 的 `session/resume`，它会全量解码 + 做 v4 校验 —— 缺 `surfaceOp`、
  `seq` 空洞、未知类型无 `ignorable`、数据形状不对，都在这里硬失败
- Codex 侧看**rollout 文件是否被追加**。Codex 只有真读进了我们的历史，
  才会往同一个文件继续写；如果它另起新会话，文件不会变

调用入口：

```ts
import { convertCodexToDsh, convertDshToCodex } from '../contract/src/index.ts'

const { drafts, tallies, losses } = convertDshToCodex(header, events, { cliVersion, threadId })
const { header: h, events: e, tallies: t, losses: l } = convertCodexToDsh(records, { sessionId, cwd })
```

`losses` 是给人看的丢失清单，`tallies` 是逐类计数。**两者都应当随迁移结果一起呈现**。

## 迁移准入（D16）

两个转换入口要求源 `cwd` 是本机绝对路径；Codex → DSH 还要求目标 `cwd` 是绝对路径。DSH → Codex 拒绝 `origin === 'subagent'` 或已设置 `parentSession` 的源，不静默剥离子会话身份。`assertDshMigrationSource(header)` 与 CLI 共用，必须先校验原始头部，再做工程目录重映射。拒绝采用明确异常，不返回貌似成功的转换结果；只读检查与底层格式解析仍然允许这些源。

这是项目的保守准入策略：DSH ACP 的 list/resume 排除子会话，当前原生进程也拒绝缺失与已覆盖的相对 cwd（含 `.`）；并非声称 Codex 格式无法单独展开子会话。只有普通顶层、绝对 cwd 的产物属于本项目承诺的原生列表与恢复路径，格式解析通过不代表满足这个条件。

---

## 不可迁移字段与丢失项（完整清单）

### A. Codex → DSH

| 来源 | 处理 | 原因 |
|---|---|---|
| `response_item/reasoning` | 丢弃 | 文本在 `encrypted_content` 里，厂商不透明；DSH 也没有独立推理事件 |
| `response_item/message` role=developer / system | 丢弃 | 那是 Codex 注入的环境块与系统指令，不是对话；回放会把外来系统文本塞进 DSH。DSH 的 `developer/message` 需要 `{turn, step, message}` 形状，而该形状在真实 DSH 语料里零出现，无从参照 |
| `event_msg/item_completed` | 丢弃 | Codex 的 UI 层并行记录，与 `response_item/message` 内容重复 |
| `event_msg/token_count` | 丢弃 | 逐请求计数器与限流信息，DSH 没有对应事件 |
| `event_msg/turn_aborted` | 丢弃 | 被中止的 turn 收尾为 `{kind:'interrupted'}`，Codex 的中止细节无处安放 |
| 明文 `compacted` | 保留有效上下文与审计历史 | replacement history 替换旧 surface，旧事件不删除；仅无 replacement history 时使用明文摘要。加密、非文本、未配对工具或未决原调用明确拒绝，不静默降级 |
| `compacted` 的厂商窗口、resume 与 token 元数据 | 丢弃并报告 | 不是 DSH 原生运行状态，不编造压缩模型调用或计数 |
| `world_state` / `realtime_item` / `inter_agent_communication_metadata` | 丢弃 | 没有 DSH 对应物 |
| `assistant/message.stream` | 写空数组 | DSH 的流式分片在 Codex 里没有对应物 |
| `request/header` | 不写 | 我们不知道原始请求头，编造比留空更糟 |

### B. DSH → Codex

| 来源 | 处理 | 原因 |
|---|---|---|
| `step/start` / `step/end` | 丢弃 | Codex 只有 turn，没有 step；step 内的消息内容由 message 记录承载 |
| `assistant/message.stream` | 丢弃 | Codex 没有流式分片记录 |
| `assistant/message.usage` | 丢弃 | Codex 的 `token_usage_record` 需要会话级与线程级累计计数，我们没有；写一条填不全的记录会让它自己的 schema 校验失败，得不偿失 |
| `system/message` / `developer/message` | 丢弃 | Codex 的对话流里没有等价物；它的 developer 消息是它自己注入的，不该由我们伪造 |
| `request/header` / `request/context` | 丢弃 | 请求级元数据，Codex 侧无对应记录 |
| `approval/policy` / `permission/preset` / `sandbox/mode` | 丢弃 | 两边的权限模型不同，且 Codex 的权限是会话级设置而非历史记录 |
| `command/run` / `command/done` | 丢弃 | DSH 的命令记录，Codex 侧无对应 |
| `agent/inbox/spliced` | 丢弃 | DSH 私有的注入记录 |
| `session/title` / `session/title-llm-request` | 丢弃 | 标题是 DSH 私有派生数据 |
| `session-log-deepseek/delivery-accepted` | 丢弃 | harness 私有的投递记账 |
| `assistant/attempt` | 丢弃 | DSH 的重试记录 |

### C. 两个方向都丢的东西

| 内容 | 说明 |
|---|---|
| 厂商不透明推理记录 | Codex 的 `encrypted_content`、DSH 的 reasoning 块。**不承诺跨账号、跨厂商或跨模型可用**，只能原样保存 |
| 工具名与参数 schema | 两边工具集不同。转换保持 `name` 与 `arguments` 原样，但目标 harness 未必认识那个工具 |
| 权限/审批状态 | Codex 的 approval 是会话级设置，DSH 的 SDK 没有审批方法 |
| token 计量口径 | Codex 有独立 `token_usage_record`，DSH 把 `usage` 挂在 `assistant/message` 上；只迁移可识别的计数，缺失或不一致的信息报告损失，不承诺计费等价 |
| 未闭合工具调用的语义 | Codex 侧没有"结果未知"的表达；建议在恢复报告里标注，而不是当作失败重放 |

---

## 映射表

### Codex → DSH

| Codex | DSH | 说明 |
|---|---|---|
| `response_item/message` role=user | `user/message`（surface） | `data` 就是消息对象本体，不带 turn/step |
| `response_item/message` role=assistant | `assistant/message`（surface） | 需要 `{turn, step, message, stream}` |
| `response_item/function_call` | `tool/call` | `arguments` 保持未解析字符串 |
| `response_item/custom_tool_call` | `tool/call` | `input` 序列化后放入 `arguments` |
| `response_item/function_call_output` | `tool/result`（surface） | `output` 是字符串 |
| `response_item/custom_tool_call_output` | `tool/result`（surface） | `output` 是内容块数组，先归一 |
| `event_msg/task_started` | `turn/start` | |
| `event_msg/task_complete` | `turn/end` reason `{kind:'completed'}` | |
| `token_usage_record` | `assistant/message.usage` | 必填 input/output 无效时省略 usage 并报告损失；可选计数缺失时不写，不补 0；保留 reasoning 计数；已记录的缓存计数从总输入中扣除，避免 DSH 的互斥计数重复计算；缺失或不一致的 total 不写 |

`assistant/message.source` 用 **Codex 原值**（`model_provider` / `turn_context.model`），
不替换成 DSH 的 provider —— 记录"这条消息实际由谁产生"才是诚实的。

迁入时保留一个内容为空的 DSH 系统首节点，带显式 migration 标记，由当前 DSH 进程替换；不是复制外来提示或捏造 DSH 指令。压缩不能覆盖该节点。已明确记录的 `TOOL_OUTCOME_UNKNOWN` 在压缩后仍以带来源引用的上下文提醒保留，不能因摘要没有提及就当作成功。工作区重映射额外投递真实的新旧目录状态，不改写历史路径、不复制工程文件。DSH → Codex 的 surface replacement 尚未实现等价投递，本次不能据此宣称双向压缩无损。

### DSH → Codex

| DSH | Codex |
|---|---|
| `turn/start` | `event_msg/task_started` + 一条 `turn_context` |
| `turn/end` | `event_msg/task_complete`（带 `duration_ms`） |
| `user/message` | `response_item/message` role=user + `event_msg/item_completed` UserMessage |
| `assistant/message` | `response_item/message` role=assistant + `event_msg/item_completed` AgentMessage |
| `tool/call` | `response_item/function_call` |
| `tool/result` | `response_item/function_call_output` |

## 学到的东西（踩过的坑，供后续适配器参考）

这三条都是实测撞出来的，不是读文档能知道的：

1. **`session_meta.cli_version` 和 `session_meta.id == 注册的线程 id` 都是硬要求。**
   任一不满足，Codex 都报同一句 `does not start with session metadata`——而行首明明
   就是 `session_meta`。这句话的真实含义是"会话元数据解析失败"，不是记录顺序问题。
2. **DSH 的校验器能过，不代表 DSH 能加载。** `assistant/message.source` 缺
   `provider`/`model`、`developer/message` 形状不对，两次都通过了我们自己的
   `parseSessionLog`，随后被真实 DSH 拒绝。所以判据只能是**目标 harness 实际 resume 成功**。
3. **`writeArtifact` / `writeRollout` 默认拒绝覆盖**（Codex 在独立审查中提出）。
   重复 id 导入必须显式传 `{ overwrite: true }`，否则会静默毁掉已存的会话。
