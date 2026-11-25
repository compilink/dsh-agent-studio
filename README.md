# DSH Agent Studio · Phase 3

基于 DeepSeek Harness 的独立多 Agent Web 原型。项目位于 DSH 仓库之外，通过公开包入口组合原生 Agent、Session、模型与工具；Studio 负责组织、Task/Attempt 和 SQLite 持久调度，不修改 DSH 源码。

本阶段支持向执行中的协作追加独立任务：资源允许时使用另一 Worker 并行，否则持久排队；同一成员的模型回合串行，新任务不会取消或替换当前任务。SQLite 三层记忆始终启用；显式配置可信本地镜像后，Worker 可在隔离容器中执行 Shell/代码及文件读写，未启用容器时仍使用无副作用探针。外部网络和动态工具安装没有开放。默认演示模型是本项目的确定性离线适配器，模型调用经过真实 DSH Agent loop，但不代表真实模型推理结果。

## 启动

需要 Node.js 22.19 或更新的 22.x，或 Node.js 24 及以上；Node.js 23 不符合 DSH 的引擎要求。还需要一份已具备 `lib/` 和依赖的 DSH 本机构建。本项目的 bootstrap 不会安装网络依赖或构建 DSH。

在独立项目的根目录执行，将示例路径替换为自己的 DSH 构建目录。

```sh
node --version
DSH_ROOT=/path/to/deepseek-harness npm run bootstrap
npm run demo -- --port 4317
```

打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。`demo` 会先编译，并关闭 DSH home 模型导入，即使环境中存在 `DSH_HOME`。首次启动建立三个演示模板：Orchestrator、Manager、Worker；在「Agent 配置」中分别编辑名称、system prompt、模型和该模型支持的推理等级，再创建任务。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 编译到 `dist/src/` 与 `dist/tests/` |
| `npm run start -- --port 4317` | 启动已编译的 Web 服务 |
| `npm run demo -- --data-dir .studio-demo` | 使用指定数据目录启动离线演示 |
| `npm run compatibility` | 校验 DSH 构建指纹与公开导出 |
| `npm run check` | 兼容性校验、编译与本地测试 |
| `npm run check:bundle` | 编译并验证 Bundle 生命周期与离线打包 |
| `npm pack` | 先编译，再生成外部 Bundle tarball |

Web 服务只监听 `127.0.0.1`；写请求需要页面取得的 CSRF token。默认数据目录为当前工作目录下的 `.studio`，可用 `--data-dir` 或 `STUDIO_DATA_DIR` 指定。用 `Ctrl+C` 停止服务。一个数据目录同一时间只允许一个运行实例。

要观察执行中追加和并发，可在演示 Worker 每个回合的首次探针请求前增加延迟，并限制全局 Worker 容量：

```sh
STUDIO_MAX_WORKERS=2 STUDIO_DEMO_DELAY_MS=6000 npm run demo -- --port 4317 --data-dir .studio-phase2-demo
```

启动参数均在加载时校验，非法值拒绝启动。环境变量作用于 CLI；Bundle 使用对应的 `scheduler` 配置和 `demoDelayMs`。

| CLI 环境变量 | Bundle 配置 | 默认值与范围 |
| --- | --- | --- |
| `STUDIO_MAX_WORKERS` | `scheduler.maxActiveWorkers` | 4，整数 1–24；跨所有 Run 的活跃 Worker 上限 |
| `STUDIO_POLL_INTERVAL_MS` | `scheduler.pollIntervalMs` | 50 ms，整数 10–60,000 |
| `STUDIO_MAX_DELIVERY_ATTEMPTS` | `scheduler.maxDeliveryAttempts` | 3，整数 1–20；失败投递的自动尝试预算 |
| `STUDIO_RETRY_DELAY_MS` | `scheduler.retryDelayMs` | 500 ms，整数 10–60,000；自动退避的初始间隔 |
| `STUDIO_DEMO_DELAY_MS` | `demoDelayMs` | 0 ms，整数 0–60,000；仅确定性演示 Worker |

## 复用已配置的 DSH 模型

先编译，再明确指定现有 DSH home：

```sh
npm run build
STUDIO_DSH_PROFILE=web npm run start -- --dsh-home /path/to/dsh-home --data-dir .studio-live
```

也可以通过 `STUDIO_DSH_HOME` 或 `DSH_HOME` 指定目录。导入后，现有模板不会自动切换到真实模型；需在界面中选择导入的模型并保存，然后创建新任务。建议演示与真实模型使用不同数据目录。

