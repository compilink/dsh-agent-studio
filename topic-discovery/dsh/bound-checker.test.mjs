import test from 'node:test';import assert from 'node:assert/strict';
import {bindEvidence,validateBoundOutput} from './bound-checker.mjs';
const c={id:'a',claim:'支持X和Y',bound_ids:['one'],evidence:[{id:'one',text:'支持X'},{id:'two',text:'支持Y'}]};
test('unbound evidence and expected never enter request',()=>assert.deepEqual(bindEvidence({...c,expected:'unsupported'}),{id:'a',claim:'支持X和Y',evidence:[{id:'one',text:'支持X'}]}));
test('cross evidence quote rejected',()=>assert.equal(validateBoundOutput(bindEvidence(c),{id:'a',verdict:'supported',quotes:[{evidence_id:'two',quote:'支持Y'}]}),false));
test('same bound ID cannot borrow unbound text',()=>assert.equal(validateBoundOutput(bindEvidence(c),{id:'a',verdict:'supported',quotes:[{evidence_id:'one',quote:'支持Y'}]}),false));
test('unknown binding fails closed',()=>assert.throws(()=>bindEvidence({...c,bound_ids:['no']})));
test('quote presence does NOT establish semantics',()=>assert.equal(validateBoundOutput(bindEvidence(c),{id:'a',verdict:'supported',quotes:[{evidence_id:'one',quote:'支持X'}]}),true));
