"""Independent scaffold acceptance. Uses temporary DB, never network or live data."""
import json,pathlib,tempfile,unittest,sys
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from topic_discovery.pipeline import run_pipeline
from topic_discovery.store import Store
PACK=json.loads((ROOT/'evaluation/frozen-cases-v1.json').read_text())
CASES={c['id']:c for c in PACK['cases']}
class Acceptance(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.store=Store(pathlib.Path(self.tmp.name)/'eval.sqlite')
 def tearDown(self):self.store.db.close();self.tmp.cleanup()
 def run_case(self,k):return run_pipeline(self.store,CASES[k]['documents'],now=PACK['frozen_now'])
 def test_rolling_windows(self):
  for case,n in [('recent_3d',3),('recent_7d',7),('recent_30d',30),('boundary_3d',3),('timezone_equivalent',3)]:
   with self.subTest(case=case):
    r=self.run_case(case); self.assertEqual(min(r['candidates'][0]['windows']),n)
 def test_unknown_invalid_future_excluded(self):
  for c in ['missing_date','invalid_date','future_date']:
   with self.subTest(case=c):self.assertEqual(self.run_case(c)['candidates'],[])
 def test_old_event_not_recent(self):self.assertEqual(self.run_case('old_reposted')['candidates'],[])
 def test_cross_url_exact_reprint(self):self.assertEqual(len(self.run_case('exact_reprint')['candidates']),1)
 def test_exact_retry_dedup(self):self.assertEqual(len(self.run_case('same_id_retry')['candidates']),1)
 def test_stable_second_observation_not_candidate(self):
  self.run_case('recent_3d');self.assertEqual(self.run_case('recent_3d')['candidates'],[])
 def test_no_false_verification_or_production(self):
  for c in ['vendor_claim_only','conflicting_sources','prompt_injection']:
   with self.subTest(case=c):
    for card in self.run_case(c)['candidates']:
     self.assertEqual(card['verification_status'],'unverified');self.assertFalse(card['production_approved']);self.assertFalse(card['publish_approved'])
 def test_content_secrets_not_retained(self):
  r=self.run_case('credential_marker');data=json.dumps([r,self.store.artifacts(),self.store.events()])
  for s in CASES['credential_marker']['expect']['forbidden_output_substrings']:self.assertNotIn(s,data)
 def test_url_secret_not_in_events(self):
  doc=dict(CASES['recent_3d']['documents'][0],url='https://example.invalid/x?token=FIXTURE_TOKEN_ONLY')
  r=run_pipeline(self.store,[doc],now=PACK['frozen_now']);data=json.dumps([r,self.store.artifacts(),self.store.events()]);self.assertNotIn('FIXTURE_TOKEN_ONLY',data)
 def test_duplicate_transition_idempotent(self):
  rid=self.store.new_run('fixture',PACK['frozen_now']);s={'status':'running','input_count':1}
  self.assertTrue(self.store.transition(rid,'test',s,'module.started',event_id='stable'))
  self.assertFalse(self.store.transition(rid,'test',s,'module.started',event_id='stable'));self.assertEqual(len(self.store.events(rid)),1)
 def test_partial_quality_not_claimed_accuracy(self):
  r=self.run_case('recent_3d')
  for m in r['snapshot']['modules']:
   for q in m['quality']:
    if q['name']=='semantic_accuracy':self.assertIsNone(q['value']);self.assertEqual(q['status'],'pending')
    elif q['status']=='completed':self.assertEqual(q['method'],'rule');self.assertIn('definition',q)
 def test_count_partition(self):
  r=self.run_case('same_id_retry')
  for m in r['snapshot']['modules']:self.assertEqual(m['input_count'],sum(m[k] for k in ['completed_count','failed_count','skipped_count','pending_count']))
if __name__=='__main__':unittest.main()
