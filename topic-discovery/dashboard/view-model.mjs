export const statusLabels={queued:'排队',running:'运行中',waiting:'等待输入',partial:'部分完成',completed:'完成',succeeded:'成功',success:'成功',failed:'失败',cancelled:'已取消',pending:'待评估',unknown:'未知',not_applicable:'不适用',unavailable:'无法计算',needs_editorial_review:'待选题编辑',needs_verification:'待事实核查',accepted:'接受',rejected:'拒绝',skipped:'跳过'};
export function label(value){return statusLabels[value] || value || '未知'}
export function count(value){return typeof value==='number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未知'}
export function qualityText(q){if(['pending','unknown','unavailable','not_applicable'].includes(q.status)) return label(q.status);if(q.denominator===0) return '无法计算（分母为 0）';if(typeof q.numerator==='number'&&typeof q.denominator==='number')return `${count(q.numerator)} / ${count(q.denominator)} · ${(q.numerator/q.denominator*100).toFixed(1)}%`;return q.value == null?'待评估':String(q.value)}
export function safeUrl(url){try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return null;return u.href}catch{return null}}
export function eventsUnique(events){const seen=new Set();return [...events].sort((a,b)=>(b.sequence||0)-(a.sequence||0)).filter(e=>{if(seen.has(e.event_id))return false;seen.add(e.event_id);return true})}
export const metricLabels={request_success_rate:'采集请求成功率',input_processed_rate:'输入处置覆盖率',event_date_completeness:'事件日期完整率',exact_uniqueness:'精确去重保留率',identity_binding:'URL身份绑定率',claim_verification_coverage:'主张核查覆盖率',history_link_coverage:'历史关联覆盖率',draft_evidence_linkage:'草稿证据关联率',extraction_coverage:'抽取覆盖率',extraction_coverage_rate:'抽取覆盖率',evidence_support_rate:'证据支持率',evidence_support:'证据支持率',semantic_accuracy:'语义质量（待标注基准）',source_coverage:'来源覆盖'};
export function qualityView(q){
 const method={rule:'规则检查',model:'模型评估',human:'人工检查',unknown:'方法未知',independent_agent_alignment_not_human:'独立 Agent 对齐评估（非人工）',independent_agent_gold_not_human:'独立 Agent 参考标注评估（非人工）'}[q.method] || '方法未声明';
 const extraction=/extract.*coverage|抽取覆盖率/.test(q.name||'');const evidence=/evidence.*support|supported.*claim|citation.*support|证据支持率/.test(q.name||'');
 const gold=/金标|gold/.test(q.name||'');const meaning=gold?'基于当前参考标注集进行核查评测；若标注来自 Agent，不是人工金标或全量事实准确率。':extraction?'衡量原文中应提取的信息是否被提取，不证明其内容真实。':evidence?'衡量主张是否得到所引证据支持，不代表已完成外部独立核实。':q.definition||'指标含义以当前口径定义为准。';
 const human=Number.isInteger(q.human_reviewed_count)&&q.human_reviewed_count>=0?q.human_reviewed_count:null;
 const review=human===null?'人工复核数量未知；不视为人工验收。':human===0?'尚未人工复核；不是人工验收。':`已有 ${count(human)} 条人工复核；仅代表对应样本，不代表全量验收。`;
 return {title:metricLabels[q.name]||q.name||'未命名指标',value:qualityText(q),fraction:`分子 ${count(q.numerator)} / 分母 ${count(q.denominator)}`,sample:`样本 ${count(q.sample_size)} · 未知项 ${count(q.unknown_count)}`,method,meaning,review};
}
