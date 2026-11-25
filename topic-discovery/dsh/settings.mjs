import { readFileSync } from 'node:fs';
import { localModelName } from './model-name.mjs';

export function localSettings() {
  const override = process.env.TOPIC_SETTINGS_FILE;
  let text;
  try {
    text = readFileSync(override || new URL('../.local/settings.json', import.meta.url), 'utf8');
  } catch (error) {
    if (!override && error.code === 'ENOENT') return {};
    throw error;
  }
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Topic settings must be a JSON object');
  }
  return settings;
}

export function configuredModel(name, settings) {
  const tag = localModelName(name ?? settings.defaultModel);
  const allowed = settings.allowedModels;
  if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.includes(tag))) {
    throw new Error('Model is outside the configured local allowlist');
  }
  return tag;
}

export function actionField(settings, task) {
  const field = settings.actionField ?? 'next_action';
  if (typeof field !== 'string' || !/^[a-z][a-z0-9_]{0,63}_action$/.test(field)) {
    throw new Error('Invalid candidate action field');
  }
  const expected = task?.expected_output?.candidates?.[0];
  return expected && !Object.hasOwn(expected, field) && Object.hasOwn(expected, 'next_action')
    ? 'next_action' : field;
}
