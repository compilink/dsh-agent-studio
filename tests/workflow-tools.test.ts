import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import {CallId, type StreamChunk} from '@deepseek-ai/dsh-llm';
import {mountStudio} from '../src/runtime.js';

const name = 'studio_workflow';
const graph = {name:'Collect and review', nodes:[
  {id:'collect',name:'Collect',instruction:'Collect public data',review:true,x:20,y:40},
],edges:[]};

async function* fixtureCall(args: unknown): AsyncIterable<StreamChunk> {
  const id = CallId(randomUUID());
  const json = JSON.stringify(args);
  yield {type:'block-start',index:0,blockType:'tool-call'};
  yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:json};
  yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:json}};
  yield {type:'finish',reason:{kind:'tool-calls'}};
}

test('direct Orchestrator messages inspect, start and draft the same published canvas while other Run data stays scoped', {timeout:30_000}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'studio-chat-canvas-'));
  const ctx = new Context();
  const commands = new Map<string,{args:object; repeat:boolean}>();
  const observations: {kind:string;role:string;visible:boolean}[] = [];
  const results = new Map<string,{text:string;error:boolean}>();
  // The scripted model chooses a tool call. DSH validates and dispatches it through its normal Agent loop.
  ctx.on('llm/stream',(options,next) => {
    const last = options.messages.findLastIndex(m => m.role === 'user' && m.source.kind === 'plugin' && m.source.plugin === 'dsh-agent-studio');
    const input = options.messages[last]?.content.find(b => b.type === 'text');
    if (!input) return next();
    const envelope = JSON.parse(input.text);
    const role = /STUDIO_ROLE=(\w+)/.exec(options.system ?? '')?.[1] ?? '';
    observations.push({role,kind:envelope.kind,visible:!!options.tools?.some(tool => tool.name === name)});
    const action = commands.get(envelope.text);
    if (envelope.kind !== 'message' || !action) return next();
    const replies = options.messages.slice(last+1).flatMap(m => m.content.filter(c => c.type === 'tool-result'));
    if (replies.length < (action.repeat ? 2 : 1)) return fixtureCall(action.args);
    const tail = replies.at(-1)!;
    results.set(envelope.text,{text:tail.content.filter(p => p.type === 'text').map(p => p.text).join(''),error:!!tail.isError});
    return next();
  });
  const studio = await mountStudio(ctx,{dataDir:dir});
  try {
    const denied: Promise<boolean>[] = [];
    ctx.on('agent/created', async ({agent}) => {
      const state = await studio.snapshot();
      const member = state.runs.flatMap(r => r.agents).find(a => a.sessionId === agent.id)!;
      const result = ctx.tools.execute({name, arguments:{operation:'list_templates'}, agent, callId:CallId(randomUUID()),signal:new AbortController().signal});
      denied.push(result.then(value => !!value.isError && ['worker','manager','orchestrator'].includes(member.role)));
    });
    const service = studio.workflows!;
    service.save('shared',{expectedRevision:0,graph});
    const published = service.publish('shared',{expectedRevision:1});
    service.save('personal',{expectedRevision:0,graph:{...graph,name:'Private unpublished name'}});
    service.save('retired',{expectedRevision:0,graph:{...graph,name:'Old retired template'}});
    const old = service.publish('retired',{expectedRevision:1});
    service.setRetired('retired',{expectedRevision:old.revision,retired:true});
    const run = await studio.createRun({mode:'hierarchical',prompt:'First assignment'});
    const other = await studio.createRun({mode:'direct',prompt:'Separate assignment'});
    const foreign = service.start('shared',{version:1,runId:other.id,requestId:'other-workflow'});
    async function ask(args:object, repeat=false) {
      const label = 'Canvas operation '+randomUUID();
      commands.set(label,{args,repeat});
      await studio.sendMessage(run.id,label,randomUUID());
      for(let i=0;i<500&&!results.has(label);i++) await delay(10);
      const result = results.get(label);
      assert.ok(result,'tool call completed');
      return result;
    }
    const listing = await ask({operation:'list_templates'});
    assert.ok(!listing.error);
    assert.deepEqual(JSON.parse(listing.text).templates,[{id:'shared',name:graph.name,version:1}]);
    assert.ok((await ask({operation:'view_template',templateId:'personal'})).error);
    assert.ok((await ask({operation:'start',templateId:'retired',version:1})).error);
    assert.ok((await ask({operation:'view_instance',instanceId:foreign.id})).error);
    assert.ok((await ask({operation:'start',runId:other.id,templateId:'shared',version:1})).error);
    assert.ok((await ask({operation:'approve',instanceId:foreign.id})).error);
    assert.deepEqual(JSON.parse((await ask({operation:'list_instances'})).text).instances,[]);
    const inspected = JSON.parse((await ask({operation:'view_template',templateId:'shared'})).text);
    assert.deepEqual(inspected.graph,graph);
    const started = await ask({operation:'start',templateId:'shared',version:1},true);
    assert.ok(!started.error);
    const instance = service.instances(run.id)[0]!;
    assert.equal(service.instances(run.id).length,1,'repeated model call must not start multiple instances');
    assert.equal(service.instances(other.id).length,1);
    const view = await ask({operation:'view_instance',instanceId:instance.id});
    assert.equal(JSON.parse(view.text).nodes[0].id,'collect');
    const proposed = {...graph,name:'Edited draft',nodes:[{...graph.nodes[0]!,instruction:'Review the updated scope'}]};
    const proposal = {operation:'propose_draft',templateId:'shared',version:1,expectedRevision:inspected.revision,graph:proposed};
    const receipt = await ask(proposal);
    assert.ok(!receipt.error);
    assert.equal(JSON.parse(receipt.text).url,'/workflows.html?template=shared');
    const shared = service.templates().find(t => t.id === 'shared')!;
    assert.deepEqual(shared.draft,proposed);
    assert.deepEqual(service.graph('shared',1),graph);
    const current = await ask({operation:'view_template',templateId:'shared'});
    assert.deepEqual(JSON.parse(current.text).graph,graph);
    assert.ok(!current.text.includes(proposed.name));
    assert.ok((await ask({...proposal,expectedRevision:shared.revision,graph})).error,'never overwrite an unpublished draft');
    assert.ok((await ask(proposal)).error,'reject stale revisions');
    assert.equal(service.templates().find(t=>t.id==='shared')!.published,published.published);
    assert.equal(service.publish('shared',{expectedRevision:shared.revision}).published,2);
    assert.deepEqual(service.graph('shared',2),proposed);
    assert.equal(service.instances(run.id)[0]!.version,1);
    const checkedNode = {...graph.nodes[0]!,inputRule:'Include a source.',outputRule:'Include a citation.'};
    service.save('checks',{expectedRevision:0,graph:{...graph,nodes:[checkedNode]}});
    const checks = service.publish('checks',{expectedRevision:1});
    const newDraft = await ask({operation:'propose_draft',templateId:'checks',version:1,expectedRevision:checks.revision,
      graph:{...graph,nodes:[{...graph.nodes[0]!,name:'Updated label',outputRule:''}]}});
    assert.ok(!newDraft.error);
    const edited = service.templates().find(t => t.id === 'checks')!.draft.nodes[0]!;
    assert.equal(edited.inputRule,checkedNode.inputRule);
    assert.equal(edited.outputRule,'');
    assert.ok(observations.some(o=>o.role==='manager') && observations.some(o=>o.role==='worker'));
    assert.ok(observations.filter(o=>o.role!=='orchestrator'||o.kind!=='message').every(o=>!o.visible));
    assert.ok(observations.some(o=>o.role==='orchestrator'&&o.kind==='message'&&o.visible));
    assert.ok(denied.length >= 3 && (await Promise.all(denied)).every(Boolean));
  } finally {await studio.close();await rm(dir,{recursive:true,force:true});}
});
