import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from topic_discovery.dsh_bridge import validate_response
from topic_discovery.server import dashboard_page
from topic_discovery.settings import action_field, local_settings


class LocalSettingsTest(unittest.TestCase):
    def test_check_record_using_its_exported_action_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'settings.json'
            config.write_text(json.dumps({'actionField': 'fixture_action'}))
            with patch.dict(os.environ, {'TOPIC_SETTINGS_FILE': str(config)}):
                for field in ['fixture_action', 'next_action']:
                    task = {'run_id': 'test', 'evidence': [{'artifact_id': 'e1'}],
                            'expected_output': {'candidates': [{field: 'specific task'}]}}
                    card = {'title': 'Example', 'status': 'needs_user_discussion',
                            'evidence_ids': ['e1'], 'hook': 'Why', 'retention': 'How',
                            field: 'Review', 'verification_plan': 'Compare'}
                    response = {'schema_version': '1.0', 'run_id': 'test', 'candidates': [card]}
                    self.assertEqual(validate_response(task, response), [card])
                    del card[field]
                    with self.assertRaisesRegex(ValueError, 'missing_' + field):
                        validate_response(task, response)
                self.assertEqual(action_field(local_settings()), 'fixture_action')

    def test_dashboard_labels_are_escaped(self):
        page = '<title>选题雷达</title><!-- dashboard-label -->'
        self.assertEqual(dashboard_page(page, {'dashboardTitle': '<test>', 'dashboardLabel': '&'}),
                         '<title>&lt;test&gt;</title><small>&amp;</small>')
        self.assertEqual(dashboard_page(page, {}), '<title>选题雷达</title>')
