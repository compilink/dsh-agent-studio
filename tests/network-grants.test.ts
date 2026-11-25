import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import type {Agent} from '@deepseek-ai/dsh-agent';
import {CallId} from '@deepseek-ai/dsh-llm';
import {NetworkGrants} from '../src/network-grants.js';
import {StudioStore} from '../src/store.js';
import {mountStudio} from '../src/runtime.js';
import type {AgentTemplate} from '../src/types.js';

test('grant periods bound source links to the owning attempt, abort on removal and survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(),'studio-network-grants-'));
  const url = 'https://museum.org/item?id=9';
  let seenSignal: AbortSignal | undefined;
  let store = new StudioStore(dir);
  try {
    const network = new NetworkGrants(store,async (operation, value, signal, _settings, known) => {
      if (value === 'pending') { seenSignal = signal; await new Promise<void>((_resolve,reject) => signal!.addEventListener('abort',() => reject(new Error('revoked')),{once:true})); }
      if (operation === 'fetch') assert.equal(known, true);
      return {sources:[{title:'Museum',url,retrievedAt:'2026-01-01',excerpt:'Exhibit'}]};
    });
    const template:AgentTemplate = {id:'research',name:'research',systemPrompt:'',role:'worker', version:1, selection:{provider:'studio-demo',model:'executor'},memoryIdentityId:'identity'};
    const save = (version:number,publicNetwork:boolean) => store.atomic(()=>{const t = {...template,version,publicNetwork};store.saveTemplate(t);network.configure(t);});
    const old = {role:'worker' as const,id:'w',runId:'run',templateId:template.id,templateVersion:1};
    const worker = {...old,templateVersion:2}, signal = new AbortController().signal;
    save(1,false);
    save(2,true);
    await assert.rejects(network.execute(old,'task','attempt','fetch',url,signal),/未获/);
    await network.execute(worker,'task','attempt','search','exhibit',signal);
    await network.execute(worker,'task','attempt','fetch',url,signal);
    await assert.rejects(network.execute(worker,'task','other-attempt','fetch',url,signal));
    const pending = network.execute(worker,'task','attempt','search','pending',signal);
    save(3,false);
    assert.equal(seenSignal?.aborted,true);
    save(4,true);
    await assert.rejects(pending,/revoked/);
    assert.equal(network.grant(worker),undefined);
    assert.ok(network.grant({...worker,templateVersion:4}));
    store.close();store=new StudioStore(dir);
    const restored = new NetworkGrants(store);
    assert.equal(restored.recent()[0]?.outcome,'denied');
    assert.deepEqual(restored.recent().find(call=>call.outcome==='allowed')?.sources,[{title:'Museum',url,retrievedAt:'2026-01-01'}]);
    assert.ok(restored.grant({...worker,templateVersion:4}));
  } finally { store.close(); await rm(dir,{recursive:true,force:true}); }
});

test('live Worker tools require the current attempt and recheck template revocation on each call', {timeout:15000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'studio-network-runtime-'));
  const ctx=new Context();
  let ready!: (agent:Agent)=>void, resume!: ()=>void;
  const worker=new Promise<Agent>(resolve=>{ready=resolve;});
  const gate=new Promise<void>(resolve=>{resume=resolve;});
  ctx.on('agent/created',({agent})=>{
    agent.ctx.on('agent/request',async (_request,next)=>{
      const request=await next();
      if(request.model==='executor'){ready(agent); await gate;}
      return request;
    });
  });
  const studio=await mountStudio(ctx,{dataDir:dir});
  try {
    const templates=(await studio.snapshot()).templates;
    const template=templates.find(t=>t.role==='worker')!;
    await assert.rejects(studio.saveTemplate({...templates.find(t=>t.role==='manager')!,publicNetwork:true}),/只有 Worker/);
    const enabled=await studio.saveTemplate({...template,publicNetwork:true});
    await studio.createRun({prompt:'Collect public sources.',mode:'direct'});
    const agent=await worker;
    const run=(await studio.snapshot()).runs[0]!;
    const attempt=run.attempts.find(a=>a.status==='running')!;
    const fetchPage=(attemptId:string)=>ctx.tools.execute({agent, name:'studio_web_fetch',callId:CallId(crypto.randomUUID()),
      arguments:{taskId:attempt.taskId,attemptId,url:'https://127.0.0.1/private'},signal:new AbortController().signal});
    assert.match(JSON.stringify((await fetchPage('wrong')).content),/attemptId/);
    assert.match(JSON.stringify((await fetchPage(attempt.id)).content),/禁止的地址/);
    const revoked=await studio.saveTemplate({...enabled,publicNetwork:false});
    await studio.saveTemplate({...revoked,publicNetwork:true});
    assert.match(JSON.stringify((await fetchPage(attempt.id)).content),/未获公开网络/);
    assert.deepEqual(studio.network.recent().map(call=>call.outcome),['denied','failed']);
  } finally { resume();await studio.close();await rm(dir,{recursive:true,force:true}); }
});
