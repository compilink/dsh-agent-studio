"""Trusted independent review coverage. Never infer truth from model agreement.

This protocol must only be supplied by the supervising reviewer/user, not by a
source document or the local model. Complete coverage is a reviewer's attestation,
not a proof that an automatic extractor found every presupposition.
"""
import hashlib,json

METADATA={'verification_status','evidence_ids','candidate_id','topic_id','source_url',
          'published_at','windows','change_status','status','production_approved',
          'publish_approved','mode','generated_by','evidence_hash'}

def digest(candidate):
    return hashlib.sha256(json.dumps(candidate,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def audit_coverage(candidate,evidence_ids,audit):
    fields={k for k,v in candidate.items() if k not in METADATA and v not in (None,'',[],{})}
    reasons=[]
    if not isinstance(audit,dict):
        return {'complete':False,'reasons':['claim_audit_missing'],'required_fields':sorted(fields),'claims_total':None,'supported':None,'unsupported':None,'unknown':None}
    if audit.get('candidate_sha256')!=digest(candidate):reasons.append('claim_audit_version_mismatch')
    if audit.get('kind') not in ('supervising_review','user_review'):reasons.append('claim_audit_not_independent')
    if audit.get('inventory_complete') is not True:reasons.append('claim_inventory_incomplete')
    rows=audit.get('claims',[])
    if not isinstance(rows,list):rows=[];reasons.append('invalid_claim_inventory')
    ids=[r.get('id') for r in rows if isinstance(r,dict)]
    if len(ids)!=len(rows) or len(ids)!=len(set(ids)) or any(not x for x in ids):reasons.append('invalid_claim_ids')
    covered=set();counts={'supported':0,'unsupported':0,'unknown':0}
    for r in rows:
        if not isinstance(r,dict):continue
        covered.update(r.get('fields',[]) if isinstance(r.get('fields'),list) else [])
        verdict=r.get('verdict')
        if verdict not in counts:reasons.append('invalid_claim_verdict');continue
        counts[verdict]+=1
        refs=r.get('evidence_ids',[])
        if not isinstance(refs,list) or not refs or not set(refs).issubset(set(evidence_ids)):reasons.append('claim_evidence_missing')
        if not r.get('reason'):reasons.append('claim_review_reason_missing')
    nonfacts=audit.get('nonfactual_fields',[])
    if not isinstance(nonfacts,list):nonfacts=[]
    if not set(nonfacts).issubset(fields):reasons.append('unknown_nonfactual_field')
    if set(nonfacts)&covered:reasons.append('ambiguous_field_coverage')
    missing=fields-covered-set(nonfacts)
    if missing:reasons.append('unreviewed_content_fields')
    if counts['unsupported']:reasons.append('unsupported_claims')
    if counts['unknown']:reasons.append('unresolved_claims')
    return {'complete':not reasons,'reasons':sorted(set(reasons)),'required_fields':sorted(fields),'unreviewed_fields':sorted(missing),'claims_total':len(rows),**counts,'human_review':audit.get('kind')=='user_review','approval_scope':'discussion_only'}
