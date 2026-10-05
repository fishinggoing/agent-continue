# Agent Continue

一个 **Go 编程工作台与原生会话迁移 CLI**。浏览器工作台支持模型对话、上传代码、审批文件修改、查看差异、保存和继续对话，以及独立用户访问。Go 可执行文件内嵌整个网页，运行不依赖 Node.js。

Codex / DeepSeek Harness（DSH）原生会话迁移作为接续子功能保留，可在 CLI 或网页的“会话迁移”中使用。工作台默认采用暗色界面，右上角可切换浅色。

网络、凭据、用户隔离和存储要求见 [SECURITY.md](SECURITY.md)。后续 CLI 设计见 [AI CLI 开发工作清单](AI-CLI-开发工作清单.md)；清单包含尚未交付的规划，不作为当前命令列表。

## 当前功能与边界

| 范围 | 当前状态 |
|---|---|
| 浏览器工作台 | 模型流式对话、历史恢复、多轮继续、取消任务、上传文件、修改审批、差异查看及下载 |
| 模型接口 | DeepSeek Chat Completions 与 OpenAI Responses 协议；管理员配置共享模型密钥，普通用户无法读取或修改密钥 |
| 用户与安全 | 独立用户访问码、会话所有权检查、登录撤销、CSRF/XSS 防护、登录限流及资源限额 |
| 文件工具 | 仅操作服务端为任务创建的独立文件目录；修改需审批，不执行任意 shell 命令 |
| 规则测试 | 内置定价样例的四项规则测试；上传的任意项目尚无通用测试执行器 |
| CLI | `inspect`、`migrate`、`install`、`serve`，以及 `config`、`models list`、`doctor`、`version`；独立 `chat`、`run`、`resume` 命令尚未提供 |
| 部署 | 提供 Docker、systemd 和 HTTPS 代理模板；上传源码不代表已部署或验证目标服务器 |

运行时保存任务和对话至 SQLite。服务重启后，进行中的任务标记为中断；待审批工具不会自动执行，未知结果须先核实。API Key 与对话未加密存储，应按安全文档保护数据目录。

## 工作台使用流程

1. 构建并启动 `serve`，在浏览器打开工作台。
2. 在“模型与连接”中配置模型和 API Key；对外服务使用管理员访问码登录。
3. 新建任务，输入问题或上传 UTF-8 文本、代码文件。
4. 查看工具调用；允许或拒绝文件修改，检查实际差异并下载文件。
5. 从侧栏恢复历史对话并继续；需要跨工具接续时进入“会话迁移”。
6. 多人使用时由管理员创建各自的用户访问码，需要时撤销其访问。

模型密钥由管理员配置并用于服务的模型调用，当前没有每用户独立模型密钥存储。每个人使用独立访问码，不应向普通用户分发管理员访问码。

网页只能操作上传文件的服务端副本，不直接访问访问者电脑上的任意路径，也不提供自动工程同步。

## 启动编程工作台

已有可执行文件时，在 Windows PowerShell 中运行：

```powershell
.\dist\agent-continue.exe serve --listen 127.0.0.1:8080
```

打开 <http://127.0.0.1:8080/>。本机回环访问可以不设访问码。建议用 `AGENT_CONTINUE_DATA_DIR` 指定独立的私有数据目录；未设置时使用系统用户配置目录下的 `agent-continue/workbench`。默认模型为 DeepSeek，也可在设置中选择 Responses 模型。

对外访问必须配置至少 24 字符的随机私密 `AGENT_CONTINUE_TOKEN`，并使用 HTTPS 反向代理。可信代理通过 `AGENT_CONTINUE_TRUSTED_PROXIES` 指定精确来源 CIDR；默认不信任代理头。不要把应用的 HTTP 端口直接开放到公网。

浏览器使用可撤销、有效期 12 小时的 HttpOnly Cookie。密钥及访问码不写入浏览器本地存储；主题偏好可以保存在本地存储中。管理员 API Key 不会出现在设置响应、会话快照或导出中。

### 会话迁移

从侧栏打开“会话迁移”：

1. 上传 Codex 的 `rollout-*.jsonl`，或 DSH 的 `session.v3/v4.jsonl.zstd`。
2. 检查来源记录和未决工具，填写目标机器上的工程绝对路径。
3. 预览损失报告，转换并下载原生会话和 JSON 报告。
4. 在目标机器使用 `install` 导入，再由目标工具列出和恢复会话。

迁移页面的目标目录支持 Windows 与 Linux；服务器无需拥有该目录。迁移上传文件仅在请求内存中处理，不保存到任务会话库。迁移 Web 限制为上传 16 MiB、解压后 32 MiB、最多 100,000 条记录、JSON 深度 256 和整个会话 1,000,000 个 JSON token；更大文件使用本地 CLI。

