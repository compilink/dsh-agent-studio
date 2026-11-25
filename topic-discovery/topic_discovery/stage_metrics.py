"""Measured structural quality, never a substitute for semantic acceptance."""
from collections import Counter
from .store import utcnow

UNITS = {
    'collect': ('document', 'document'), 'normalize': ('document', 'evidence'),
    'deduplicate': ('evidence', 'unique_evidence'), 'resolve': ('evidence', 'url_topic'),
    'verify': ('topic', 'unverified_topic'), 'track': ('topic', 'change_record'),
    'edit': ('topic', 'draft_candidate'),
}

def ratio(name, numerator, denominator, definition, scope='output'):
    return dict(name=name, numerator=numerator, denominator=denominator,
                value=numerator/denominator if denominator else None,
                status='completed' if denominator else 'unavailable', method='rule',
                definition_version='1.0', sample_size=denominator, unknown_count=0,
                evaluated_at=utcnow(), definition=definition, scope=scope,
                human_reviewed_count=0)

def summarize(name, inputs, outputs, items):
    n=len(outputs)
    quality=[ratio('input_processed_rate',sum(i['status']!='failed' for i in items),len(inputs),
                   'Inputs receiving a disposition, including explicit skips; not content accuracy.', 'input')]
    if name=='normalize':
        quality.append(ratio('event_date_completeness',sum(x['date_status']=='known' for x in outputs),n,
                             'Output evidence with parseable, non-future event dates; not independently verified dates.'))
    elif name=='deduplicate':
        quality.append(ratio('exact_uniqueness',n,len(inputs),'Unique retained content identities / input evidence; not semantic deduplication.', 'input_to_output'))
    elif name=='resolve':
        quality.append(ratio('identity_binding',sum(bool(x.get('topic_id')) for x in outputs),n,'Canonical URL identity present; does not establish same-event semantic clustering.'))
    elif name=='verify':
        quality.append(dict(name='claim_verification_coverage',numerator=None,denominator=None,value=None,status='pending',method='unknown',definition_version='1.0',sample_size=0,evaluated_at=None,definition='This stage does not extract or verify claims. No claim denominator is available.',scope='output'))
    elif name=='track':
        quality.append(ratio('history_link_coverage',sum(bool(x.get('previous_hash')) for x in outputs if x['change_status']!='first_observation'),sum(x['change_status']!='first_observation' for x in outputs),'Reobserved topics linked to prior content hash; changes still require substantive review.'))
    elif name=='edit':
        quality.append(ratio('draft_evidence_linkage',sum(bool(x.get('evidence_hash') and x.get('source_url')) for x in outputs),n,'Drafts retaining source URL and hash; not audience appeal or editorial acceptance.'))
    quality.append(dict(name='semantic_accuracy',numerator=None,denominator=None,value=None,status='pending',method='unknown',definition_version='1.0',sample_size=0,evaluated_at=None,scope='output',definition='No independent semantic assessment has been completed by this pipeline.'))
    summary={'dispositions':dict(Counter(x['reason'] for x in items))}
    if name=='normalize':
        summary.update(window_document_counts={str(d):sum(d in x['windows'] for x in outputs) for d in (3,7,30)},window_definition='Inclusive, overlapping date windows; document counts, not popularity trends.',unknown_date_count=sum(x['date_status']=='unknown' for x in outputs),future_date_count=sum(x['date_status']=='future' for x in outputs))
    if name=='track': summary['change_counts']=dict(Counter(x['change_status'] for x in outputs))
    return dict(input_unit=UNITS[name][0],output_unit=UNITS[name][1],quality=quality,summary=summary)
