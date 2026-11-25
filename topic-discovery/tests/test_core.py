import unittest,tempfile,json,urllib.request,threading,time
from pathlib import Path
from topic_discovery.store import Store
from topic_discovery.pipeline import run_pipeline
from topic_discovery.dsh_bridge import export_task,validate_response
class Core(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.s=Store(Path(self.tmp.name)/'db');self.docs=[dict(url='https://example.org/release',title='release',text='new features',published_at='2026-11-13T00:00:00Z')]
 def tearDown(self):self.s.db.close();self.tmp.cleanup()
 def test_dsh_gate(self):
  r=run_pipeline(self.s,self.docs,now='2026-11-13T12:00:00Z');p=export_task(self.s,r['run_id'])
  self.assertEqual(p['execution_status'],'not_submitted')
  with self.assertRaises(ValueError):validate_response(p,{'schema_version':'1.0','run_id':r['run_id'],'candidates':[{'status':'approved'}]})
 def test_snapshot_retained_and_persistence(self):
  r=run_pipeline(self.s,self.docs,now='2026-11-13T12:00:00Z');rid=r['run_id']
  self.assertEqual(len(self.s.run(rid)['modules']),7)
  for m in self.s.run(rid)['modules']:self.assertIn('completed_snapshot',m)
  s2=Store(Path(self.tmp.name)/'db');self.assertEqual(s2.run(rid)['cursor'],13);s2.db.close()
 def test_secret_title_not_saved(self):
  self.docs[0]['title']='api_key=secret123'
  r=run_pipeline(self.s,self.docs,now='2026-11-13T12:00:00Z')
  self.assertNotIn('secret123',json.dumps(self.s.run(r['run_id'])))
  self.assertEqual(self.s.artifacts(),[])
 def test_budget(self):
  with self.assertRaises(ValueError):run_pipeline(self.s,self.docs*201)
if __name__=='__main__':unittest.main()

class ClaimValidation(unittest.TestCase):
 def test_quote_only_does_not_imply_audience(self):
  from topic_discovery.dsh_bridge import validate_claims
  p={'evidence':[{'artifact_id':'e','data':{'source':'release','title':'release','text':'uses mmap'}}]}
  card={'evidence_ids':['e'],'source_claims':[{'claim':'uses mmap','quote':'uses mmap','evidence_id':'e','verification_status':'source_claim_only'}],'audience_question':{'question':'why','quote':'uses mmap','evidence_id':'e'}}
  with self.assertRaisesRegex(ValueError,'audience_evidence'):validate_claims(p,[card])
 def test_exact_quote_required(self):
  from topic_discovery.dsh_bridge import validate_claims
  p={'evidence':[{'artifact_id':'e','data':{'text':'uses mmap'}}]}
  card={'source_claims':[{'quote':'much faster','evidence_id':'e','verification_status':'source_claim_only'}]}
  with self.assertRaisesRegex(ValueError,'quote_not'):validate_claims(p,[card])
