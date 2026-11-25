"""Installation-specific display and candidate settings."""
import json
import os
import re
from pathlib import Path

DEFAULT_FILE = Path(__file__).resolve().parents[1] / '.local' / 'settings.json'


def local_settings():
    path = os.environ.get('TOPIC_SETTINGS_FILE')
    try:
        data = json.loads(Path(path or DEFAULT_FILE).read_text(encoding='utf-8'))
    except FileNotFoundError:
        if path:
            raise
        return {}
    if not isinstance(data, dict):
        raise ValueError('Topic settings must be a JSON object')
    return data


def action_field(settings, task=None):
    field = settings.get('actionField', 'next_action')
    if not isinstance(field, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}_action', field):
        raise ValueError('Invalid candidate action field')
    candidates = (task or {}).get('expected_output', {}).get('candidates', [])
    if candidates and field not in candidates[0] and 'next_action' in candidates[0]:
        return 'next_action'
    return field
