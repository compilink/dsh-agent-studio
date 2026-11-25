import unittest
from topic_discovery.claim_metrics import evaluate
class ClaimMetrics(unittest.TestCase):
 def test_omission_cannot_inflate(self):
  r=evaluate([{'id':'a','truth':'supported'},{'id':'b','truth':'unsupported'}],[{'id':'x'}],[{'gold_id':'a','extracted_id':'x'}],{'a':'supported'})
  self.assertEqual(r['quality'][0]['value'],.5);self.assertEqual(r['quality'][1]['value'],0);self.assertEqual(r['quality'][3]['value'],.5)
  self.assertEqual(r['counts']['omitted_error_ids'],['b'])
 def test_empty_is_unknown(self):
  self.assertTrue(all(x['value'] is None for x in evaluate([],[],[],{})['quality']))
 def test_unknown_not_false(self):
  r=evaluate([{'id':'a','truth':'unknown'}],[],[],{})
  self.assertIsNone(r['quality'][3]['value']);self.assertEqual(r['counts']['unknown_gold_ids'],['a'])
 def test_bad_alignment(self):
  with self.assertRaises(ValueError): evaluate([],[],[{'gold_id':'x','extracted_id':'y'}],{})
