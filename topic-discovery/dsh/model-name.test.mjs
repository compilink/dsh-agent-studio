import test from 'node:test';
import assert from 'node:assert/strict';
import { localModelName } from './model-name.mjs';

test('select an explicit local tag', () => {
  assert.equal(localModelName('demo/fixture:v1.2-q4'), 'demo/fixture:v1.2-q4');
});

test('reject missing names and configuration delimiters', () => {
  for (const value of [undefined, '', 'bad\nfield: value', 'bad # comment']) {
    assert.throws(() => localModelName(value));
  }
});