导入器按顺序读取 `profiles/<profile>/cordis.patch.yml`、home 的 `cordis.patch.yml`，选取 ID 为 `llm-pi-ai` 和 `llm-deepseek` 的模型配置行，再交给 DSH 原生适配器和 settings 服务处理 `settings.yaml` 的对应命名空间。默认 profile 为 `web`。这里只导入模型配置，不加载 profile 的 Bundle 列表，不启动其他 Cordis 插件，也不执行 `!!js`。模型配置中的可执行表达式与非布尔 `disabled` 会被拒绝。

凭据通过只读 provider 解析环境变量、home 的 `.credentials.yaml` 和 `.env`。本项目不改写这些文件，也不刷新 OAuth 授权；需要刷新时，应在 DSH 完成后重试。可用在线模型验证脚本检查所选模型的实际工具调用。见[验证方法](docs/validation.md)。

启动时可以用 `STUDIO_ENDPOINT_OVERRIDES` 临时覆盖从 patch 导入的 pi-ai provider 地址，例如 `'{"local-ollama":"http://127.0.0.1:11434/v1"}'`。provider 必须已在 patch 的 `providers` 中声明，覆盖只作用于本次运行，不修改 DSH 文件；仅由 `settings.yaml` 声明的 provider 不支持这个覆盖入口。

## 追加任务、消息与执行状态

用户只向 Orchestrator 发消息。新建协作时，`direct` 强制 Orchestrator 直接派给 Worker；`hierarchical` 强制经过 Manager；`auto` 允许 Orchestrator 选择。离线模型中的自动选择是固定演示规则，用于验证调度路径。

1. 点击「新建协作」创建 Run、唯一的 Orchestrator 和第一项 Task；每个新 Run 使用新的 Session。
2. 在「任务与尝试」中查看业务状态、协调者、Worker、Attempt 历史、报告和错误。Worker 报告后先进入「待验收」，由协调者验收后才标记「已完成」。成员「待命」不等于任务完成。
3. 点击「追加独立任务」提交新工作，可选择当前 Run 中已有的 Manager。这个选择是提交给 Orchestrator 的路由要求，不建立用户到 Manager 的聊天入口。追加按钮在其他任务运行时仍可使用；资源不足时任务显示排队原因。
4. 在「Orchestrator 对话」发送补充消息。补充消息进入持久队列，不新建 Task；新目标应使用「追加独立任务」。
5. 「取消此任务」仅取消该 Task 的执行和相关投递；「停止全部」取消整个 Run 的工作。失败或受阻任务可点击「重试」，保留原历史；已完成的 Worker 报告在验收重试时不会被重新执行。

相同追加内容因网络错误重试时保留同一个 `requestId`，服务端返回已存在的 Task。相同 ID 携带不同内容会被拒绝。页面在当前标签页的 `sessionStorage` 暂存未确认提交，成功接收后清除；它不承担服务端队列持久化。

每个 Manager 只能委派自己执行组的 Worker，Worker 不能创建子 Agent。同一模板可以创建多个 Worker，一个 Worker 同时只承担一个活跃 Attempt；显式复用必须选取空闲成员。当前界面编辑已有模板，模型尚不能自行定义新模板；完整任务 DAG、产物验收和跨执行组工作流仍在后续范围。

模板保存会产生新版本。Agent 创建时保存自己的 system prompt、模型、推理等级与模板版本快照；修改模板不会改变现有 Agent。新 Run 建立新 Session；Run 内的现有协调者保留 Session，新 Worker 使用独立 Session。新建协作可以明确选择私有长期记忆的来源 Run；新成员使用新 Session。下级身份只有在委派时明确选择合法的历史直属成员才复用，不能因为模板相同而共享 Worker 私有记忆；未选来源的 Worker 使用新私有身份。

## 持久化与恢复

业务状态与待投递 Delivery 在同一 SQLite 事务提交；DSH 原生日志保存模型与工具历史。服务启动后自动调度未完成工作，不需要用户补发消息。受控关闭或进程中断后的 Worker 执行保留为 interrupted Attempt，恢复建立新 Attempt；已提交的报告继续交给协调者验收。用户主动取消的工作不会自动复活。

投递前核验 Session 历史和已提交业务状态，避免重复派工与重复验收。自动投递失败按预算退避，耗尽后留下可见错误；手动重试与传输重试不同。当前验证覆盖受控关闭、强制终止和关键事务位置，不保证任意崩溃点或未来文件/网络操作恰好执行一次。

