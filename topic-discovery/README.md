# 选题发现与观测

本目录包含可单独运行的选题示例。Python 负责采集或导入文档，在 SQLite 中记录时间窗口、去重、来源、候选和每一步的处理结果。只读看板可以按运行查看候选和原始证据。返回的草稿可交给 DSH 审阅。

## 运行离线示例

在本目录使用 Python 3.10 或更高版本。示例数据是自编的虚构内容。以下命令以固定时间判断最近 3、7、30 天，日期不明的记录会保留在处理明细中。

```sh
python3 -m topic_discovery run --input examples/sample-input.json --now 2024-06-10T12:00:00Z
python3 -m topic_discovery runs
python3 -m topic_discovery serve --port 4332
```

在浏览器打开 [本机看板](http://127.0.0.1:4332)。默认数据库位于 `data/discovery.sqlite`，可以在子命令前用 `--db PATH` 指定其他数据库。同一数据库重复导入相同正文会记录新运行，并跳过已有候选。

如需采集实际来源，`python3 -m topic_discovery fetch --source ollama --limit 5` 会读取该项目的公开发布订阅。也可选择 `langgraph` 或 `langfuse`。采集需要网络连接，数据仅写入指定数据库。

## DSH 审阅

先在 Studio 仓库根目录按项目说明准备 DSH 并完成构建，再回到本目录执行。分析器要求本机 Ollama 在回环地址的 11434 端口运行。将环境变量 `TOPIC_LOCAL_MODEL` 设为已安装的模型完整标签，例如从 `ollama list` 中复制名称。这里的标签需要指向有本地权重的模型。

```sh
python3 -m topic_discovery export-dsh --run-id <运行编号> --output data/task.json
node dsh/analyze.mjs data/task.json data/result.json
python3 -m topic_discovery import-dsh --task data/task.json --result data/result.json
```

运行编号来自导入或采集命令的输出。导出内容包括本轮的证据编号和原文。导回时校验来源、引用、任务编号和材料状态；通过的候选进入语义审核。含有独立公开问题和相应材料的任务还可使用 `dsh/analyze-structured.mjs` 生成结构化审阅。独立审核通过后可进入选题讨论，制作和发布仍需另外授权。

## 测试和数据

```sh
python3 -m unittest discover -s tests
python3 evaluation/validate_fixtures.py
python3 evaluation/test_acceptance.py
node --test dashboard/*.test.mjs dsh/*.test.mjs
```

公开仓库提供通用评测工具和合成材料。历史采集正文、私有评测集、人工评语以及实际模型返回值保留在使用方自己的环境。导入或生成的材料请放在已被 Git 忽略的 `data/` 或 `evaluation/private/` 下。数据格式和评测命令见[看板接口说明](contracts/README.md)和[评测说明](evaluation/README.md)。
