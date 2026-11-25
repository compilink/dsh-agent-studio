"""Bounded public feeds. Never forwards account credentials or follows arbitrary redirects."""
import urllib.request, urllib.error, xml.etree.ElementTree as ET
from datetime import datetime,timezone
from email.utils import parsedate_to_datetime
from .store import utcnow
from .settings import local_settings
FEEDS={
 'ollama': 'https://github.com/ollama/ollama/releases.atom',
 'langgraph': 'https://github.com/langchain-ai/langgraph/releases.atom',
 'langfuse': 'https://github.com/langfuse/langfuse/releases.atom',
}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('redirect_not_allowed')

def fetch_feed(name,limit=15):
    if name not in FEEDS:raise ValueError('source_not_allowlisted')
    if not 1<=limit<=30:raise ValueError('invalid_limit')
    req=urllib.request.Request(FEEDS[name],headers={'User-Agent':local_settings().get('feedUserAgent', 'TopicDiscovery/0.1 (public feed research)')})
    with urllib.request.build_opener(NoRedirect).open(req,timeout=20) as res:
        data=res.read(2_000_001)
    if len(data)>2_000_000:raise ValueError('response_budget_exceeded')
    if b'<!DOCTYPE' in data or b'<!ENTITY' in data:raise ValueError('unsafe_xml')
    root=ET.fromstring(data); ns={'a':'http://www.w3.org/2005/Atom'};out=[]
    for e in root.findall('a:entry',ns)[:limit]:
        links=e.findall('a:link',ns);link=next((l.get('href') for l in links if l.get('rel','alternate')=='alternate'),None)
        out.append(dict(source=name,id=e.findtext('a:id','',ns),url=link,title=e.findtext('a:title','',ns),published_at=e.findtext('a:published',None,ns) or e.findtext('a:updated',None,ns),updated_at=e.findtext('a:updated',None,ns),text=e.findtext('a:content','',ns),coverage='feed_latest_entries_only'))
    return out
