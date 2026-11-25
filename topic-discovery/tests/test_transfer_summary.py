import importlib.util,json,tempfile,unittest,hashlib
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'evaluation/summarize_transfer.py'
spec=importlib.util.spec_from_file_location('transfer',p);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class Summary(unittest.TestCase):
 def test_missing_output_does_not_shrink_denominator(self):
  with tempfile.TemporaryDirectory() as tmp:
   d=Path(tmp)/'d';r=Path(tmp)/'r';b=json.dumps({'cases':[{'id':'a','expected':'supported'},{'id':'b','expected':'unsupported'}],'real_source_case_count':0}).encode();d.write_bytes(b)
   output={'dataset_sha256':hashlib.sha256(b).hexdigest(),'checks':[{'parsed':{'id':'a','verdict':'supported'},'format_valid':True}]};r.write_text(json.dumps(output))
   result=mod.summarize(d,r);self.assertEqual(result['label_agreement'],{'numerator':1,'denominator':2});self.assertEqual(result['missing_ids'],['b']);self.assertFalse(result['semantic_acceptance'])
   output['checks']*=2;r.write_text(json.dumps(output))
   with self.assertRaises(ValueError):mod.summarize(d,r)
 def test_changed_dataset_is_rejected(self):
  with tempfile.TemporaryDirectory() as tmp:
   d=Path(tmp)/'d';r=Path(tmp)/'r';d.write_text('{"cases":[]}');r.write_text('{"dataset_sha256":"wrong"}')
   with self.assertRaises(ValueError):mod.summarize(d,r)
