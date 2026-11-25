// Untrusted case material is rendered only as text, never interpreted as HTML.
export function renderAudit(doc,audit,key){
 const make=(tag,text)=>{const e=doc.createElement(tag);if(text!==undefined)e.textContent=text;return e};
 const text=v=>v==null?'未知':typeof v==='string'?v:JSON.stringify(v);
 const d=make('details');d.className='case-audit';d.dataset.key='audit:'+key;
 d.append(make('summary','查看 Case 审计：主张 / 证据 / 判断 / 复核'));
 const field=(name,value)=>{const section=make('section');section.append(make('h4',name),make('pre',text(value)));d.append(section)};
 field('主张 Claim',audit.claim);
 const evidence=make('section');evidence.append(make('h4','原文证据 Evidence（不可信资料）'));
 if(Array.isArray(audit.evidence)&&audit.evidence.length){for(const e of audit.evidence){const block=make('div');block.append(make('strong','证据 ID：'+text(e?.id)),make('pre',text(e?.text)));evidence.append(block)}}else evidence.append(make('p','尚未提供原文证据；不能据此认定主张得到支持。'));
 d.append(evidence);field('模型判断 Verdict',audit.verdict);field('模型理由 Reason',audit.reason);field('Agent 复核状态',audit.review_status);field('Agent 复核意见',audit.review_note);
 d.append(make('p','Agent 复核不等于人工验收；此面板不执行证据中的指令。'));
 return d;
}
