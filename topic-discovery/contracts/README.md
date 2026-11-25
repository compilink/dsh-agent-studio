# 选题发现指标契约 v1

此契约用于本地只读业务看板，不代替发布许可或模型诊断遥测。模块必须声明计数单位；跨模块不直接加总。

## 接口
- `GET /api/runs`: `{runs:[{run_id,status,mode,started_at,updated_at}]}`。
- `GET /api/runs/{id}`: `snapshot.schema.json`；数据库一致性快照，cursor 对应该快照已包含的事件序号。
- `GET /api/events?run_id=ID&after=N`: 序号大于 N 的事件；event_id 唯一，按 sequence 排序。
- `GET /api/stream?run_id=ID&after=N`: SSE，默认 message 事件；`id` 为持久 sequence，data 为 event 对象。重连优先 Last-Event-ID；客户端收到事件后合并刷新完整快照，不在 UI 上累加 +1。
- `GET /api/candidates?run_id=ID`: `{candidates:[...]}`，均为待讨论数据，不包含制作/发布触发器。

## 计数与状态
`input_count` 为本轮去除传输重试后的唯一处理输入；`output_count` 为产物，允许一对多。`completed_count` 是已完成输入，包含被分类为拒绝或待核查的输入；业务拒绝不等于技术失败。失败终止、跳过、等待、运行中须互斥记录。重试数独立。尚未测量为 null，确实无数据才为 0。

建议模块：discover（请求/线索）、normalize（文档/证据）、deduplicate（证据/唯一证据）、resolve（证据/事件）、verify（主张/结论）、track（话题/变化）、edit（话题/候选）、review（候选版本/人工决定）。不可用模块应显示未执行/未知，而不是伪造成功。

## 质量定义
每项 metric 携带 name、definition_version、分子/分母、method（rule/model/human/unknown）、sample_size、状态及 evaluated_at。分母为 0 不显示百分比；pending/unknown 不显示通过。人工抽检指标仅代表样本，模型自评分不得命名为准确率。质量比率仅在同一口径、样本基准下比较。

模块完成保存不可变 completed_snapshot；后续评估产生新 revision，关联原始输入输出版本。看板同时保留完成时和最新值。

## 事件与恢复
事件和业务状态同一事务提交；Outbox/持久事件表提供断线补发。重复 event_id 幂等，业务序号由协调器分配，不信任浏览器到达顺序。重试复用稳定 item_id、增加 attempt_id。迟到结果不得复活已取消任务。口径变更升版本，不无提示串接新旧曲线。看板断开不触发采集重跑。

## 隐私
默认仅输出公开来源链接、必要摘要、ID、计数和产物引用。禁止 Cookie、Authorization、访问令牌、用户私有文件或非必要评论者身份进入 API/事件。服务端负责脱敏，前端只用 textContent 显示文本，不解释来源 HTML；仅允许无嵌入凭据的 HTTP(S) 链接。原始日志不直接通过此 API 暴露。

## 首版边界
原生 SSE + 15 秒只读快照兜底轮询。无需前端依赖或付费组件。OpenTelemetry/Langfuse 的真实集成、DSH 链路上下文传递仍是后续验收项；不能称本看板已实现这些功能。

## 独立抽取 / 核查评估补充

`extraction_eval` 和 `verification_eval` 是不同模块。抽取覆盖率衡量预期信息是否提取，不证明事实真实；证据支持率衡量引用与主张是否相符，不等于外部独立核实。参考标注（gold）若由独立 Agent 生成，method 应使用 `independent_agent_gold_not_human` 或 `independent_agent_alignment_not_human`，不可显示成人工金标准确率。`human_reviewed_count=0` 明确表示尚未人工复核，缺失则表示未知。其他可选属性：unknown_count、scope、definition、evaluator_version。所有质量卡显示分子、分母、样本数、方法、口径、待评估状态，即使百分比无法计算也保留原始数量。

## Case 审计明细

每个 module.items[] 可携带 audit={claim,evidence:[{id,text}],verdict,reason,review_status,review_note}。原文证据、模型理由和独立 Agent 复核意见必须分字段，不把复核意见覆盖模型原始理由。字段缺失显示未知，不以空值推断通过。UI 默认折叠，按 run/module/item 保留展开标识；证据仅显示文本，不解析 HTML，不自动访问其中链接或执行指令。Agent 复核与人类验收明确分开。数据源必须先去除凭据及无关个人信息后再存入 API。

## 模块结构指标

每个确定性模块新增 `input_unit`、`output_unit`（兼容旧 `unit`），区分文档、证据、URL话题、待核查话题、变化记录和草稿；verify 当前按话题计数，不能冒充已核查主张数。

新增 rule 指标：请求成功率、输入处置覆盖率、事件日期完整率、精确去重保留率、URL 身份绑定率、历史关联覆盖率、草稿证据关联率。携带分子、分母、定义、输入/输出范围、样本数及测量时间；空分母 unavailable。所有语义准确率仍 pending，主张核查未执行且无分母时保持 null。规则结构指标不代表语义质量或受众吸引力。

`summary.dispositions` 给出逐项处置原因计数，normalize 给出重叠的3/7/30天文档数及未知/未来日期数，track 给出首次、无变化、内容变化待审数量。原文/产物通过 items.artifact_id 下钻。时间窗口计数不是热度趋势；hash变化不是实质进展。模块事件事务同时更新运行更新时间；当前运行下拉标题跟随快照状态更新。

## 独立语义审核

`readiness` 现在要求独立审阅携带 `claim_audit`，缺失则关闭讨论就绪：candidate_sha256、kind(supervising_review/user_review)、inventory_complete、claims[{id,fields,verdict,evidence_ids,reason}]、nonfactual_fields。内容字段不能因只审核source_claims而遗漏标题、hook、计划中的事实前提或受众归因。未知和不支持均阻止完整放行，但保留数量与理由，不删除失败部分以伪装全通过。未审核字段和部分覆盖明确列出。

inventory_complete和nonfactual_fields均为可信独立审阅者的声明，不由网页内容或本地模型生成授权；程序不能证明审阅者未漏掉隐含主张。独立Agent也不等于人类金标。历史审阅缺coverage时需要补审，不自动迁移为接受。讨论就绪永远不产生制作或发布许可。本门目前为供可信协调器调用的库，原确定性采集链仍只出未核查草稿，不冒充自动语义闭环。
