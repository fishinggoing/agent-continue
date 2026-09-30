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
| `tests/zstd.test.ts` | 帧容器自洽测试 + 对真实 DSH artifact 的解码测试 |

## 已实测的格式事实

- 一个 artifact 由多个**独立可解**的 zstd 帧拼接而成；首帧只含 header 一行，
  之后每个 durable batch 一帧。Node 的一次性 zstd API 只解一帧，
  所以必须先结构化定位边界（`createZstdDecompress` 遇到拼接帧会直接报
  `Unknown frame descriptor`）。
- 真实语料（17 个 artifact、10547 条事件记录）：`seq` 全部等于 0 基索引，
  **零例外**。
