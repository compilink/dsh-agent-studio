import json
from pathlib import Path
import tempfile
import unittest
from topic_discovery.pipeline import run_pipeline
from topic_discovery.store import Store

EXAMPLES = Path(__file__).resolve().parents[1] / 'examples'
AS_OF = '2024-06-10T12:00:00Z'


class PublicationState(unittest.TestCase):
    def test_creation_date_is_not_a_publication_date(self):
        documents = json.loads((EXAMPLES / 'sample-input.json').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / 'offline.sqlite')
            self.addCleanup(store.db.close)
            result = run_pipeline(store, documents, now=AS_OF)
            rows = {a['data']['source_id']: a['data'] for a in store.artifacts(kind='normalize')}
            self.assertEqual(rows['published']['windows'], [3, 7, 30])
            self.assertEqual(rows['unknown-publication']['windows'], [])
            self.assertEqual(rows['unknown-publication']['date_status'], 'unknown')
            self.assertEqual(len(result['candidates']), 1)
            self.assertFalse(result['candidates'][0]['publish_approved'])
            self.assertFalse(result['candidates'][0]['production_approved'])
            self.assertEqual(run_pipeline(store, documents, now=AS_OF)['candidates'], [])


if __name__ == '__main__':
    unittest.main()
