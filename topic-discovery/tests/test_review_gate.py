import unittest
from topic_discovery.review_gate import readiness,candidate_hash
class Gate(unittest.TestCase):
 def setUp(self):self.c={'verification_status':'source_claim_only','evidence_ids':['e'],'hook':'hypothesis'}
 def test_model_accept_not_enough(self):
  r={'candidate_sha256':candidate_hash(self.c),'decision':'accept_for_discussion','kind':'model_self_score'}
  self.assertFalse(readiness(self.c,['e'],r)['ready_for_discussion'])
 def test_changed_text_invalidates_review(self):
  r={'candidate_sha256':candidate_hash(self.c),'decision':'accept_for_discussion','kind':'supervising_review'}
  self.c['hook']='changed';self.assertFalse(readiness(self.c,['e'],r)['ready_for_discussion'])
 def test_review_never_produces_video_approval(self):
  r={'candidate_sha256':candidate_hash(self.c),'decision':'accept_for_discussion','kind':'supervising_review'}
  r['claim_audit']={'candidate_sha256':candidate_hash(self.c),'kind':'supervising_review','inventory_complete':True,'nonfactual_fields':['hook'],'claims':[]}
  result=readiness(self.c,['e'],r);self.assertTrue(result['ready_for_discussion']);self.assertFalse(result['production_approved']);self.assertFalse(result['publish_approved'])
if __name__=='__main__':unittest.main()
