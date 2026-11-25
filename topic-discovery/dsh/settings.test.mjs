import test from 'node:test';
import assert from 'node:assert/strict';
import { actionField, configuredModel } from './settings.mjs';

test('configured local model and explicit model both respect the installation allowlist', () => {
  const settings = { defaultModel: 'demo:tiny', allowedModels: ['demo:tiny', 'demo:large'] };
  assert.equal(configuredModel(undefined, settings), 'demo:tiny');
  assert.equal(configuredModel('demo:large', settings), 'demo:large');
  assert.throws(() => configuredModel('demo:other', settings), /allowlist/);
  assert.throws(() => configuredModel(undefined, {}));
});

test('a previously exported task keeps its candidate action field', () => {
  const settings = { actionField: 'fixture_action' };
  assert.equal(actionField({}), 'next_action');
  assert.equal(actionField(settings), 'fixture_action');
  assert.equal(actionField(settings, { expected_output: { candidates: [{ next_action: 'task' }] } }), 'next_action');
  assert.throws(() => actionField({ actionField: 'status' }));
});
