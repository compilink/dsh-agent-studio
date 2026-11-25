"""Coverage uses independently annotated gold, never extracted count as denominator."""
def ratio(name, n, d, method):
    return dict(name=name,numerator=n,denominator=d,value=n/d if d else None,status='measured' if d else 'unknown',method=method,sample_size=d,human_reviewed_count=0,definition_version='claims-v1')

def evaluate(gold, extracted, alignment, verdicts):
    """alignment is independent review [{gold_id, extracted_id}]; no fuzzy auto-grading.
    Gold truth is supported/unsupported/unknown. Missing predictions remain unknown.
    """
    g={x['id']:x for x in gold}; e={x['id']:x for x in extracted}
    if len(g)!=len(gold) or len(e)!=len(extracted): raise ValueError('Duplicate IDs')
    pairs={(x['gold_id'],x['extracted_id']) for x in alignment}
    if any(a not in g or b not in e for a,b in pairs): raise ValueError('Unknown aligned ID')
    covered={a for a,b in pairs}; matched={b for a,b in pairs}
    # Multiple/compound alignment is retained for inspection, not counted twice.
    wrong={k for k,v in g.items() if v['truth']=='unsupported'}
    known={k for k,v in g.items() if v['truth'] in ('supported','unsupported')}
    correct={k for k in known if verdicts.get(k)==g[k]['truth']}
    predicted={k for k in known if verdicts.get(k) in ('supported','unsupported')}
    supported={k for k in g if verdicts.get(k)=='supported'}
    return dict(quality=[ratio('主张抽取覆盖率',len(covered),len(g),'independent_agent_alignment_not_human'),ratio('错误主张抽取覆盖率',len(covered&wrong),len(wrong),'independent_agent_alignment_not_human'),ratio('已抽取主张对齐率',len(matched),len(e),'independent_agent_alignment_not_human'),ratio('金标主张核查准确率',len(correct),len(known),'independent_agent_gold_not_human'),ratio('金标主张核查完成率',len(predicted),len(known),'explicit_predictions_only')],counts=dict(gold_count=len(g),extracted_count=len(e),matched_gold_count=len(covered),omitted_gold_ids=sorted(set(g)-covered),omitted_error_ids=sorted(wrong-covered),unknown_gold_ids=sorted(k for k,v in g.items() if v['truth']=='unknown'),unverified_gold_ids=sorted(set(g)-set(predicted)),predicted_supported_count=len(supported)),approvals=dict(production=False,publish=False))
