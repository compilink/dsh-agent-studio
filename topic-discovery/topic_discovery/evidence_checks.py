"""Deterministic review hints; never treat absence of flags as factual approval."""
import re
from urllib.parse import urlsplit,unquote
from .pipeline import dt

def check_evidence_packet(evidence):
    hints=[];release_dates=[];issue_dates=[]
    for e in evidence:
        d=e['data'];aid=e['artifact_id'];url=d.get('url','');title=d.get('title','');body=d.get('text','')
        if '/releases/tag/' in url:
            tag=unquote(url.split('/releases/tag/',1)[1])
            if title!=tag:hints.append({'code':'release_display_tag_difference','evidence_id':aid,'display_name':title,'tag':tag,'meaning':'Preserve distinction; do not silently resolve.'})
            date=dt(d.get('published_at'))
            if date:release_dates.append((aid,date))
        if d.get('source')=='github_public_issue':
            date=dt(d.get('updated_at')) or dt(d.get('published_at'))
            if date:issue_dates.append((aid,date))
            logs=re.search(r'### Relevant log output\s*(.*?)(?=\n### |\Z)',body,re.S)
            if logs and not re.sub(r'```\w*|_No response_|\s','',logs.group(1)):
                hints.append({'code':'no_supplied_logs','evidence_id':aid,'meaning':'Do not claim to have compared user logs.'})
    for iid,it in issue_dates:
        for rid,rt in release_dates:
            if it<rt:hints.append({'code':'issue_predates_release','issue_id':iid,'release_id':rid,'meaning':'Not evidence of a complaint after installing this release.'})
    return hints
