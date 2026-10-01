# @agent-continue/cli

Owner：Codex。使用 DSH 已冻结的两个适配器和双向转换函数，提供显式的检查、迁移计划和原生文件写入入口。零 npm 依赖，使用 Node 24.12 及以上的原生 TypeScript 类型擦除与 SQLite。

**当前状态（2026-10-02）**：实现与测试基线 `478d2e5` 已冻结，D1–D16 全部结案。完整安装、双向接续、测试、版本边界与交付说明见 [根 README](../../README.md)。本文的带日期失败记录保留作历史证据，不代表当前仍待修。当前是本地 CLI，没有在线全栈演示入口。

## 使用

在仓库根目录运行：

```powershell
node packages/cli/src/main.ts --help
node packages/cli/src/main.ts inspect --from codex --input "C:\path\rollout.jsonl"
node packages/cli/src/main.ts inspect --from dsh --input "C:\path\session.v4.jsonl.zstd"
```

Codex → DSH，先检查不落盘的迁移计划，再去掉 `--dry-run` 写入：

```powershell
node packages/cli/src/main.ts migrate --from codex --input "C:\path\rollout.jsonl" --cwd "F:\agent-continue" --target-home "F:\agent-continue\.agent-continue\my-dsh-home" --dry-run
```

DSH → Codex，目标 home 必须已经由对应 Codex 版本初始化数据库；不会猜测数据库 schema、复制真实用户数据库或创建空注册库：

```powershell
node packages/cli/src/main.ts migrate --from dsh --input "C:\path\session.v4.jsonl.zstd" --cwd "F:\agent-continue" --target-home "F:\agent-continue\.agent-continue\my-codex-home" --cli-version "0.159.2" --model-provider "example-provider" --model "example-model" --dry-run
```

`--cli-version` 和 `--model-provider` 必须显式指定目标 Codex 的配置，不把 DSH 的提供商身份当作目标配置。`--model`、`--title` 为可选的 Codex 注册项。目标会话默认使用新 UUID，`--id` 可以显式指定 UUID；重复 ID 或文件会被拒绝，不提供覆盖开关。

## 输出与限制

- `inspect` 仅输出结构、记录数和结果未知的调用 ID/名称，不输出消息正文、工具参数或原始记录。
- `migrate` 输出 JSON：目标 ID/路径、记录数、转换计数、损失清单与未完成工具调用。`--dry-run` 不创建目标目录、不写入数据库。
- `status: written` 只表示产物已写入，**不是原生恢复已经验证**。`nativeValidation: not-run` 明确保留；DSH 必须经真实 ACP 恢复验证，Codex 必须经目标原生恢复验证。信封校验不等于全部事件数据合法。
- 不启动目标模型、不发模型请求、不执行或重放历史工具。结果未知的操作保持 `state: unknown`，需要接续者核对，不能当作失败自动重试。
- DSH 原生恢复生成的 `TOOL_OUTCOME_UNKNOWN` 保持未知，inspect 和迁移报告不会把它当作已知结果。机器可识别标记、待核实调用及当前有效上下文中的载体已实现双向保留，并有原生恢复、重启与往返回归；无法保持必要载体时明确拒绝，不把结果未知自动当作成功或失败重试。
- 已接收的 Codex 结果扩展位于 function/custom tool output 的 payload 顶层：`isError: true`、`recovery: "TOOL_OUTCOME_UNKNOWN"`。inspect 依明确 recovery 标记保持未知，不依正文关键词；仅有 isError 或 `TOOL_NOT_STARTED` 不等于未知。原生兼容性、底层生成和往返保留均有已结案回归；不宣称 Codex 自身提供跨厂商未知状态语义。
- 必须明确指定目标 home 和已存在的绝对工程目录，不默认写入真实用户 home；项目文件不会复制、回滚或修复，`cwdRemapped` 提醒工程位置发生变化。
- DSH 源支持 v3/v4、纯 JSONL 或 `.zstd`；压缩尾部不完整、损坏的 Codex 行及未知 DSH 版本会拒绝。输入文件上限为 128 MiB。
- D16：DSH 源的 `origin: subagent`、任何已设置的 `parentSession`，以及两侧源的缺失、空或非绝对 `cwd`，均明确拒绝迁移。校验在 DSH 源 `--cwd` 重映射前执行，不把子会话静默升级成顶层会话；真实迁移和 dry-run 均不写入目标，CLI 返回非零退出码与结构化错误。`inspect` 仍可只读检查被拒绝的源。这是保守迁移准入策略，不声称 Codex 格式本身无法表达展开后的子会话。
- Codex 明文 `compacted.replacement_history` 迁入 DSH 当前有效上下文，旧消息留在审计历史，不再次投递；没有 replacement history 时才使用明文摘要。空、非文本、加密、未配对工具或覆盖未决调用的快照明确拒绝，不能静默跳过后继续写入。Codex 专有窗口/token 元数据仍报告损失。
- DSH 产物在第一步保留一个空系统首节点，由当前 DSH 运行时替换；不复制外来系统权限/指令，不伪造目标提示文本。后续压缩不覆盖该节点，首次续跑和关闭后的再次恢复都有独立原生回归。
- Codex 注册使用只读沙箱和 `on-request` 审批，不从旧会话迁移权限。SQLite 不兼容和重复注册在文件写入前检查；注册阶段若仍失败，明确报告残留 rollout，不自动删除或隐藏部分结果。
- DSH → Codex 的 `--dry-run` 不进行 SQLite 初始化、schema 或重复注册检查，这些在实际写入前执行；计划成功不是原生恢复或最终写入保证。
- Codex 的列表预览使用转换后第一条用户文本，保存在目标数据库，不打印到 CLI 报告。分页历史格式仍须由对应版本的真实 app-server 检查；当前原生导入修正与验收证据见 `docs/CODEX-REVIEW.md`。
- Node 内置 SQLite 可能向 stderr 输出实验性警告；正常报告位于 stdout。

