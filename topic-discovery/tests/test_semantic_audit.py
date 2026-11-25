import unittest,copy
from topic_discovery.review_gate import readiness,candidate_hash
class AuditGate(unittest.TestCase):
 def setUp(self):
  self.c={'title':'有限范围的测试','hook':'数值较高，尚未显著','verification_status':'source_claim_only','evidence_ids':['e']}
  self.audit={'candidate_sha256':candidate_hash(self.c),'kind':'supervising_review','inventory_complete':True,'nonfactual_fields':['title'],'claims':[{'id':'c1','fields':['hook'],'verdict':'supported','evidence_ids':['e'],'reason':'仅表述数值差异，未强化显著性。'}]}
 def review(self,a=None):return {'candidate_sha256':candidate_hash(self.c),'kind':'supervising_review','decision':'accept_for_discussion','claim_audit':self.audit if a is None else a}
 def test_complete_review_is_discussion_only(self):
  r=readiness(self.c,['e'],self.review());self.assertTrue(r['ready_for_discussion']);self.assertFalse(r['production_approved']);self.assertFalse(r['publish_approved'])
 def test_partial_coverage_never_full_pass(self):
  self.c['summary']='额外事实';self.audit['candidate_sha256']=candidate_hash(self.c)
  r=readiness(self.c,['e'],self.review());self.assertFalse(r['ready_for_discussion']);self.assertEqual(r['claim_coverage']['unreviewed_fields'],['summary'])
 def test_unsupported_and_unknown_are_counted_not_dropped(self):
  for verdict in ['unsupported','unknown']:
   self.audit['claims'][0]['verdict']=verdict;r=readiness(self.c,['e'],self.review());self.assertFalse(r['ready_for_discussion']);self.assertEqual(r['claim_coverage'][verdict],1)
 def test_model_self_review_is_not_independent(self):
  self.audit['kind']='model_self_score';self.assertFalse(readiness(self.c,['e'],self.review())['ready_for_discussion'])
 def test_inventory_change_invalidates_review(self):
  self.c['hook']='显著提高';self.assertFalse(readiness(self.c,['e'],self.review())['ready_for_discussion'])
 def test_missing_or_duplicate_claims_fail(self):
  self.audit['claims']*=2;self.assertFalse(readiness(self.c,['e'],self.review())['ready_for_discussion'])
 def test_unknown_evidence_fails(self):
  self.audit['claims'][0]['evidence_ids']=['other'];self.assertFalse(readiness(self.c,['e'],self.review())['ready_for_discussion'])
 def test_old_review_without_coverage_fails_closed(self):
  r=self.review();r.pop('claim_audit');self.assertFalse(readiness(self.c,['e'],r)['ready_for_discussion'])
