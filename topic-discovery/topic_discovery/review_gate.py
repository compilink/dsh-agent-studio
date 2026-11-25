"""Deterministic readiness gate. Model scores alone cannot approve a topic."""
import hashlib,json
from .semantic_audit import audit_coverage

def candidate_hash(candidate):
    return hashlib.sha256(json.dumps(candidate,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def readiness(candidate, evidence_ids, independent_review=None):
    reasons=[]
    if candidate.get('verification_status') in ('unverified',None):reasons.append('facts_not_checked')
    refs=candidate.get('evidence_ids',[])
    if not refs or not set(refs).issubset(set(evidence_ids)):reasons.append('missing_or_unknown_evidence')
    if not independent_review:reasons.append('independent_review_missing')
    else:
        if independent_review.get('candidate_sha256')!=candidate_hash(candidate):reasons.append('review_version_mismatch')
        if independent_review.get('decision')!='accept_for_discussion':reasons.append('independent_review_not_accepted')
        if independent_review.get('kind') not in ('supervising_review','user_review'):reasons.append('model_self_score_not_approval')
    coverage=audit_coverage(candidate,evidence_ids,(independent_review or {}).get('claim_audit'))
    reasons.extend(coverage['reasons'])
    return {'claim_coverage':coverage,'ready_for_discussion':not reasons,'reasons':reasons,'production_approved':False,'publish_approved':False}
