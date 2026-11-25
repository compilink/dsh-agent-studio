# DSH Agent Studio

基于 DeepSeek Harness 的本地多 Agent 工作台，支持分层委派、可视化任务流程、人工审核、三层记忆与隔离执行。

一次协作由一个 Orchestrator 接收目标。它可以直接委派给 Worker，也可以把工作拆给多个 Manager，由各组 Worker 执行。开始执行后仍可追加独立任务，调度器按可用容量并行或排队。

## 先跑一次离线协作

准备 Node.js 22.19 以上的 22.x 或 Node.js 24 及以上，以及一份已经构建、包含依赖和公开包产物的 DeepSeek Harness 源码目录。在本仓库根目录运行以下命令。

```sh
DSH_ROOT=/path/to/deepseek-harness npm run bootstrap
npm run demo -- --port 4317 --data-dir .studio-demo
```

打开[本机 Agent Studio](http://127.0.0.1:4317)，选择「新建协作」，输入一个目标。在「任务与尝试」里可以跟踪分派与验收、查看会话事件，以及导出已完成的结果。离线演示使用确定性模型，可以验证操作和调度，不消耗模型额度。

## 按工作方式选择入口

| 入口 | 可以完成的工作 |
| --- | --- |
| Agent 配置 | 复制角色模板，选择模型和推理等级，设置委派范围、绑定 Skill，按需授予 Worker 公开网络权限。 |
| 任务流程 | 拖动节点、连接依赖、发布模板版本。节点交付后可人工调整并放行，也可重跑指定环节。实例沿用启动时选择的版本。 |
| 任务与尝试 | 追加、暂停、恢复或取消任务，查看每次尝试、子任务和投递历史。已验收结果可导出为 Markdown 或 Word。 |
| 记忆与 Skill | Agent 按需读取长期方法、任务记忆和恢复检查点。Skill 正文按绑定版本读取，权限由宿主单独管理。 |
| Worker 执行 | 配置可信镜像后，Worker 可在隔离容器内运行代码和读写文件。公开网页检索由宿主代理，可选择和撤销。 |

在离线演示中，要试一次并行拆分，可以在「新建协作」中选择自动模式，按下面的格式输入任务。运行后展开父任务和各分工的历史，查看各自的 Worker 报告。

```text
并行拆分：
整理交付清单
起草验收要点
```

流程可以给节点上传独立输入文件、在执行和放行前检查规则。人工修改后，下游收到批准稿，历史轮次仍可下载。使用真实模型时，可以让当前协作的 Orchestrator 查看进度、启动已发布流程，或在同一画布提出草稿供发布。[任务流程指南](docs/workflows.md) · [通过对话管理流程](docs/workflow-chat.md)

## 接入已配置的模型

```sh
npm run build
npm run start -- --dsh-home /path/to/dsh-config --data-dir .studio-live --port 4317
```

在「Agent 配置」中刷新 DSH 模型目录、测试模型响应，再保存模板。接入 DSH 时，模型列表只显示其实际配置。如果沿用了离线演示的角色模板，请为使用的角色选择真实模型。模板更新适用于新建成员。每个成员使用独立的 DSH Session，任务、流程版本、记忆和调度状态保存在本地 SQLite。

## 开发与部署

- `npm run check` 校验 DSH 依赖、编译 TypeScript 并运行测试。[提交与推送前检查](docs/commit-checks.md)
- Docker 启动、数据目录与模型接入见[部署指南](docs/docker.md)。宿主直接运行和 Bundle 的配置见[运行手册](docs/runtime-guide.md)。
- [架构与数据模型](docs/architecture.md) · [验证方法](docs/validation.md) · [选题研究模块](topic-discovery/README.md) · [视频制作试点](docs/video-production-pilot.md)。

需要管理作品、分集稿、原文批注和剧本交付时，可使用独立的 [DSH 剧本工作台](https://github.com/compilink/dsh-drama-workbench)。两者使用各自的数据目录。
