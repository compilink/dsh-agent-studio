import hashlib, json, re, time
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from .store import utcnow
from .settings import action_field, local_settings
from .stage_metrics import summarize, UNITS, ratio

MODULES=['collect','normalize','deduplicate','resolve','verify','track','edit']

def digest(value):return hashlib.sha256(value.encode()).hexdigest()
def dt(value):
    if not value:return None
    try:
        x=datetime.fromisoformat(value.replace('Z','+00:00'))
        return x.astimezone(timezone.utc) if x.tzinfo else None
    except (ValueError,AttributeError):return None

def canonical(url):
    p=urlsplit(url)
    if p.scheme not in ('https','http') or not p.hostname or p.username or p.password:raise ValueError('invalid_public_url')
    return urlunsplit((p.scheme,p.netloc.lower(),p.path.rstrip('/'),urlencode([(k,v) for k,v in parse_qsl(p.query) if not k.startswith('utm_')]),''))

def run_pipeline(store, documents, now=None, mode='fixture', collection_stats=None):
    now=now or utcnow(); asof=dt(now)
    if not asof:raise ValueError('now must have timezone')
    if mode not in ('fixture','live','import'):raise ValueError('invalid mode')
    documents=list(documents)
    if len(documents)>200:raise ValueError('document budget exceeded (200)')
    rid=store.new_run(mode,now)
    collection=dict(status='completed',unit='document',input_count=len(documents),output_count=len(documents),completed_count=len(documents),failed_count=0,skipped_count=0,pending_count=0,retries=0,duration_ms=None,quality=[dict(name='source_coverage',numerator=None,denominator=None,value=None,status='pending',method='rule',definition_version='1.0',sample_size=len(documents))],items=[dict(item_id=str(i),status='completed',reason='received_public_document') for i in range(len(documents))],request_count=None,coverage='bounded_import_or_latest_feed')
    collection.update(collection_stats or {})
    collection.update(input_unit='document',output_unit='document')
    if collection.get('request_count') is not None:
        collection['quality'].append(ratio('request_success_rate',collection.get('request_success_count',0),collection['request_count'],'Successful allowlisted feed requests / attempted requests; not full source coverage.', 'input'))
    store.transition(rid,'collect',collection)
    def stage(name,inputs,fn):
        t=time.monotonic(); items=[]; outputs=[]
        base=dict(status='running',unit='document' if name in ('normalize','deduplicate') else 'topic',input_count=len(inputs),output_count=0,completed_count=0,failed_count=0,skipped_count=0,pending_count=len(inputs),retries=0,duration_ms=0,quality=[],items=[])
        store.transition(rid,name,base,'module.started')
        for index,item in enumerate(inputs):
            try:
                output,status,reason=fn(item)
                entry=dict(item_id=str(index),status=status,reason=reason)
                if name!='normalize' and isinstance(item,dict):entry['source_url']=item.get('url')
                if output is not None:
                    aid=store.artifact(rid,name,output);entry['artifact_id']=aid;outputs.append(output)
                items.append(entry)
            except (ValueError,TypeError,KeyError) as e:items.append(dict(item_id=str(index),status='failed',reason=str(e)))
        failed=sum(x['status']=='failed' for x in items);skipped=sum(x['status']=='skipped' for x in items)
        base.update(status='partial' if failed else 'completed',output_count=len(outputs),completed_count=len(items)-failed-skipped,failed_count=failed,skipped_count=skipped,pending_count=0,items=items,duration_ms=round((time.monotonic()-t)*1000),quality=[dict(name='semantic_accuracy',numerator=None,denominator=None,value=None,status='pending',method='human',definition_version='1.0',sample_size=0)])
        base.update(summarize(name,inputs,outputs,items))
        store.transition(rid,name,base)
        return outputs
    def normalize(x):
        text=x.get('text',''); title=x.get('title','')
        if not isinstance(text,str) or not title:raise ValueError('missing_title_or_invalid_text')
        if len(text)>50000:raise ValueError('text_budget_exceeded')
        # Reject common credential-bearing URLs/content; do not retain secrets in artifacts.
        if re.search(r'(?i)(authorization\s*:|bearer\s+[a-z0-9]|sessionid\s*=|cookie\s*:|api[_-]?key\s*=)',json.dumps(x)):
            return None,'skipped','potential_secret'
        url=canonical(x['url'])
        if re.search(r'(?i)(token|secret|password|key|cookie|session)=',url):return None,'skipped','credential_url'
        published=dt(x.get('published_at'));updated=dt(x.get('updated_at'))
        event_time=dt(x.get('event_occurred_at')) if 'event_occurred_at' in x else published
        age=(asof-event_time).total_seconds()/86400 if event_time else None
        windows=[] if age is None or age<0 else [n for n in (3,7,30) if age<=n]
        out=dict(source=x.get('source','unknown'),source_id=str(x.get('id','')),url=url,title=title,text=text[:50000],published_at=published.isoformat() if published else None,event_occurred_at=event_time.isoformat() if event_time else None,updated_at=updated.isoformat() if updated else None,observed_at=now,windows=windows,date_status='unknown' if age is None else 'future' if age<0 else 'known',content_hash=digest(text),coverage=x.get('coverage','unknown'),mode=mode,untrusted=True)
        return out,'completed','normalized'
    normalized=stage('normalize',documents,normalize)
    seen=set()
    def dedup(x):
        key=x['content_hash'] if x['text'].strip() else (x['url'],x['title'])
        if key in seen:return None,'skipped','exact_duplicate'
        seen.add(key);return x,'completed','unique_observation'
    unique=stage('deduplicate',normalized,dedup)
    def resolve(x):
        # Deterministic identity only; semantic same-event merging is explicitly pending.
        return dict(x,topic_id=digest(x['url']),resolution_method='canonical_url',semantic_merge_status='pending'),'completed','url_identity_only'
    resolved=stage('resolve',unique,resolve)
    verified=stage('verify',resolved,lambda x:(dict(x,verification_status='unverified',claims=[],verification_note='Source publication is evidence of its own statement, not independent truth.'),'completed','awaiting_DSH_or_human_verification'))
    def track(x):
        tid=mode+':'+x['topic_id']; old=store.topic(tid)
        changed=old and old.get('content_hash')!=x['content_hash']
        change='first_observation' if old is None else 'changed_content_pending_review' if changed else 'no_change'
        result=dict(x,change_status=change,previous_hash=old.get('content_hash') if old else None)
        history=(old or {}).get('history',[])
        if old is None or changed:history=history+[dict(observed_at=now,content_hash=x['content_hash'],url=x['url'],title=x['title'])]
        store.save_topic(tid,dict(content_hash=x['content_hash'],history=history))
        return result,'completed',change
    tracked=stage('track',verified,track)
    action_key=action_field(local_settings())
    def edit(x):
        if x['date_status']!='known':return None,'skipped','date_unverified'
        if not x['windows'] and x['change_status']!='changed_content_pending_review':return None,'skipped','outside_window_without_update'
        if x['change_status']=='no_change':return None,'skipped','already_observed_without_update'
        # Source text never controls execution, approvals or task instructions.
        card=dict(title=x['title'],topic_id=x['topic_id'],source_url=x['url'],published_at=x['published_at'],windows=x['windows'],change_status=x['change_status'],status='needs_editorial_review',verification_status=x['verification_status'],hook=None,experiment=None,production_approved=False,publish_approved=False,mode=mode,generated_by='deterministic_stub',evidence_hash=x['content_hash'])
        card[action_key]=None
        return card,'completed','draft_only_no_model_claim'
    cards=stage('edit',tracked,edit)
    for c in cards:store.artifact(rid,'candidate',c)
    store.finish(rid,'partial' if any(m['failed_count'] for m in store.run(rid)['modules']) else 'completed')
    return dict(run_id=rid,candidates=cards,snapshot=store.run(rid))