数据库 schema 1/2 会在取得独占运行权后事务升级到 schema 3，保留旧 Run、成员、聊天和 Session；不会根据旧聊天虚构已验收 Task。未知版本拒绝启动。升级前先停止旧服务并整体备份数据目录；升级后的目录不交给旧版本程序打开。

本阶段固定上限为每 Run 24 个 Agent、累计 120 次模型请求、每 Agent 回合 12 步、每次请求最多 2,048 输出 token。任务和消息最多 8,000 字符，system prompt 最多 16,000 字符；达到 Run 预算后需新建协作。容器工作卷按 Attempt 隔离；当前没有共享代码分支合并、任务依赖图或跨进程调度器。

## 三层记忆与上下级权限

长期记忆保存跨协作方法论，分 private 和 public；中期记忆保存当前 Run 或 Task 的目标、约束与决策；短期记忆保存已核验进度、下一步和未确认副作用。Agent 通过 `studio_memory_list`、`studio_memory_read`、`studio_memory_write`、`studio_memory_publish`、`studio_memory_checkpoint` 自行读写。新条目默认私有；只有显式 publish 可以公开长期条目，公开条目的后续修订仍公开。更新必须携带当前 `expectedVersion`，防止旧上下文覆盖新记录。

| 调用者 | 私有记忆读取范围 | 写入范围 |
| --- | --- | --- |
| Orchestrator | 自身及当前 Run 所有后代 | 仅自身身份的记忆 |
| Manager | 自身及自己执行组的 Worker | 仅自身身份的记忆 |
| Worker | 仅自身 | 仅自身 |

公开长期记忆全员可读，只有所有者可以修改。目录、搜索、计数及正文都先按服务端真实身份授权，模型不能传入另一个 actor 或身份取得权限。跨 Run 复用身份只延续长期记忆；中短期保留在原 Run/Agent。系统不会按模板自动合并不同 Worker 的私有记忆。

Web 的「记忆」页使用当前 Run 的 Orchestrator 权限，只读列出可见摘要；点击条目才请求正文，每页可继续读取。工具目录默认 8 条、最多 20 条，摘要最多 240 字符，正文默认 2,000、最多 4,000 字符；单条正文最多 16,000 字符。全文不进入默认 Web 状态或活动列表，访问审计不记录正文。前台不提供冒充下级的记忆写入或直接聊天入口。

运行时只向 Agent 提供可见数量和最新检查点引用，正文仍由 Agent 按需读取。DSH 原生 TokenMeter/BasicCompaction 自动处理上下文压力和上下文溢出；压缩完成后写入可回放的同任务恢复引用。短期检查点不会替代数据库中的 Task/Attempt 状态，也不能证明未核验的代码已执行。下列 CLI 选项映射到 DSH 原生压缩配置，缺省值由原生组件校验；完整程序接口支持 `StudioOptions.compaction`。

| 环境变量 | 默认值 |
| --- | --- |
| `STUDIO_COMPACTION_AUTO` | `true`，可显式设 `false` |
| `STUDIO_COMPACTION_THRESHOLD` | `0.8`，模型上下文窗口比例 |
| `STUDIO_COMPACTION_RETAIN` | `0.16`，保留近期上下文比例 |
| `STUDIO_COMPACTION_MAX_TOKENS` | `8192`，摘要模型输出上限；独立于普通回合的 2,048 token 上限 |

## Worker 本地容器与成果

Docker Desktop / 本机 Linux Docker daemon 需要已启动。执行服务只接受本地 Unix socket 和已存在的不可变镜像 ID 或 `repository@sha256`；镜像需包含 `/bin/sh` 与 `/usr/local/bin/node`。模型不能修改镜像、挂载、Docker 参数或网络，应用运行时不会自动拉取镜像。若本机已有经过核验的 Node Alpine 镜像，可以取它的本地不可变 ID 启动。

```sh
STUDIO_CONTAINER_IMAGE="$(docker image inspect --format '{{.Id}}' node:24-alpine)" \
STUDIO_MAX_WORKERS=2 \
npm run demo -- --port 4317 --data-dir .studio-phase3-demo
```

该命令仍使用确定性 Demo 模型，但文件与代码工具在真实 Docker 中执行。启用后 Demo Worker 写入 `studio-demo.mjs`、执行 Node 程序、读取实际 `result.json`，保存检查点后报告。真实模型可在相同工具下自主编写任务代码；模板配置方式不变。精确匹配旧内置 Worker 提示词的默认模板会升级版本；自定义提示词和现有 Agent 快照保持不变，若自定义提示词仍限定 probe，需要自行更新模板后创建新成员。

