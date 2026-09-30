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
| `src/write.ts` | 写入：rollout 编码与落盘、`threads` 注册行、投影游标 |
| `tests/corpus.ts` | 真实会话库的受限读取（默认最多 30 个文件 / 32 MB） |
| `tests/resume.test.ts` | 端到端验收：写一个线程，让真实 `codex exec resume` 加载它 |

## 读取策略：宽容而非严格

Codex 拥有这个格式并且在持续演进，所以读取器**保留未知记录类型与未知字段**。
这与 DSH 侧相反 —— 那边我们要**写**，所以必须严格；这边我们只是消费者。

## 写入

让一个 rollout 可续跑需要三样东西，缺一不可：

1. `<home>/sessions/YYYY/MM/DD/rollout-<本地时间>-<id>.jsonl`
2. `<home>/state_5.sqlite` 的 `threads` 行 —— `codex resume` / `codex agents` 的列表来源
3. `<home>/thread_history_1.sqlite` 的投影游标行

端到端测试需要三个环境变量（未设置时自动跳过）：

```powershell
$env:CODEX_CLI='C:\Users\20373\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe'
$env:CODEX_PROBE_HOME='F:\agent-continue\.agent-continue\probe\codex-home'
$env:CODEX_PROBE_CWD='F:\agent-continue'
```

`CODEX_PROBE_HOME` 必须是一次 `codex exec` 初始化过的隔离 home（那会建出各个 SQLite 库），
与真实 `~/.codex` 隔离。

## 已实测的格式事实

语料：25 个 rollout 文件、88.3 MB、12280 行；端到端另在隔离 home 上验过。

- 顶层类型 9 种：`event_msg`、`response_item`、`token_usage_record`、
  `turn_context`、`realtime_item`、`world_state`、
  `inter_agent_communication_metadata`、`session_meta`、`compacted`
- 文件名里的时间戳是**本地时间且不带时区后缀**，不是 `session_meta.timestamp`
  的 UTC 时间（实测差值恒为 UTC+8）。日期目录同样按本地时钟
- 工具结果有两种编码：`function_call_output.output` 是字符串，
  `custom_tool_call_output.output` 是内容块数组
- `ordinal` **可写可不写**：Codex 创建 rollout 时写，追加到别人创建的 rollout 时
  完全不写。行序才是权威序列
- `session_meta.cli_version` **实际必填**：漏掉它 Codex 报
  `does not start with session metadata`，尽管行首就是 `session_meta`
- 端到端：手写线程被 `codex exec resume` 加载，且 Codex 把新 turn
  **追加进我们的文件**（2705 → 26461 字节），这是它读进了历史的直接证据

## 尚未实现

- 与 DSH 会话格式之间的字段级映射（`packages/contract/`）
- 两个方向的实际迁移编排
