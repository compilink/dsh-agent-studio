"""Evaluation-only audit import: preserve source, claim and model reason together."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from topic_discovery.store import Store,utcnow
from topic_discovery.claim_metrics import ratio
b=Path(__file__).resolve().parents[1];load=lambda p:json.loads((b/p).read_text())
dataset,resultfile=sys.argv[1:3];d=load(dataset);r=load(resultfile)
cs={c['id']:c for c in d['cases']};s=Store(b/'data/discovery.sqlite');rid=s.new_run('evaluation',utcnow());items=[]
for x in r['checks']:
 o=x['parsed'];c=cs[o['id']];a=s.artifact(rid,'causal_case_audit',dict(source_case=c,model_response=x,human_reviewed_count=0,semantic_review='pending_independent_agent',production_approved=False,publish_approved=False))
 items.append(dict(item_id=c['id'],artifact_id=a,status='completed' if x['format_valid'] else 'failed',reason='模型判定与结构结果，不代表语义通过',audit=dict(claim=c['claim'],evidence=[e for e in c['evidence'] if e['id'] in c['bound_ids']],verdict=o['verdict'],reason=o.get('reason',''),review_status='pending',review_note='独立agent语义复核尚未导入；人审0')))
n=len(items);valid=sum(x['format_valid'] for x in r['checks']);match=sum(x['parsed']['verdict']==cs[x['parsed']['id']]['expected'] for x in r['checks']);neg=[x for x in r['checks'] if cs[x['parsed']['id']]['expected']=='unsupported'];fp=sum(x['parsed']['verdict']=='supported' for x in neg)
s.transition(rid,'causal_reason_review',dict(status='partial',unit='claim',input_count=n,output_count=valid,completed_count=valid,failed_count=n-valid,skipped_count=0,pending_count=0,retries=0,duration_ms=sum(x['duration_ms'] for x in r['checks']),items=items,quality=[ratio('引用结构通过率',valid,n,'exact_bound_quote'),ratio('诊断标签一致率',match,n,'independent_agent_labels_not_human'),ratio('负例误放率',fp,len(neg),'independent_agent_labels_not_human'),dict(name='理由语义正确率',numerator=None,denominator=n,value=None,status='unknown',method='pending_independent_review',sample_size=n,human_reviewed_count=0,definition_version='causal-v1')]))
s.finish(rid,'partial');print(rid)