每个 Attempt 使用独立持久工作卷；每次命令或文件操作创建新容器，完成后删除容器。取消、超时和输出超限会停止整个容器并等待退出，后台进程不能继续保留。Worker 使用 uid 1000、只读根文件系统、移除全部 capability、no-new-privileges 和关闭网络；没有宿主目录、记忆数据库、Session、凭据或 Docker socket 挂载。文件工具拒绝绝对路径、父目录逃逸、符号链接和非普通文件。配置选项由宿主决定，Bundle 使用相同名称的 `execution` 字段。

| CLI 环境变量 | `execution` 字段 | 默认值与范围 |
| --- | --- | --- |
| `STUDIO_CONTAINER_IMAGE` | `enabled: true` / `image` | 未设置时禁用容器 |
| `STUDIO_EXEC_TIMEOUT_MS` | `timeoutMs` | 30,000 ms，100–300,000 |
| `STUDIO_EXEC_OUTPUT_BYTES` | `maxOutputBytes` | stdout/stderr 合计 65,536 bytes，1,024–1,048,576 |
| `STUDIO_EXEC_FILE_BYTES` | `maxFileBytes` | 文件工具写入 65,536 bytes，1,024–1,048,576 |
| `STUDIO_EXEC_MEMORY_MB` | `memoryMb` | 256 MB，64–4,096 |
| `STUDIO_EXEC_CPUS` | `cpus` | 1，0.1–8 |
| `STUDIO_EXEC_PIDS` | `pidsLimit` | 64，16–512 |

Attempt 结束后，可在任务详情点击「查看文件」，浏览目录并分页读取 UTF-8 成果；运行中的 Attempt 不开放成果读取，避免浏览占用执行资源。Web 没有远程命令或写文件接口。重试使用新工作卷，旧成果保留，不宣称外部副作用恰好执行一次。宿主已有仓库尚不自动导入或挂载，当前文件由 Worker 在授权工作区生成；此默认隔离避免把宿主敏感路径交给执行代码。

命名工作卷跨容器及应用重启保留，删除 SQLite 数据目录不会自动删除 Docker 卷。数据目录备份只覆盖编排、记忆和日志，容器成果卷需要另行导出；卷的所属应用由数据目录绝对路径派生，移动数据目录时需要单独迁移对应卷关联。应用只清理自己数据目录标签下的遗留容器，不清理成果卷或其他服务。需要归档/删除卷时，先确认对应 Run/Attempt 不再使用并自行导出成果；不要对共享 Docker daemon 执行全局 prune。本阶段没有工作卷总磁盘配额，`maxFileBytes` 不限制 Shell 的累计磁盘写入量。外部网络、可信源动态工具安装和更强执行环境仍是后续范围。

## 数据与依赖

`.studio/studio.sqlite` 保存模板、Run、Task、Attempt、Delivery、成员配置、对话投影、活动记录及运行实例占用信息；`.studio/sessions/` 保存 DSH 原生日志。`memories`、`memory_revisions` 和 `memory_audit` 分别保存当前记忆、不可变修订和访问审计。需要备份时先停止服务，再整体复制数据目录；不要只复制运行中的 SQLite 主文件而漏掉 WAL。

`bootstrap` 在本项目的 `node_modules` 创建符号链接，复用 DSH 已有的公开构建包及本地开发依赖；不修改链接目标。所有 DSH 导入都走公开包入口，不使用源码路径或 testkit。`compatibility.json` 记录依赖包版本和构建产物 SHA-256，用于核对运行所需的包。

后续 DSH 升级造成校验不符时，先检查兼容性；`npm run bootstrap -- --record` 会重新记录当前构建指纹，只应在确认并重新验证后使用，不要用它跳过不兼容错误。

包提供标准 `dsh.bundle` 声明与 `cordis.patch.yml`。Bundle 启动自己的 DSH runtime 和 Web 服务，并在宿主插件卸载时关闭；它不共享宿主 profile 的 Agent registry 或会话。当前验证覆盖真实 Cordis 插件生命周期、npm tarball 解包与本地依赖启动；完整 `dsh plugin --profile ...` 安装流程需要另行验证。

实现分工与后续阶段见 [架构说明](docs/architecture.md)。运行检查和视频试点的用法见[验证方法](docs/validation.md)与[视频制作流程](docs/video-production-pilot.md)。

开发时请先[启用提交和推送前检查](docs/commit-checks.md)。