## 测试

```powershell
node --test "packages/cli/tests/*.test.ts"
```

本包的日常测试使用合成会话和独立临时数据库，原生测试默认跳过，显式开启后只使用隔离 home；其中 continuation 测试向 localhost Responses 固定响应服务发起请求，不联系外部模型、不转发凭据。跑四个包的全套时必须显式设置空 `CODEX_SESSIONS_ROOT`、`DSH_SESSION_ROOT`，否则其他包的语料测试会默认定位真实会话库。安全全套命令和完整证据见根 README 与 `docs/CODEX-REVIEW.md`。

`migration-eligibility.test.ts` 固化 D16 的无写入拒绝；`eligibility-native.test.ts` 用独立 DSH 夹具验证真实 ACP 的子会话与 cwd 过滤，并对未经手改的普通顶层 CLI 产物在两个新进程中 list/resume。当前原生 DSH 也拒绝相对路径 `.`，不能仅根据参考源码的目录比较函数推断整个恢复入口会接受它。

显式指定当前二进制和已有隔离运行根；Codex 测试读取 `--version`，再填写目标版本。`native.test.ts` 仅验证列表/恢复/历史，`continuation.test.ts` 额外验证新 turn 接收两轮 UTF-8 消息和完成工具结果各一次、顺序正确，并验证本地模拟回复在进程重启后保留。`recovery-native.test.ts` 只测试手工注入到隔离产物的候选扩展是否被原生接受，不冒充完整迁移验收。独立 DSH 工具夹具不依赖双向转换器生成：

```powershell
$env:AGENT_CONTINUE_CODEX_CLI = "C:\Users\20373\AppData\Local\OpenAI\Codex\bin\de8a38d2100ae498\codex.exe"
$env:AGENT_CONTINUE_DSH_CLI = "F:\dsh\app\resources\runtime\cli\bin\dsh.cmd"
$env:AGENT_CONTINUE_NATIVE_ROOT = "F:\agent-continue\.agent-continue\codex-review"
node --test packages/cli/tests/native.test.ts packages/cli/tests/continuation.test.ts packages/cli/tests/dsh-native.test.ts packages/cli/tests/recovery-native.test.ts
```

上述 Codex 路径于 2026-10-01 实测存在，`--version` 返回 `codex-cli 0.159.2`。安装目录的哈希会随重装变化，同版本号也可能对应不同文件；运行前确认当前绝对路径，并在验收证据中记录实际路径、版本及 `Get-FileHash -Algorithm SHA256 -LiteralPath $env:AGENT_CONTINUE_CODEX_CLI` 的文件哈希。

