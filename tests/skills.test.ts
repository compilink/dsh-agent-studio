import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
import {CallId} from '@deepseek-ai/dsh-llm';
import {mountStudio} from '../src/runtime.js';

test('Skill summaries and immutable revisions follow each assigned member through split, edit and retirement', {timeout: 20_000}, async () => {
  const folder = await mkdtemp(join(tmpdir(),'studio-skill-revisions-'));
  const ctx = new Context();
  const studio = await mountStudio(ctx, {dataDir:folder});
  try {
    const original = studio.skills.create({name:'Review',summary:'Inspect the inputs.',body:'Frozen revision one.'});
    const revised = {name:'Review',summary:'Inspect each input.',body:'Frozen revision two.'};
    const templates = (await studio.snapshot()).templates;
    for (const template of templates.filter(t => t.role !== 'manager')) {
      await studio.saveTemplate({...template,skillIds:[original.id]});
    }
    const probes: {version?:number; allowed:boolean; mismatched:boolean; network:boolean}[] = [];
    const delivered: {id:string; version:number; summary:string; body?:string}[][] = [];
    ctx.on('session/event', (_session,event) => {
      if (event.type !== 'user/message' || !event.data.id.startsWith('studio-delivery:')) return;
      const part = event.data.content.find(c => c.type === 'text');
      if (part) {
        const envelope = JSON.parse(part.text);
        if (envelope.skills) delivered.push(envelope.skills);
      }
    });
    ctx.on('agent/created', async ({agent}) => {
      const state = await studio.snapshot();
      const member = state.runs.flatMap(run => run.agents).find(a => a.sessionId === agent.id)!;
      const version = member.skills?.[0]?.version;
      if (version === 1 && !studio.skills.read(original.id).retired && studio.skills.read(original.id).version === 1) {
        studio.skills.revise(original.id,1,revised);
      } else if (version === 2 && !studio.skills.read(original.id).retired) {
        studio.skills.revise(original.id,2,{},true);
      }
      const call = (name:string,args:object) => ctx.tools.execute({name,arguments:args,agent,callId:CallId(crypto.randomUUID()),signal:new AbortController().signal});
      const own = await call('studio_read_skill',{id:original.id,version:version ?? 1});
      const wrong = await call('studio_read_skill',{id:original.id,version:version === 1 ? 2 : 1});
      const network = await call('studio_web_fetch',{value:'https://example.invalid/'});
      const text = own.content.filter(b => b.type === 'text').map(b => b.text).join('');
      probes.push({version,allowed:!own.isError && text.includes(version === 1 ? original.body : revised.body),mismatched:!!wrong.isError,network:!!network.isError});
    });
    const run = await studio.createRun({prompt:'并行拆分：\nCheck A\nCheck B',mode:'direct'});
    async function done(id:string) {
      for (let i=0;i<500;i++) {
        if ((await studio.snapshot()).runs[0]!.tasks.find(t => t.id === id)?.status === 'completed') return;
        await delay(10);
      }
      assert.fail('Task did not finish');
    }
    await done(run.tasks[0]!.id);
    const after = await studio.addTask(run.id,{prompt:'Use current settings',requestId:'after-retirement'});
    await done(after.id);
    assert.equal(studio.skills.read(original.id,1).body,original.body);
    assert.equal(studio.skills.read(original.id,2).body,revised.body);
    assert.equal(studio.skills.list().length,0);
    assert.equal(studio.skills.directory()[0]!.retired,1);
    assert.throws(() => studio.skills.revise(original.id,1,revised),/version conflict/);
    assert.equal(probes.filter(p => p.version === 1 && p.allowed).length,1);
    assert.equal(probes.filter(p => p.version === 2 && p.allowed).length,2);
    assert.equal(probes.filter(p => p.version === undefined && !p.allowed).length,1);
    assert.ok(probes.every(p => p.mismatched && p.network));
    assert.ok(delivered.flat().some(ref => ref.version === 1 && ref.summary === original.summary));
    assert.ok(delivered.flat().some(ref => ref.version === 2 && ref.summary === revised.summary));
    assert.ok(delivered.flat().every(ref => !Object.hasOwn(ref,'body')));
  } finally { await studio.close(); await rm(folder,{force:true,recursive:true}); }
});
