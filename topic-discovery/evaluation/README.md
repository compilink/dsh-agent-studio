# 离线验收与本地模型评测

从 `topic-discovery/` 目录执行以下命令。固定样例包括自编的 17 个文档案例和 11 个协议场景。可执行的离线验收覆盖时间窗口、去重、敏感标记过滤、候选审核状态和事件幂等。协议场景中的预期值是设计样例，具体执行覆盖以测试代码为准。

```sh
python3 evaluation/validate_fixtures.py
python3 evaluation/test_acceptance.py
```

`examples/sample-claims.json` 提供两个自编的主张与证据。准备好 Studio 的 DSH 依赖和本地 Ollama 后，可使用指定的已安装模型检查证据。以下命令将模型输出写到忽略目录。

```sh
mkdir -p data
node dsh/bound-checker.mjs examples/sample-claims.json "$TOPIC_LOCAL_MODEL" data/checks.json
python3 evaluation/summarize_transfer.py examples/sample-claims.json data/checks.json data/summary.json
```

检查器只向模型提供当前主张和与其绑定的证据。汇总器核对输入文件摘要、案例身份、缺失数量和标签一致率。判断为支持且引用存在，只证明引用结构符合要求。可以用 `python3 evaluation/record_causal_eval.py examples/sample-claims.json data/checks.json` 将试验结果登记到本地看板进一步审核。

仓库不分发外部采集语料、实际运行的会话和评语或历史模型成绩。以上样例用于验证流程，无法据此推断实际内容上的准确率。
