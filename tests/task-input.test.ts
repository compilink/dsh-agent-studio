import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import {CallId, type GenerateOptions, type StreamChunk} from '@deepseek-ai/dsh-llm';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {mountStudio} from '../src/runtime.js';
import {presentTaskInputs, readInputPage, taskInputSources} from '../src/task-input.js';
import type {DeliveryView, TaskView, Studio} from '../src/types.js';

const delivery: DeliveryView = {id:'delivery',runId:'r',taskId:'t',agentId:'a',kind:'task',text:'short',state:'running',failures:0,nextAt:0,createdAt:''};
const task: TaskView = {id:'t',runId:'r',coordinatorId:'a',prompt:'original short',requestId:'request',title:'t',status:'running',createdAt:'',updatedAt:''};

test('short inputs keep their original envelope and page offsets round trip literal text', () => {
  const sources = taskInputSources(delivery,task);
  assert.deepEqual(presentTaskInputs(sources),{text:'short'});
  assert.deepEqual(taskInputSources({...delivery,kind:'message',taskId:undefined}),[{kind:'delivery',text:'short'}]);
  assert.throws(() => taskInputSources(delivery,{...task,id:'sibling'}), /does not belong/);
  assert.throws(() => taskInputSources(delivery,{...task,runId:'other'}), /does not belong/);
  const body = '📗开头\n'.repeat(4200) + 'FINAL';
  const long = taskInputSources({...delivery,text:body},{...task,prompt:body});
  const view = presentTaskInputs(long);
  assert.equal(view.text.length,1200);
  assert.equal(view.inputPages?.length,1);
  let offset = 0, joined = '';
  for (;;) {
    const page = readInputPage(long,0,offset,3999);
    joined += page.content;
    if (page.nextOffset == null) break;
    offset = page.nextOffset;
  }
  assert.equal(joined,body);
  assert.equal(readInputPage(long,0,0,5,'FINAL').content,'FINAL');
  assert.equal(readInputPage(long,0,0,5,'missing').found,false);
  assert.throws(() => readInputPage(long,1,0,5), /没有/);
});

function latest(options: Pick<GenerateOptions, 'messages'>) {
  const index = options.messages.findLastIndex(message => message.role === 'user' && message.source.kind === 'plugin' && message.source.plugin === 'dsh-agent-studio');
  const block = options.messages[index]?.content.find(block => block.type === 'text');
  if (!block) return;
  const value = JSON.parse(block.text) as {kind:string; taskId:string; attemptId?:string; deliveryId:string; text:string; inputPages?:{source:number; kind:string; characters:number}[]};
  return {value,index};
}

async function* readTool(deliveryId: string): AsyncGenerator<StreamChunk> {
  const id = CallId(randomUUID());
  const name = 'studio_read_input';
  const args = JSON.stringify({deliveryId, source:1, find:'END-MARKER:', limit:64});
  yield {type:'block-start',index:0,blockType:'tool-call'};
  yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args};
  yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}};
  yield {type:'finish',reason:{kind:'tool-calls'}};
}

async function waitFor(studio: Studio, id: string, status: string) {
  for (let i = 0; i < 500; i++) {
    const state = await studio.snapshot();
    const run = state.runs.find(run => run.tasks.some(task => task.id === id && task.status === status));
    if (run) return run;
    await delay(10);
  }
  throw new Error('Expected task status ' + status);
}

