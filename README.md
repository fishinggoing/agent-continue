# Agent Continue

目标是一个 **能对话、调用模型、读取和修改工程、执行测试、保存并恢复任务的 AI 编程 CLI**。Go 负责命令行和 Agent 运行时，浏览器网页操作同一套任务服务。发布程序和服务器运行不依赖 Node.js。

**方向确认于 2026-10-05：** 用户明确选择将本项目扩展为能执行编程任务的 AI CLI。现有 Codex / DeepSeek Harness（DSH）原生会话迁移作为接续子功能保留。网页后续围绕任务、对话、工具执行、审批和代码修改展开。

详细实施任务、依赖、文件分工及验收标准见 [AI CLI 开发工作清单](AI-CLI-开发工作清单.md)。清单中的新命令、模块和接口均为待开发设计。

## 当前状态与目标的区别

| 范围 | 当前状态 |
|---|---|
| GitHub `main` | [README](https://github.com/fishinggoing/agent-continue/blob/50a8da9f28a41809554501868483efac144ccfb8/README.md) 定义的是原生会话迁移 CLI；2026-10-05 核对远端 HEAD 为 `50a8da9` |
| 本地 Go 工作区 | 已有 `inspect`、`migrate`、`install`、`serve`，迁移与安装功能已有验证；Go 新文件目前尚未提交 |
| 现有网页 | 上传、检查、转换、下载的迁移页面；需改造成 AI 任务操作入口 |
| AI 编程运行时 | 尚未实现模型客户端、Agent 循环、文件编辑工具、命令执行、运行权限和自身任务恢复 |
| 实际服务器发布 | 尚未完成，服务器地址、域名、模型提供方及部署工作区待实施方配置 |

**迁移测试通过只证明接续子系统；不代表 AI 编程 CLI 已可用。** 当前 `dist/` 内的二进制和压缩包仍是迁移版本，不能作为新 AI CLI 交付。

## 目标使用流程（待实现）

1. 配置模型提供方、凭据引用、工作区和工具权限。
2. 在工程目录启动交互会话，或通过 `run` 提交一项编程任务。
3. Agent 调用模型，按权限读取和修改文件、执行测试，持续显示进度及修改结果。
4. 中断后通过会话 ID 恢复；结果未知的工具先核实，不自动重跑。
5. 浏览器操作同一套运行时，查看对话、工具结果、待审批操作和代码差异。
6. 需要跨工具接续时使用保留的原生迁移能力。

上述 `chat`、`run`、`resume` 等 Agent 命令尚不存在。开发顺序是先完成可用 CLI，再接网页和服务器部署，详见工作清单。

编程工具操作的是 CLI 所在机器的工程，或已配置的服务器工作区。网页不能直接访问访问者电脑上的任意路径；本机到服务器的工程同步不在首版默认流程中。

## 现有迁移页面（过渡功能）

已有可执行文件时，在 Windows PowerShell 中运行：

```powershell
.\dist\agent-continue.exe serve --listen 127.0.0.1:8080
```

打开 <http://127.0.0.1:8080/>。当前显示的仍是迁移页面；“试用合成示例”只演示接续子功能。

1. 上传 Codex 的 `rollout-*.jsonl`，或 DSH 的 `session.v3/v4.jsonl.zstd`。
2. 检查来源记录和未决工具，填写目标机器上的工程绝对路径。
3. 预览损失报告，转换并下载原生会话和 JSON 报告。
4. 在目标机器使用 `install` 导入，再由目标工具列出和恢复会话。

网页的目标目录支持 Windows 与 Linux；服务器无需拥有该目录。上传文件仅在请求内存中处理，不保存到服务器会话库。Web 限制为上传 16 MiB、解压后 32 MiB、最多 100,000 条记录、JSON 深度 256 和整个会话 1,000,000 个 JSON token；更大文件使用本地 CLI。

外部访问需要至少 24 字符的 `AGENT_CONTINUE_TOKEN`，网页“访问设置”填入相同令牌。令牌只保留在当前页面内存。对外部署使用 HTTPS 反向代理。

## 构建

开发需要 Go 1.26 或更新版本。浏览器文件直接嵌入 Go 可执行文件，无 npm 安装或前端构建步骤。

```sh
go mod download
go test ./...
go vet ./...
go build -trimpath -o dist/agent-continue ./cmd/agent-continue
```

Windows 输出可用 `dist/agent-continue.exe`。PowerShell 辅助脚本将缓存和临时目录放在忽略的 `.agent-continue/` 下，优先使用已安装的 Go，也支持本地便携工具链：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/go.ps1 test ./...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/go.ps1 build -trimpath -o dist/agent-continue.exe ./cmd/agent-continue
```

交叉构建 Linux x86-64：

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o dist/agent-continue-linux-amd64 ./cmd/agent-continue
```

Linux 构建使用纯 Go SQLite 与 Zstandard，不依赖 Node、外部 SQLite CLI、Zstandard CLI 或 C 编译器。

## 已实现的接续 CLI 命令

以下示例使用 Linux 可执行文件名；Windows 将 `./agent-continue` 替换为 `.\dist\agent-continue.exe`，路径替换为本机绝对路径。

### 检查

```sh
./agent-continue inspect --from codex --input rollout.jsonl
./agent-continue inspect --from dsh --input session.v4.jsonl.zstd
```

只读检查，不输出消息正文或工具参数。CLI 来源文件上限 128 MiB，DSH 解压后上限 256 MiB。

### Codex → DSH

```sh
./agent-continue migrate --from codex --input rollout.jsonl \
  --cwd /home/me/project --target-home /home/me/dsh-home --dry-run
```

检查报告后移除 `--dry-run` 写入目标。DSH 会话按目标目录和会话 ID 写入原生存储路径。

### DSH → Codex

```sh
./agent-continue migrate --from dsh --input session.v4.jsonl.zstd \
  --cwd /home/me/project --target-home /home/me/codex-home \
  --cli-version 0.160.0 --model-provider openai \
  --model my-model --title '迁入的会话' --dry-run
```

`--cli-version`、`--model-provider` 在此方向必填，按目标工具实际版本和配置填写；`--model`、`--title` 选填。目标 Codex home 必须事先由 Codex 初始化 `state_5.sqlite`；注册表结构不匹配会拒绝写入，不复制或猜测结构。写入会同时生成 rollout 并注册线程。

### 导入网页下载的原生产物

`install --from` 填下载产物所属工具。例如 Codex → DSH 网页转换后填 `dsh`：

```sh
./agent-continue install --from dsh --input session.v4.jsonl.zstd \
  --cwd /home/me/project --target-home /home/me/dsh-home --dry-run
```

导入 Codex 产物时保留网页显示的模型与标题参数：

```sh
./agent-continue install --from codex --input rollout-downloaded.jsonl \
  --cwd /home/me/project --target-home /home/me/codex-home \
  --model my-model --title '迁入的会话' --dry-run
```

`--cwd` 必须与产物中的目标目录相符，导入不会重新跨工具转换。确认后移除 `--dry-run`。本地工程目录必须存在；相同 ID 或路径拒绝覆盖。

### 参数与报告

`migrate` 还支持 `--id <UUID>` 指定目标 ID，省略时随机生成。`help` 显示用法。除 `help`、长期运行的 `serve` 外，stdout 输出 JSON；错误输出 stderr JSON，退出码为 1。

| 字段 | 含义 |
|---|---|
| `status` | CLI 为 `planned` / `written`，网页转换为 `converted` |
| `pendingOperations` | 结果未知的工具调用，恢复前核实实际执行状态 |
| `tallies` / `losses` | 各类记录的映射、丢弃数量与原因 |
| `toolsExecuted` / `modelRequests` | 转换与安装过程为 0 |
| `nativeValidation` | `not-run`，转换成功不会冒充目标工具恢复验收 |
| `target` / `output` | 目标 ID、目录、注册选项和实际产物位置 |

子代理或带 `parentSession` 的 DSH 来源、损坏来源、不完整压缩尾帧、无法解释的当前曲面、非法目录、重复 ID 或文件均会拒绝。压缩后的会话按当前有效曲面迁移，不带回已被替换的旧正文。已完成、并行、交错和未完成工具调用沿用原有映射契约，未知结果不写成成功。

## 现有迁移服务的部署模板

以下配置用于当前迁移版本。新 AI CLI 需要增加明确可写的工程目录、独立持久会话目录、模型配置和工具执行隔离，完成工作清单中的部署验收后才能上线。当前 Compose 的只读文件系统没有工程及状态卷，systemd 也没有配置任务所需的可写目录。

提供 Docker Compose 和 Linux 可执行文件两种方式。实际发布需要目标服务器、域名及访问方式；本地构建和测试不代表已发布到远端。

本次构建另提供 `dist/agent-continue-linux-amd64.tar.gz`，包含 Linux 可执行文件、Go 源码、内嵌网页和部署配置，可直接传到服务器解压。运行程序不需要编译工具；选择在服务器构建镜像时使用包内的 Dockerfile。

### Docker Compose

服务器安装 Docker Compose，将仓库放入独立应用目录，创建不纳入 Git 的 `.env`：

```dotenv
AGENT_CONTINUE_TOKEN=替换为至少24字符的随机私密令牌
TZ=Asia/Shanghai
```

限制配置文件权限后启动：

```sh
chmod 600 .env
docker compose up -d --build
curl --fail http://127.0.0.1:8080/healthz
```

`compose.yaml` 将端口绑定到服务器 `127.0.0.1:8080`，使用非 root 用户、只读文件系统，限制 2 GiB 内存和两个 CPU。最多并行处理两个检查或转换请求，繁忙时返回 429。构建上下文只包含 Go 模块、源码与嵌入网页，不打包用户会话、凭据或第三方研究目录。

把 `deploy/Caddyfile` 的示例域名换成实际域名，用服务器上的 Caddy 代理至 `127.0.0.1:8080`。域名 DNS 指向服务器且 HTTPS 端口可访问后，按 Caddy 的配置流程启用该文件。

### Linux 可执行文件与 systemd

先创建服务用户 `agent-continue` 和 `/opt/agent-continue` 目录。在 `/etc/agent-continue.env` 配置令牌和时区，权限设为 600，再使用 `deploy/agent-continue.service`：

```sh
sudo install -m 755 dist/agent-continue-linux-amd64 /opt/agent-continue/agent-continue
sudo install -m 644 deploy/agent-continue.service /etc/systemd/system/agent-continue.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-continue
curl --fail http://127.0.0.1:8080/healthz
```

服务只监听回环地址，由 HTTPS 代理对外提供网页。服务器无需访问用户的 Codex 或 DSH home，本地 `install` 负责会话库写入。

## 代码结构与语言选择

| 路径 | 职责 |
|---|---|
| `cmd/agent-continue/` | Go 命令入口、JSON 输出与 HTTP 启动 |
| `internal/migrate/` | 格式、压缩帧、曲面、工具生命周期、字段映射和损失 |
| `internal/app/` | CLI / HTTP 共用流程、安装与 Codex 注册 |
| `internal/server/` | HTTP、访问令牌、上传资源限制 |
| `internal/server/web/` | 内嵌 HTML、CSS 和浏览器 JavaScript |
| `deploy/` | HTTPS 代理和 Linux 服务配置 |
| `packages/` | 原 TypeScript 实现及验收用例，保留作开发期比较基准 |
| `scripts/` | Go 辅助脚本、比较语料导出、旧验收到 Go 的桥接 |

目标采用 **Go CLI / Agent 后端 + 浏览器 Web 前端**。浏览器 JavaScript 由浏览器执行，不需要 Node 服务。首版不要求 C++ 或 Rust；如以后增加 Rust 隔离执行组件，应先明确进程接口和验收指标，具体边界见工作清单。当前仓库没有 Rust 工程或 Rust 配置。

第三方运行依赖为 `klauspost/compress` 和 `modernc.org/sqlite`，版本与校验固定在 `go.mod` / `go.sum`；图标资源的授权文件随源码保留。

## 现有迁移功能的验证

Go 测试覆盖两向转换、28 份旧实现对照语料、压缩帧、拒绝覆盖、SQLite 注册、安装、HTTP 鉴权、上传资源边界及模型/标题传递。比较语料使用合成内容，随机 UUID 按关系和语义比较。

2026-10-05 前一轮实测：Windows 与 WSL Ubuntu 的 Go 测试均通过，`go vet` 无诊断；Linux 可执行文件的 `/healthz` 和 HTTP 转换规划接口通过。浏览器实际验证了两向上传、检查、预览、下载和导入命令。Docker Compose 配置校验通过，本机 Docker 引擎不可用，镜像构建与容器启动尚未实测。远端 HTTPS 发布与 systemd 启动待服务器环境验证。本轮只修正文档，未重新执行这些测试。

```sh
go test ./...
go vet ./...
```

开发期还可让原有 CLI 验收调用 Go 可执行文件。该测试工具需要 Node.js 24.12 或更新版本，应用运行与部署不需要 Node。以下 PowerShell 配置使用隔离 home 和合成会话，原生 CLI 路径按实际安装位置填写：

```powershell
$env:AGENT_CONTINUE_GO_CLI = (Resolve-Path dist/agent-continue.exe).Path
$env:AGENT_CONTINUE_CODEX_CLI = '<codex.exe 的实际绝对路径>'
$env:AGENT_CONTINUE_DSH_CLI = '<dsh 启动器的实际绝对路径>'
New-Item -ItemType Directory -Path .agent-continue/native-tests -Force | Out-Null
$env:AGENT_CONTINUE_NATIVE_ROOT = (Resolve-Path .agent-continue/native-tests).Path
node --import ./scripts/go-cli-hook.mjs --test 'packages/cli/tests/*.test.ts'
```

2026-10-05 本机实测：上述 CLI 套件 **66 通过、0 失败、0 跳过**，含原有 64 项及新增 2 项 Go 原生安装验收，Codex 0.160.0 和 DSH 0.2.0-rc.2 参与验证。桥接替换测试中的 `execute` 调用；旧 TypeScript 入口测试及测试辅助程序仍保留，不能将 66 项全部称为 Go 二进制入口测试。新增安装验收确认 DSH 目录尾斜杠及 `.`/`..` 规范化后可原生列出和恢复，Codex 下载导入后模型、标题及分页历史可用。未配置原生 CLI 时相应用例会跳过，跳过不计为通过。模型续跑验收使用固定响应的本地测试服务，未请求付费模型。

原有 DSH 原生行为依据和历史记录保留在 `docs/HANDOFF.md`、`docs/DEFECTS.md`。新实现沿用这些判据，不将转换成功当作原生恢复成功，不自行放宽会话资格或当前曲面规则。
