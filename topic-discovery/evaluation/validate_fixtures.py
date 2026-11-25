"""Validate frozen evaluation INPUTS, not the production implementation."""
import hashlib,json,pathlib,unittest
P=pathlib.Path(__file__).parent
class FixtureIntegrity(unittest.TestCase):
 def setUp(self):
  self.raw=(P/'frozen-cases-v1.json').read_bytes(); self.pack=json.loads(self.raw)
 def test_manifest(self):
  m=json.loads((P/'manifest.json').read_text()); self.assertEqual(hashlib.sha256(self.raw).hexdigest(),m['sha256']); self.assertEqual(len(self.pack['cases']),m['case_count']); self.assertEqual(len(self.pack['protocol_scenarios']),m['protocol_scenario_count'])
 def test_unique_cases(self):
  ids=[x['id'] for x in self.pack['cases']+self.pack['protocol_scenarios']]; self.assertEqual(len(ids),len(set(ids)))
 def test_required_coverage(self):
  cats={c['category'] for c in self.pack['cases']}; self.assertTrue({'date','old_news','dedup','followup','evidence','security','privacy'}<=cats)
 def test_synthetic_only(self):
  for c in self.pack['cases']:
   for d in c['documents']: self.assertTrue(d['url'].startswith('https://example.invalid/'))
 def test_expected_values(self):
  for c in self.pack['cases']+self.pack['protocol_scenarios']: self.assertTrue(c.get('expect'))
if __name__=='__main__': unittest.main()
