import tempfile, unittest
from pathlib import Path
from topic_discovery.store import Store
from topic_discovery.pipeline import run_pipeline

class Metrics(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.path=Path(self.tmp.name)/'db';self.s=Store(self.path)
 def tearDown(self):self.s.db.close();self.tmp.cleanup()
 def run_docs(self,docs):return run_pipeline(self.s,docs,now='2026-11-16T12:00:00Z')
 def doc(self,**kw):return dict(dict(url='https://example.org/a',title='a',text='a',published_at='2026-11-15T00:00:00Z'),**kw)
 def test_measured_quality_is_not_semantic_approval(self):
  r=self.run_docs([self.doc(),self.doc(),self.doc(url='https://example.org/b',text='b',published_at=None)])
  m={m['module_id']:m for m in r['snapshot']['modules']}
  self.assertEqual(m['normalize']['summary']['window_document_counts'],{'3':2,'7':2,'30':2})
  self.assertEqual(m['normalize']['summary']['unknown_date_count'],1)
  self.assertEqual(m['deduplicate']['output_count'],2)
  for name in ['normalize','deduplicate','resolve','verify','track','edit']:
   self.assertIn('input_unit',m[name]); self.assertIn('output_unit',m[name])
   q=next(q for q in m[name]['quality'] if q['name']=='semantic_accuracy')
   self.assertIsNone(q['value']); self.assertEqual(q['status'],'pending')
  q=next(q for q in m['verify']['quality'] if q['name']=='claim_verification_coverage')
  self.assertIsNone(q['denominator'])
 def test_old_change_history_and_repeat(self):
  d=self.doc(published_at='2026-09-01T00:00:00Z');self.assertEqual(self.run_docs([d])['candidates'],[])
  r=self.run_docs([dict(d,text='new content')]);self.assertEqual(len(r['candidates']),1)
  self.assertEqual(r['candidates'][0]['change_status'],'changed_content_pending_review')
  self.assertEqual(self.run_docs([dict(d,text='new content')])['candidates'],[])
 def test_module_commit_visible_before_pipeline_finish(self):
  seen=[];original=self.s.transition
  def watch(rid,module,state,event_type='module.completed',event_id=None):
   out=original(rid,module,state,event_type,event_id)
   if event_type=='module.completed':
    other=Store(self.path);snapshot=other.run(rid);other.db.close()
    self.assertEqual(snapshot['run']['status'],'running')
    observed=next(m for m in snapshot['modules'] if m['module_id']==module)
    self.assertEqual(observed['output_count'],state['output_count'])
    self.assertEqual(snapshot['events'][-1]['module_id'],module);seen.append(module)
   return out
  self.s.transition=watch;self.run_docs([self.doc()])
  self.assertEqual(seen,['collect','normalize','deduplicate','resolve','verify','track','edit'])
 def test_empty_is_not_quality_success(self):
  r=self.run_docs([])
  for m in r['snapshot']['modules']:
   for q in m['quality']:
    self.assertNotEqual(q['status'],'completed')
    self.assertIsNone(q['value'])
