import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createStudio} from '../src/runtime.js';
import {StudioStore} from '../src/store.js';
import {WorkflowChecks, type RuleResult} from '../src/workflow-checks.js';

test('input files are pinned to one instance and node, and edited outputs must pass checks before handoff', async () => {
  const dir = await mkdtemp(join(tmpdir(),'studio-workflow-input-'));
  let studio = await createStudio({dataDir:dir,scheduler:{pollIntervalMs:15}});
  try {
    const run = await studio.createRun({prompt:'Open an independent run',mode:'direct'});
    const graph = {name:'Checked input', nodes:[
      {id:'a',name:'a',instruction:'Summarize the references',review:true,x:10,y:10,inputRule:'至少 2 份输入材料\n必须包含「alpha」',outputRule:'必须包含「approved-proof」'},
      {id:'b',name:'b',instruction:'Read the approved result',review:true,x:220,y:10,inputRule:'必须包含「approved-proof」'},
    ],edges:[{from:'a',to:'b'}]};
    const service = studio.workflows!;
    service.save('checked',{graph,expectedRevision:0}); service.publish('checked',{expectedRevision:1});
    const start = {runId:run.id,version:1,requestId:'same',files:[
      {nodeId:'a',name:'one.md',content:'alpha material'},{nodeId:'a',name:'two.txt',content:'second private input'}]};
    const initial = service.start('checked',start);
    assert.equal(service.start('checked',start).id,initial.id);
    assert.throws(()=>service.start('checked',{...start,files:[]}),/附件/);
    assert.throws(()=>service.start('checked',{...start,requestId:'bad-node',files:[{...start.files[0],nodeId:'unknown'}]}),/没有附件指定的节点/);
    const insufficient = service.start('checked',{...start,requestId:'missing',files:[]});
    assert.equal(insufficient.nodes[0]!.passes[0]!.stage,'failed');
    assert.equal(insufficient.nodes[0]!.passes[0]!.taskId,undefined);
    const pass = (node: string) => studio.workflows!.instances(run.id).find(i=>i.id===initial.id)!.nodes.find(n=>n.id===node)!.passes.at(-1)!;
    for (let i=0;i<500 && pass('a').stage!=='review';i++) await delay(20);
    assert.equal(pass('a').stage,'review');
    const task = (await studio.snapshot()).runs[0]!.tasks.find(t=>t.id===pass('a').taskId)!;
    assert.match(task.prompt,/alpha material/);
    assert.match(task.prompt,/second private input/);
    const approve = (content: string) => studio.workflows!.act(initial.id,'a',{action:'approve',round:1,taskId:pass('a').taskId,content});
    approve('insufficient edit');
    assert.equal(pass('a').stage,'review');
    assert.match(pass('a').note!,/检查未通过/);
    assert.equal(pass('b').taskId,undefined);
    await studio.close();
    studio = await createStudio({dataDir:dir,scheduler:{pollIntervalMs:15}});
    approve('approved-proof sealed by the reviewer');
    assert.equal(pass('a').stage,'released');
    assert.equal(studio.workflows!.releasedOutput(initial.id,'a',1).content,'approved-proof sealed by the reviewer');
    const next = (await studio.snapshot()).runs[0]!.tasks.find(t=>t.id===pass('b').taskId)!;
    assert.match(next.prompt,/approved-proof sealed by the reviewer/);
    assert.doesNotMatch(next.prompt,/second private input/);
  } finally {await studio.close(); await rm(dir,{recursive:true,force:true});}
});

test('independent model rule checks wait for commit, reuse only exact receipts and resume across restart', async () => {
  const dir=await mkdtemp(join(tmpdir(),'studio-rule-receipts-'));
  let store=new StudioStore(dir);
  let calls=0, release: ((result: RuleResult) => void) | undefined;
  const make=() => new WorkflowChecks(store,async()=>{
    calls++;
    return new Promise<RuleResult>(r=>{release=r;});
  },()=>{});
  let service=make();
  const select={provider:'local-provider',model:'validator'};
  const check=(body='a',scope='round-one') => service.check('run',[scope],'Check tone',[body],select);
  try {
    assert.throws(()=>store.atomic(()=>{check(); throw new Error('rollback');}),/rollback/);
    await delay(0);
    assert.equal(calls,0);
    assert.equal(check().status,'pending');
    assert.equal(check().status,'pending');
    await delay(0);
    assert.equal(calls,1);
    release!({status:'passed',reason:'Approved'});
    await delay(0);
    await service.close(); store.close();
    store=new StudioStore(dir); service=make();
    assert.equal(check().status,'passed');
    assert.equal(check('changed').status,'pending');
    await delay(0);
    assert.equal(calls,2);
    release!({status:'failed',reason:'Different content'});
    await delay(0);
    assert.equal(check('changed').status,'failed');
    assert.equal(check('a','round-two').status,'pending');
    await delay(0);
    assert.equal(calls,3);
    release!({status:'unknown',reason:'insufficient evidence'});
    await delay(0);
    assert.equal(check('a','round-two').status,'unknown');
  } finally {await service.close(); store.close(); await rm(dir,{recursive:true,force:true});}
});