**历史失败证据，非当前状态**：2026-09-30 的 `005c947` 固定快照加当时 CLI：53 项中 42 通过、3 失败、8 跳过。2026-10-01 的 `d23ae69` 快照加 recovery 接收和重启回归：56 项中 45 通过、3 失败、8 跳过。当时 Codex `0.159.2` 原生历史/续接/候选扩展和两项 DSH 原生控制通过，失败为 Codex → DSH 的已完成/中断工具生命周期，以及 DSH → Codex 的未知结果标记生成，对应 D3/D4/D5。这些缺陷及后续 D1–D16 已结案，失败测试没有删除或改为跳过；冻结的固定干净全套结果为 162 项、153 通过、0 失败、9 跳过，跳过条件逐项见 CODEX-REVIEW。

## 真实任务接续验收

`tests/live-handoff.ts` 是单独的手动验收程序，不是日常 `*.test.ts` 回归。它调用真实模型，**消耗额度**；必须先获得使用本机登录的授权，再显式开启。程序只读登录配置/凭据，不读取已有用户任务会话，运行数据均在 `.agent-continue/live-handoff-*`。Codex 的临时 auth 副本退出时删除，DSH 凭据通过子进程环境传入，不打印或提交。

```powershell
$env:AGENT_CONTINUE_LIVE = '1'
$env:AGENT_CONTINUE_CODEX_CLI = '<当前 codex.exe 绝对路径>'
$env:AGENT_CONTINUE_DSH_CLI = '<当前 dsh.cmd 绝对路径>'
$env:AGENT_CONTINUE_PYTHON = '<安装了 PyYAML 的 python.exe 绝对路径>'
# 可选：仅覆盖验收模型，不改日常配置；应先确认该路由确实提供它。
$env:AGENT_CONTINUE_LIVE_MODEL = '<可用模型>'
# 可选：真实 Codex 先压缩，再中断并验收接续。
$env:AGENT_CONTINUE_LIVE_COMPACT = '1'
node packages/cli/tests/live-handoff.ts
```

自动多窗口压力验收不调用手动 compact，使用独立进程配置的较低阈值：

```powershell
$env:AGENT_CONTINUE_LIVE_COMPACT = ''
$env:AGENT_CONTINUE_LIVE_LONG_CONTEXT = '1'
$env:AGENT_CONTINUE_LIVE_AUTO_COMPACT_LIMIT = '22000'
node packages/cli/tests/live-handoff.ts
```

该模式增加七轮真实对话，包括五批只用于增长 context 的合成数据和两次仅在对话中的 memo 修订；中间不允许改代码。验收要求至少两次真实自动压缩、最后修订仍在原生有效快照、DSH 仅收到“继续”后遵循最终版本完成任务、两个目录场景均正常 end_turn，并通过原有外部断言和重启检查。配置值仅影响隔离 Codex home，不改日常阈值；它验证缩小阈值下的自动多窗口边界，不代表默认完整窗口、任意工程或真正五小时时限均已验收。

额度拒绝路径使用本机代理先转发真实 Responses 请求，第一阶段结束后再返回合成 HTTP 429 / `insufficient_quota`：

```powershell
$env:AGENT_CONTINUE_LIVE_QUOTA_REFUSAL = '1'
# 可以与 LONG_CONTEXT 组合；简单拒绝路径无需开启它。
$env:AGENT_CONTINUE_LIVE_COMPACT = ''
$env:AGENT_CONTINUE_LIVE_LONG_CONTEXT = ''
node packages/cli/tests/live-handoff.ts
```

该模式不调用 `turn/interrupt`，必须观察真实 Codex 轮次 `failed`、额度错误和未变的未完成代码，再迁移原样会话。DSH 两个场景必须正常 end_turn；代理只记录状态码与转发/拒绝计数，不保存凭据或请求正文。它不测试实际套餐 OAuth/五小时复位规则；HTTP 错误来自 localhost，而任务生成和接续理解来自真实模型。退出时关闭代理并删除临时 auth。模式仅适用于配置了 base URL 的 Responses 路由，不更改用户日常配置。

