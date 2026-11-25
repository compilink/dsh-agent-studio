"""Strict frozen-dataset accounting; label agreement is not semantic approval."""
import json,hashlib,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root))
from topic_discovery.store import Store,utcnow

def summarize(dataset_path,result_path,review_path=None):
 b=Path(dataset_path).read_bytes();d=json.loads(b);r=json.loads(Path(result_path).read_text())
 if r['dataset_sha256']!=hashlib.sha256(b).hexdigest():raise ValueError('dataset_hash_mismatch')
 cases={c['id']:c for c in d['cases']};checks={}
 for row in r['checks']:
  ident=row['parsed']['id']
  if ident not in cases or ident in checks:raise ValueError('unexpected_or_duplicate_id')
  checks[ident]=row
 known=[c for c in d['cases'] if c['expected'] in ('supported','unsupported')]
 negatives=[c for c in known if c['expected']=='unsupported']
 matches=sum(checks.get(c['id'],{}).get('parsed',{}).get('verdict')==c['expected'] for c in known)
 false_pass=[c['id'] for c in negatives if checks.get(c['id'],{}).get('parsed',{}).get('verdict')=='supported']
 missing=sorted(set(cases)-set(checks))
 return dict(dataset_sha256=r['dataset_sha256'],total=len(cases),completed=len(checks),missing_ids=missing,label_agreement={'numerator':matches,'denominator':len(known)},false_pass_ids=false_pass,negative_count=len(negatives),format_valid=sum(x['format_valid'] for x in checks.values()),real_source_case_count=d['real_source_case_count'],human_reviewed_count=0,reason_review='pending_independent_agent',semantic_acceptance=False,production_approved=False,publish_approved=False)
if __name__=='__main__':
 ds,res,out=sys.argv[1:4];summary=summarize(ds,res);Path(out).write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps(summary,ensure_ascii=False))
