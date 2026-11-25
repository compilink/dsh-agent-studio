# 在 Docker 中运行 Agent Studio

Compose 将 Studio 发布在宿主机的 127.0.0.1:4317。需要 Docker Compose v2、可用的 Node 运行镜像和已构建的 Linux DSH 镜像。DSH 镜像须在 `/opt/dsh` 提供与 `compatibility.json` 匹配的包和编译产物，默认镜像名为 `dsh-build:local`；可在本地 `.env` 中指定 `DSH_BUILD_IMAGE`。

## 启动

在项目根目录执行以下命令。macOS 或 Linux 上用当前用户的 UID 和 GID，可确保挂载数据能够由容器和宿主机读取。

```sh
mkdir -p .studio-docker .dsh-home
export STUDIO_UID="$(id -u)" STUDIO_GID="$(id -g)"
docker compose up -d --build --wait
```

打开[本机 Studio](http://127.0.0.1:4317)。默认模板使用离线演示模型。要连接已有模型，把 `STUDIO_DSH_HOME` 设为实际 DSH 配置目录后启动。独立的只读进程只向 Studio 提供模型、设置和凭据文件；业务服务通过私有 socket 读取，模型地址在容器中必须可达。所有写请求仍需要同源检查和 CSRF 令牌。默认部署不挂载宿主机 Docker socket，Worker 的嵌套容器执行未启用。

仅将可信服务加入 Studio 的 Compose 网络。同网络内的容器可以连接 Web 服务，宿主机的回环端口绑定只限制来自外部网络的访问。

## 启用更多搜索来源

维基百科可直接查询。其他来源可在 Worker 模板的「搜索来源与访问记录」页指定公开 HTTPS SearXNG 地址。也可启动项目附带的 SearXNG 服务。

```sh
docker compose -f compose.yaml -f compose.search.yaml up -d --build --wait
```

可设置 `STUDIO_SEARCH_IMAGE` 固定 SearXNG 镜像。启用独立搜索后，使用同一组 Compose 文件管理服务。Worker 仍需单独授予公开网络权限。

## 数据和验证

`STUDIO_DATA_DIR` 可指定专用宿主目录，默认使用 `.studio-docker/`。同一个数据目录使用同一个 Compose 项目和原运行锁卷。停止服务再备份整个数据目录；容器重建时继续使用原数据目录和锁卷。运行中的 Studio 和剧本工作台各自使用自己的目录。

下面的验证读取已构建的 Studio 镜像，创建独立项目、临时数据和随机本机端口，检测模型目录刷新、请求来源校验和容器替换后的任务恢复。设置 `STUDIO_TEST_BUNDLED_SEARCH=1` 同时检查附带搜索服务。

```sh
node scripts/check-docker.mjs
```