test('real tool calls read the pinned tail after retry; adjacent tasks on the same coordinator cannot reopen it', {timeout:30000}, async () => {
  const folder = await mkdtemp(join(tmpdir(),'studio-input-'));
  const ctx = new Context();
  const roots = new Map<string,string>();
  const pages = new Map<string,string>();
  const adjacent: boolean[] = [];
  let planner: Agent | undefined;
  let failOnce = true;
  let firstTaskId: string | undefined;
  ctx.on('agent/created', ({agent}) => { if (agent.options.model === 'planner') planner = agent; });
  ctx.on('llm/stream', async function* (request,next) {
    const item = latest(request);
    if (!item || item.value.kind !== 'task') return yield* next();
    const {value,index} = item;
    if (request.model === 'executor') {
      const calls = request.messages.slice(index + 1).flatMap(m => m.content.filter(b => b.type === 'tool-call'));
      if (!calls.some(b => b.name === 'studio_read_input')) {
        assert.ok(value.inputPages?.some(s => s.kind === 'task' && s.characters > 150000));
        assert.ok(!JSON.stringify(value).includes('END-MARKER:'));
        return yield* readTool(value.deliveryId);
      }
    }
    if (request.model === 'planner' && !roots.has(value.taskId)) {
      assert.equal(value.inputPages?.length,1);
      assert.ok(!JSON.stringify(value).includes('END-MARKER:'));
      if (!firstTaskId) firstTaskId = value.taskId;
      else {
        const read = (args:object) => ctx.tools.execute({agent:planner!,callId:CallId(randomUUID()),name:'studio_read_input',arguments:args,signal:new AbortController().signal});
        const old = await read({deliveryId:roots.get(firstTaskId),source:0,find:'first-tail'});
        const own = await read({deliveryId:value.deliveryId,source:0,find:'first-tail'});
        const body = own.content.find(block => block.type === 'text');
        adjacent.push(!!old.isError && !own.isError && !!body && JSON.parse(body.text).found === false);
      }
      roots.set(value.taskId,value.deliveryId);
    }
    if (request.model === 'executor' && !pages.has(value.deliveryId)) {
      const result = request.messages.slice(index+1).flatMap(m => m.content.filter(b => b.type === 'tool-result'))[0];
      if (result) {
        assert.ok(!result.isError);
        const block = result.content.find(b => b.type === 'text')!;
        const page = JSON.parse(block.text);
        assert.ok(page.start > 150000 && page.nextOffset === null);
        pages.set(value.deliveryId,page.content);
        if (failOnce) { failOnce = false; throw new Error('One-shot provider failure after reading the tail'); }
      }
    }
    return yield* next();
  });
  const studio = await mountStudio(ctx,{dataDir:folder,scheduler:{maxDeliveryAttempts:1,pollIntervalMs:10}});
  try {
    const large = '长正文。'.repeat(40000);
    const run = await studio.createRun({mode:'direct',prompt:large + 'END-MARKER:first-tail'});
    const id = run.tasks[0]!.id;
    await waitFor(studio,id,'failed');
    await studio.retryTask(run.id,id);
    const resumed = await waitFor(studio,id,'completed');
    assert.deepEqual(resumed.attempts.map(a => a.status),['failed','reported']);
    const second = await studio.addTask(run.id,{prompt:large + 'END-MARKER:second-tail',requestId:'second'});
    await waitFor(studio,second.id,'completed');
    assert.deepEqual([...pages.values()],['END-MARKER:first-tail','END-MARKER:first-tail','END-MARKER:second-tail']);
    assert.deepEqual(adjacent,[true]);
  } finally { await studio.close(); await rm(folder,{recursive:true,force:true}); }
});

test('actual DSH compaction restores the current long-input directory and keeps full bodies out of the recovery message', {timeout:15000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(),'studio-input-compaction-'));
  const ctx = new Context();
  let compacted = false;
  let recovered = false;
  ctx.on('agent/created', ({agent}) => {
    if (agent.options.model !== 'executor') return;
    agent.ctx.on('agent/pre-step', async ({step,signal}, next) => {
      const decision = await next();
      if (step === 5 && !compacted) {
        compacted = true;
        const nodes = [...agent.session.surface.nodes];
        await ctx.compaction.compactRegion(nodes[0]!,nodes.at(-1)!,agent,signal);
      }
      return decision;
    });
  });
  ctx.on('session/event', (_session,event) => {
    if (event.type !== 'user/message' || !event.data.id.startsWith('studio-memory-recovery:')) return;
    const block = event.data.content.find(block => block.type === 'text')!;
    const recalled = JSON.parse(block.text);
    const taskSource = recalled.inputPages.find((s:{kind:string}) => s.kind === 'task');
    recovered = !!recalled.deliveryId && taskSource.characters > 20_000 && !block.text.includes('end-only-marker') && block.text.length < 8000;
  });
  const studio = await mountStudio(ctx,{dataDir,compaction:{auto:false}});
  try {
    const run = await studio.createRun({mode:'direct',prompt:'fixture '.repeat(3000)+'end-only-marker'});
    await waitFor(studio,run.tasks[0]!.id,'completed');
    assert.ok(compacted && recovered);
  } finally { await studio.close(); await rm(dataDir,{recursive:true,force:true}); }
});