目前此程序针对 Windows、本机 Codex TOML/auth.json 和 DSH 的 `DEEPSEEK_API_KEY` 凭据引用；DSH 使用本机默认的 `deepseek-official` / `deepseek-flash`。不适用于任意 OAuth/钥匙串登录布局。两端禁用开发子代理；DSH 使用工作区沙箱，必要的测试命令可获一次性批准。原生轮次限时八分钟，DSH 达到 15 个已接受模型回复时请求取消；这是运行限额，不是包含重试的计费请求硬上限。

验收流程：Codex 得到仅存于对话的完整需求，完成开户并保留转账等方法为未实现；继续轮次在首个命令时中断，保留未提交修改。开启 compact 开关时先调用真实 `thread/compact/start`，核对迁入的有效替换消息与原生快照逐字一致且顺序相同。CLI 迁移原样会话后，DSH 只收到“继续”。外部断言检查真实实现、幂等/原子性/溢出/历史隔离和对话中的特定值，再检验原有测试与指令未改、没有创建交接文档或提交，并用新 DSH 进程重新恢复完成的会话。两个场景分别使用同一目录、复制中断前文件快照的新目录。

完整结果保存为运行目录的 `evidence.json`。若只需接着一个已有隔离验收，可设置 `AGENT_CONTINUE_LIVE_RESUME` 为该运行目录；已标记通过的场景只重验断言，不重复调用模型。尚未通过的场景仍可能消耗额度，不能用于任意会话目录。

设置 `AGENT_CONTINUE_LIVE_VERIFY_ONLY=1` 可只重验已结束的同一原生运行，不读取登录凭据、不调用模型；代码哈希必须与已记录的完成结果一致，不能用它补做尚未结束的场景。路径审计按 session ID 区分重试，保留以前失败的日志。达到运行限额而取消的 prompt 会单独记录 `promptFinishedNormally: false`，代码断言通过不等于模型正常结束全部自检。

**范围**：真实模型小工程接续不等于真实套餐时限验收；程序按开关主动中断或用 localhost 注入额度拒绝，不耗尽套餐。换目录时文件由验收程序复制，`migrate` 本身不搬运未提交文件。自动多窗口及 DSH → Codex 当前有效曲面替换已有独立验收，一次手动压缩仍不能代替它们。加密/非文本压缩及无解释器投影明确拒绝；任意附件、外部副作用、全部桌面交互、实际套餐耗尽与默认完整窗口饱和没有完整验收，不能承诺“全部 context 无损”。最新证据以 `docs/CODEX-REVIEW.md` 为准，前面的历史失败记录不是当前状态。

## 联合场景与完成审计

要验收同一任务先跨自动压缩窗口、再遭额度拒绝，组合现有开关；仍需先配置当前二进制和 Python 路径、可用模型，以及真实调用授权：

```powershell
$env:AGENT_CONTINUE_LIVE = '1'
$env:AGENT_CONTINUE_LIVE_LONG_CONTEXT = '1'
$env:AGENT_CONTINUE_LIVE_AUTO_COMPACT_LIMIT = '22000'
$env:AGENT_CONTINUE_LIVE_QUOTA_REFUSAL = '1'
$env:AGENT_CONTINUE_LIVE_COMPACT = ''
$env:AGENT_CONTINUE_LIVE_RESUME = ''
$env:AGENT_CONTINUE_LIVE_VERIFY_ONLY = ''
node packages/cli/tests/live-handoff.ts
```

运行结束后，对打印出的隔离目录作独立、不调用模型的审计：

```powershell
node packages/cli/tests/live-handoff-audit.ts '<仓库内 .agent-continue/live-handoff-* 的绝对路径>'
```

审计不读取凭据，不启动原生模型；输出脱敏的 `completion-audit.json`。它要求多窗口与额度拒绝来自**同一个真实源运行**，并重新检查原始 source/执行代码哈希、未完成检查点的三个 stub、对话专属最终要求不在文件里、迁移原始前缀未被续跑改写、有效快照角色/正文/顺序、真实正常结束与新进程恢复日志及完成后的代码。失败/取消的运行和分开的两个通过记录不能拼成联合通过。完整业务断言仍由 live runner/verify-only 提供，审计不会替代它们，也不推定实际套餐 OAuth 或默认完整窗口饱和已经验收。
