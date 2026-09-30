# @agent-continue/codex-adapter

在 Codex 进程之外读写 OpenAI Codex 的会话存储：`rollout-*.jsonl` 日志，
以及让它可列出、可续跑的 `state_5.sqlite` 注册行。

## 运行时

零依赖。需要 Node ≥ 22.15。依赖 TypeScript 原生类型擦除，**不需要构建步骤**：

```
node --test "tests/**/*.test.ts"
```

## 目录

| 路径 | 作用 |
|---|---|
| `src/paths.ts` | 会话库布局：`codexHome`、`sessionsRoot`、rollout 文件名编解码、路径推导、发现 |
| `src/rollout.ts` | rollout JSONL 读取：信封校验、保留未知类型、子类型统计、工具输出归一、turn 窗口 |
| `tests/corpus.ts` | 真实会话库的受限读取（默认最多 30 个文件 / 32 MB） |
| `tests/rollout.test.ts` | 单元测试 + 对真实会话库的完整性核对 |

## 读取策略：宽容而非严格

Codex 拥有这个格式并且在持续演进，所以读取器**保留未知记录类型与未知字段**，
只对信封本身（`timestamp` / `ordinal` / `type` / `payload`）做硬校验。
这与 DSH 侧相反 —— 那边我们要**写**，所以必须严格；这边我们只是消费者。

## 已实测的格式事实

语料：25 个 rollout 文件、88.3 MB、12280 行。

- 顶层类型 9 种：`event_msg`、`response_item`、`token_usage_record`、
  `turn_context`、`realtime_item`、`world_state`、
  `inter_agent_communication_metadata`、`session_meta`、`compacted`
- `ordinal` 是**稠密 0 基索引**，在 5733 条真实记录上零跳号
- 每个文件首行都是 `session_meta`
- 文件名里的时间戳是**本地时间且不带时区后缀**，不是 `session_meta.timestamp`
  的 UTC 时间（实测三个会话，差值恒为 UTC+8）。日期目录同样按本地时钟
- 工具结果有两种编码：`function_call_output.output` 是字符串，
  `custom_tool_call_output.output` 是内容块数组

## 尚未实现

- 写入 rollout 与 `state_5.threads` 注册行（需要隔离的 `CODEX_HOME` 沙箱验证）
- 与 DSH 会话格式之间的字段级映射
