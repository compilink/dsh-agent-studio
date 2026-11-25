# 验证方法

先按项目 README 选择符合要求的 Node 版本，从已构建的 DSH 目录运行 bootstrap。下列命令在 Studio 项目根目录执行。

```sh
npm run check
npm run check:bundle
```

`check` 校验依赖兼容性、编译 TypeScript，并运行本地测试。测试使用临时数据目录和确定性演示适配器，覆盖任务追加与幂等、并发与恢复、模板快照、记忆访问范围和 HTTP 接口。容器集成用例需要显式提供镜像。Bundle 测试还检查插件装载、卸载和打包内容。

## 使用自己的容器或模型验证

如需验证真实容器，请先准备一个可信的本地 Docker 镜像，其中包含 `/bin/sh` 和 `/usr/local/bin/node`。将该镜像的不可变 ID 或仓库摘要填入 `STUDIO_TEST_DOCKER_IMAGE`，再执行以下命令。

```sh
npm run build
node scripts/container-smoke.mjs
```

脚本检查文件读写、代码执行、容器隔离、取消和超时，以及重启后能否读取同一 Attempt 的产物。临时工作卷由测试标识区分。运行报告可能含本机环境信息，应保存在仓库外，或在被忽略的 `evidence/` 目录内。

需要测试在线模型时，显式设置 `STUDIO_DSH_HOME`、`STUDIO_LIVE_PROVIDER` 和 `STUDIO_LIVE_MODEL` 后运行 `node scripts/live-smoke.mjs`。同时配置镜像后，可另行运行 `node scripts/live-execution-smoke.mjs`，验证 Worker 的模型工具调用、记忆和代码执行。这些脚本会向选定的模型服务发送测试请求。

## 视频质检

视频单元测试使用人工构造的轨道与时间数据，覆盖异常多音轨、音频不足和完整覆盖等判断。要检验具体文件，在装有 Swift 和 AVFoundation 的 macOS 上编译项目并运行 `node scripts/check-video.mjs /path/to/video.mp4`。技术检查报告提供文件摘要和检测结果，人工审片决定绑定对应的文件摘要。