编程任务上传另有边界：最多 32 个 UTF-8 文件、单文件 64 KiB、合计 512 KiB；不接收二进制文件。

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

## 部署模板

以下配置用于当前工作台。Compose 使用独立持久卷，systemd 使用私有状态目录；程序文件系统可保持只读。工作台的文件工具限定在各任务的服务端副本中，不运行任意宿主命令。

提供 Docker Compose 和 Linux 可执行文件两种方式。实际发布需要目标服务器、域名及访问方式；本地构建和测试不代表已发布到远端。

源码仓库不包含本地构建产物、密钥或对话。按上面的构建命令生成目标平台的可执行文件；运行程序不需要编译工具。

### Docker Compose

服务器安装 Docker Compose，将仓库放入独立应用目录，创建不纳入 Git 的 `.env`：

```dotenv
AGENT_CONTINUE_TOKEN=替换为至少24字符的随机私密令牌
AGENT_CONTINUE_TRUSTED_PROXIES=替换为实际代理来源CIDR
TZ=Asia/Shanghai
```

限制配置文件权限后启动：

```sh
chmod 600 .env
docker compose up -d --build
curl --fail http://127.0.0.1:8080/healthz
```

`compose.yaml` 将端口绑定到服务器 `127.0.0.1:8080`，使用非 root 用户、只读文件系统和 `workbench-data` 状态卷，限制 2 GiB 内存和两个 CPU。代理 CIDR 应为实际连接容器的精确来源地址；不要信任整个公网或容器网段。构建上下文只包含 Go 模块、源码与嵌入网页，不打包用户会话、凭据或第三方研究目录。

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

`deploy/install-demo.sh` 是另一种 systemd 安装入口：使用前将 Linux 可执行文件以 `agent-continue-linux-amd64` 命名，与该脚本及服务模板放在同一目录。Nginx 模板提供 `/ac/` HTTPS 入口；先配置有效证书和可信代理，再开放访问。详细边界见 [SECURITY.md](SECURITY.md)。

## 代码结构与语言选择

| 路径 | 职责 |
|---|---|
| `cmd/agent-continue/` | Go 命令入口、JSON 输出与 HTTP 启动 |
| `internal/migrate/` | 格式、压缩帧、曲面、工具生命周期、字段映射和损失 |
| `internal/app/` | CLI / HTTP 共用流程、安装与 Codex 注册 |
| `internal/server/` | HTTP、Cookie 认证、CSRF、可信代理、用户所有权及资源限制 |
| `internal/server/web/` | 内嵌 HTML、CSS 和浏览器 JavaScript |
| `internal/provider/` | DeepSeek 与 Responses 流式模型接口、凭据反射防护 |
| `internal/task/` | 对话、Agent 循环、独立文件副本、修改审批及任务恢复 |
| `internal/session/` | SQLite 状态和用户存储、Unix 私有文件权限 |
| `deploy/` | HTTPS 代理和 Linux 服务配置 |
| `packages/` | 原 TypeScript 实现及验收用例，保留作开发期比较基准 |
| `scripts/` | Go 辅助脚本、比较语料导出、旧验收到 Go 的桥接 |

此版本采用 **Go CLI / Agent 后端 + 浏览器 Web 前端**。浏览器 JavaScript 由浏览器执行，不需要 Node 服务。

Go 依赖版本与校验固定在 `go.mod` / `go.sum`；Lucide、Marked 与 DOMPurify 的授权文件随内嵌资源保留。主题参考 `dsh-skins` 中 `whale-fantasy` 的暗色、细线与状态提示，使用本仓库独立实现的样式。

## 验证

2026-10-05 实测：完整 Go 测试及 `go vet` 通过。安全浏览器回归验证用户创建与撤销、跨用户会话拒绝、XSS 清理及退出后的 Cookie 重放；主题浏览器回归验证五种视口、67 个布局状态、深浅切换、审批和规则测试、迁移、长文本、禁用存储与初始登录限流。浏览器回归只使用合成凭据和内容。

Go 测试覆盖两向转换、28 份旧实现对照语料、压缩帧、拒绝覆盖、SQLite 注册、安装、HTTP 鉴权、上传资源边界及模型/标题传递。比较语料使用合成内容，随机 UUID 按关系和语义比较。

2026-10-05 前一轮实测：Windows 与 WSL Ubuntu 的 Go 测试均通过，`go vet` 无诊断；Linux 可执行文件的 `/healthz` 和 HTTP 转换规划接口通过。浏览器实际验证了两向上传、检查、预览、下载和导入命令。Docker Compose 配置校验通过，本机 Docker 引擎不可用，镜像构建与容器启动尚未实测。远端 HTTPS 发布与 systemd 启动待服务器环境验证。该段为前一轮迁移专项验证记录。

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
