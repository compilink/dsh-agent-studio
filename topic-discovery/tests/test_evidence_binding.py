import unittest
from topic_discovery.dsh_bridge import validate_claims
class Binding(unittest.TestCase):
 def setUp(self):
  self.p={'evidence':[{'artifact_id':'a','data':{'text':'支持X'}},{'artifact_id':'b','data':{'text':'支持Y'}}]}
 def card(self,e='a',quote='支持X',claim='支持X和Y'):
  return {'evidence_ids':['a'],'source_claims':[{'evidence_id':e,'quote':quote,'claim':claim,'verification_status':'source_claim_only'}]}
 def test_known_but_unlinked(self):
  with self.assertRaisesRegex(ValueError,'claim_evidence_not_linked'):validate_claims(self.p,[self.card('b','支持Y')])
 def test_borrowed_quote(self):
  with self.assertRaisesRegex(ValueError,'quote_not_in_source'):validate_claims(self.p,[self.card('a','支持Y')])
 def test_partial_support_never_auto_verified(self):
  c=validate_claims(self.p,[self.card()])[0]
  self.assertEqual(c['status'],'pending_semantic_review');self.assertFalse(c['publish_approved'])
