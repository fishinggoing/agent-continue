# @agent-continue/dsh-adapter

在 DSH 进程之外读写 DeepSeek Harness 的 `session.vN.jsonl.zstd` 会话文件。

## 为什么自己实现

DSH 的会话格式包是私有 `workspace:` 依赖，本机既没有可 `import` 的构建副本
（`profiles` 下的 junction 缺 `package.json`），也无法从 npm 安装（出网是白名单式）。
因此这里按 DSH 的格式规范自行实现，并用**真实 DSH 进程**做验证。
完整决策依据见仓库根 `docs/HANDOFF.md` §7.1。

## 运行时

零依赖。需要 Node ≥ 22.15（用到内置 zstd）。开发时用 DSH 自带的 Node 24 运行，
依赖 TypeScript 原生类型擦除，**不需要构建步骤**：

```
node --test "tests/**/*.test.ts"
```

## 目录

| 路径 | 作用 |
|---|---|
| `src/zstd.ts` | 拼接式 zstd 帧容器：结构化定位帧边界、逐帧解压、按帧写入 |
| `src/paths.ts` | 路径推导：`encodeSegment`、`projectKey`、`artifactPath` |
| `src/format.ts` | v4 行编解码与准入规则，含已知事件类型清单 |
| `src/write.ts` | 编码并落盘一个会话产物 |
| `tests/acp.ts` | 最小 ACP 客户端，用于驱动真实 DSH |
| `tests/corpus.ts` | 真实会话库的共享读取 |
| `tests/*.test.ts` | 单元 + 真实语料 + 端到端验收 |

## 测试

```
node --test "tests/**/*.test.ts"
```

端到端那条会启动真实 DSH、往隔离的 harness home 里写文件，默认跳过。
打开它需要四个环境变量：

```powershell
$env:DSH_CLI='F:\dsh\app\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_PROBE_HOME='F:\agent-continue\.agent-continue\probe\dsh-home'
$env:DSH_PROBE_PROFILE='probe-acp'
$env:DSH_PROBE_CWD='F:\agent-continue'
```

`DSH_PROBE_HOME` 必须是一个已用 `dsh <name> --from-default-profile acp` 初始化过的
探针 home，且与真实 `~/.dsh` 隔离。

## 已实测的格式事实

- 一个 artifact 由多个**独立可解**的 zstd 帧拼接而成；首帧只含 header 一行，
  之后每个 durable batch 一帧。Node 的一次性 zstd API 只解一帧，
  所以必须先结构化定位边界（`createZstdDecompress` 遇到拼接帧会直接报
  `Unknown frame descriptor`）。
- 真实语料（17 个 artifact、10700+ 条记录）：`seq` 全部等于 0 基索引，**零例外**。
- 事件信封在 v3 与 v4 之间**没有差异**，只有 header 键集不同。
- 我们由 header 反推出的路径与磁盘实际路径**逐个一致**（等价于 DSH 的
  `assertStoredIdentity` 校验）。
- 端到端：手写产物能被真实 DSH `session/list` 列出并 `session/resume` 打开。

