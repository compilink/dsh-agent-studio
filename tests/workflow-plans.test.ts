import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudio } from '../src/runtime.js';
import { startServer } from '../src/server.js';
import { orderedNodes, WorkflowError, type WorkflowGraph } from '../src/workflow-plans.js';
import { workflowRoute } from '../src/workflow-http.js';

const node = (id: string, review = false) => ({id, name: id, instruction: 'prepare ' + id, x: 10, y: 10, review});
const graph: WorkflowGraph = {name:'Research and verify', nodes:[node('collect', true),node('write'),node('independent')], edges:[{from:'collect',to:'write'}]};
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await delay(30); }
  assert.fail('Timed out waiting for workflow transition');
}

test('workflow graphs reject duplicate nodes, dangling or duplicate edges and cycles', () => {
  assert.deepEqual(orderedNodes(graph), ['collect','independent','write']);
  for (const invalid of [
    {...graph, nodes:[...graph.nodes,graph.nodes[0]!]},
    {...graph, edges:[...graph.edges,{from:'missing',to:'write'}]},
    {...graph, edges:[...graph.edges,graph.edges[0]!]},
    {...graph, edges:[...graph.edges,{from:'write',to:'collect'}]},
  ]) assert.throws(()=>orderedNodes(invalid), WorkflowError);
});

test('published graphs pin versions, persist review, and deliver only the approved round to downstream tasks', {timeout:55_000}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'studio-workflow-'));
  const options = {dataDir:dir,scheduler:{pollIntervalMs:15}};
  let studio = await createStudio(options);
  try {
    const run = await studio.createRun({prompt:'initial work',mode:'direct'});
    let service = studio.workflows!;
    assert.equal(workflowRoute(service,'PUT','/api/workflows/templates/research',{expectedRevision:0,graph}).status,200);
    assert.throws(()=>service.save('research',{expectedRevision:0,graph}), /新修改/);
    service.publish('research',{expectedRevision:1});
    assert.equal(service.publish('research',{expectedRevision:2}).published,1);
    const initial = service.start('research',{version:1,runId:run.id,requestId:'start-once'});
    assert.equal(service.start('research',{version:1,runId:run.id,requestId:'start-once'}).id, initial.id);
    assert.throws(()=>service.act(initial.id,'write',{action:'approve',round:1,taskId:'unrelated'}));
    const nodes = () => service.instances(run.id)[0]!.nodes;
    const pass = (key: string) => nodes().find(n=>n.id===key)!.passes.at(-1)!;
    assert.equal(pass('write').stage,'waiting');
    const nextGraph=structuredClone(graph);
    nextGraph.nodes[1]!.instruction='unrelated new version';
    service.save('research',{expectedRevision:2,graph:nextGraph});
    service.publish('research',{expectedRevision:3});
    assert.throws(()=>service.start('research',{version:2,runId:run.id,requestId:'start-once'}),/冲突/);
    await until(()=>pass('collect').stage==='review' && pass('independent').stage==='released');
    const originalTask=pass('collect').taskId!, independentTask=pass('independent').taskId!;
    const decision={round:1,taskId:originalTask};
    await studio.close();
    studio=await createStudio(options); service=studio.workflows!;
    assert.equal(pass('collect').stage,'review');
    assert.equal(pass('write').taskId,undefined);
    service.act(initial.id,'collect',{action:'reject',note:'separate measured observations',...decision});
    assert.equal(pass('write').taskId,undefined);
    service.act(initial.id,'collect',{action:'rerun',...decision});
    const secondTask = pass('collect').taskId!;
    assert.notEqual(secondTask,originalTask);
    assert.throws(()=>service.act(initial.id,'collect',{action:'approve',...decision}), /新一轮/);
    assert.match((await studio.snapshot()).runs[0]!.tasks.find(t=>t.id===secondTask)!.prompt,/separate measured observations/);
    await until(()=>pass('collect').stage==='review');
    service.act(initial.id,'collect',{action:'approve',content:'reviewed input '.repeat(600),taskId:secondTask,round:2});
    await until(()=>pass('write').stage==='released');
    assert.equal(pass('independent').taskId,independentTask);
    const downstream=(await studio.snapshot()).runs[0]!.tasks.find(t=>t.id===pass('write').taskId)!;
    assert.ok(downstream.prompt.includes('reviewed input '.repeat(600)));
    assert.ok(downstream.prompt.startsWith('prepare write'));
    assert.deepEqual(pass('write').input,[{nodeId:'collect',round:2,taskId:secondTask,attemptId:pass('collect').attemptId}]);
    assert.equal(service.instances(run.id)[0]!.version,1);
  } finally { await studio.close(); await rm(dir,{recursive:true,force:true}); }
});

test('a selected node runs the published Agent configuration and denied assignments admit no tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(),'studio-workflow-agent-'));
  const studio = await createStudio({dataDir:dir});
  try {
    const service = studio.workflows!;
    const {templates} = await studio.snapshot();
    const worker = templates.find(t=>t.role==='worker')!, orchestrator = templates.find(t=>t.role==='orchestrator')!;
    const agent = await studio.saveTemplate({id:'specialist', role:'worker', name:'Specialist', systemPrompt:'A pinned editorial style', selection:worker.selection});
    const pinned: WorkflowGraph = {name:'Pinned Agent',nodes:[{...node('step'),templateId:agent.id}],edges:[]};
    service.save('assigned',{graph:pinned,expectedRevision:0}); service.publish('assigned',{expectedRevision:1});
    const edited = await studio.saveTemplate({...agent,name:'Revised specialist',systemPrompt:'A different editorial style'});
    const second = service.publish('assigned',{expectedRevision:2});
    assert.equal(second.published,2);
    const run = await studio.createRun({prompt:'independent work',mode:'direct'});
    const flow = service.start('assigned',{runId:run.id,version:1,requestId:'original'});
    const task = (await studio.snapshot()).runs.find(r=>r.id===run.id)!.tasks.find(t=>t.id===flow.nodes[0]!.passes[0]!.taskId)!;
    assert.equal(task.assignedTemplateVersion,agent.version);
    assert.equal(task.assignedTemplateId,agent.id);
    await until(()=>service.instances(run.id)[0]!.nodes[0]!.passes[0]!.stage==='released');
    const performers = (await studio.snapshot()).runs.find(r=>r.id===run.id)!.agents;
    assert.ok(performers.some(a=>a.templateId===agent.id&&a.systemPrompt===agent.systemPrompt));
    assert.ok(!performers.some(a=>a.templateId===agent.id&&a.systemPrompt===edited.systemPrompt));
    await studio.saveTemplate({...orchestrator,delegateIds:[worker.id]});
    const restricted = await studio.createRun({prompt:'another run',mode:'direct'});
    const count = restricted.tasks.length;
    assert.throws(()=>service.start('assigned',{runId:restricted.id,version:2,requestId:'denied'}));
    assert.deepEqual(service.instances(restricted.id),[]);
    assert.equal((await studio.snapshot()).runs.find(r=>r.id===restricted.id)!.tasks.length,count);
  } finally { await studio.close(); await rm(dir,{recursive:true,force:true}); }
});

test('workflow downloads select the released text of the exact instance, node and round after edits and reruns', async () => {
  const dir = await mkdtemp(join(tmpdir(),'studio-workflow-export-'));
  const app = await startServer({dataDir:dir, port:0, scheduler:{pollIntervalMs:15}});
  try {
    const service = app.studio.workflows!;
    const run = await app.studio.createRun({prompt:'Start the export test',mode:'direct'});
    service.save('delivery',{expectedRevision:0,graph:{name:'Delivery',nodes:[node('source',true),node('sibling',true)],edges:[]}});
    service.publish('delivery',{expectedRevision:1});
    const start = (requestId: string) => service.start('delivery',{runId:run.id,version:1,requestId});
    const a = start('first-instance'), b = start('second-instance');
    const pass = (instanceId: string) => service.instances(run.id).find(i=>i.id===instanceId)!.nodes.find(n=>n.id==='source')!.passes.at(-1)!;
    const download = (instanceId: string,node: string,round: number,fmt='md') => fetch(app.url+'/api/workflows/instances/'+instanceId+'/nodes/'+node+'/rounds/'+round+'/export?format='+fmt);
    const decide = (instanceId: string, round: number, text: string) => service.act(instanceId,'source',{
      action:'approve',round,taskId:pass(instanceId).taskId,content:text,
    });
    await until(()=>pass(a.id).stage==='review' && pass(b.id).stage==='review');
    assert.equal((await download(a.id,'source',1)).status,409);
    decide(a.id,1,'人工定稿 A & B');
    decide(b.id,1,'Isolated second instance');
    const firstTask = pass(a.id).taskId!;
    service.act(a.id,'source',{action:'rerun',round:1,taskId:firstTask});
    await until(()=>pass(a.id).stage==='review');
    assert.equal((await download(a.id,'source',2)).status,409);
    decide(a.id,2,'第二轮改稿');
    const md = await download(a.id,'source',1);
    assert.equal(md.status,200);
    assert.match(md.headers.get('content-disposition')!,/r1\.md/);
    assert.equal(await md.text(),'# Delivery · source · 第 1 轮\n\n人工定稿 A & B\n');
    const doc = await download(a.id,'source',1,'docx');
    assert.match(doc.headers.get('content-type')!,/wordprocessingml/);
    assert.ok(Buffer.from(await doc.arrayBuffer()).includes(Buffer.from('人工定稿 A &amp; B')));
    assert.match(await (await download(a.id,'source',2)).text(),/第二轮改稿/);
    assert.match(await (await download(b.id,'source',1)).text(),/Isolated second instance/);
    assert.equal((await download(b.id,'source',2)).status,404);
    assert.equal((await download(a.id,'sibling',1)).status,409);
    assert.equal((await download(a.id,'other-node',1)).status,404);
    assert.equal((await download('missing','source',1)).status,404);
    assert.equal((await download(a.id,'source',0)).status,400);
  } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
});

test('template history restores only the draft and retirement preserves published versions and running instances', async () => {
  const dir = await mkdtemp(join(tmpdir(),'studio-workflow-lifecycle-'));
  const studio = await createStudio({dataDir:dir});
  try {
    const s=studio.workflows!, run=await studio.createRun({prompt:'Independent task',mode:'direct'});
    const first={name:'Initial',nodes:[node('review',true)],edges:[]};
    s.save('catalog',{expectedRevision:0,graph:first});
    const v1=s.publish('catalog',{expectedRevision:1});
    const active=s.start('catalog',{runId:run.id,requestId:'active',version:1});
    s.save('catalog',{expectedRevision:v1.revision,graph:{...first,name:'Later'}});
    const v2=s.publish('catalog',{expectedRevision:3});
    assert.throws(()=>s.restore('catalog',{expectedRevision:v1.revision,sourceVersion:1}), /新修改/);
    const restored=s.restore('catalog',{expectedRevision:v2.revision,sourceVersion:1});
    assert.equal(restored.draft.name,'Initial'); assert.equal(restored.published,2);
    assert.equal(s.graph('catalog',2).name,'Later');
    const disabled=s.setRetired('catalog',{expectedRevision:restored.revision,retired:true});
    assert.ok(s.templates()[0]!.retired);
    assert.throws(()=>s.save('catalog',{expectedRevision:disabled.revision,graph:first}), /已停用/);
    assert.throws(()=>s.publish('catalog',{expectedRevision:disabled.revision}), /已停用/);
    assert.throws(()=>s.start('catalog',{runId:run.id,version:1,requestId:'new'}), /已停用/);
    assert.equal(s.start('catalog',{runId:run.id,version:1,requestId:'active'}).id,active.id);
    await until(()=>s.instances(run.id)[0]!.nodes[0]!.passes[0]!.stage==='review');
    const pass=s.instances(run.id)[0]!.nodes[0]!.passes[0]!;
    s.act(active.id,'review',{action:'approve',round:1,taskId:pass.taskId,content:'kept output'});
    assert.equal(s.releasedOutput(active.id,'review',1).content,'kept output');
    assert.throws(()=>s.setRetired('catalog',{expectedRevision:restored.revision,retired:false}), /新修改/);
    const enabled=s.setRetired('catalog',{expectedRevision:disabled.revision,retired:false});
    assert.ok(!enabled.retired);
    assert.equal(s.publish('catalog',{expectedRevision:enabled.revision}).published,3);
    assert.equal(s.graph('catalog',2).name,'Later');
  } finally { await studio.close(); await rm(dir,{recursive:true,force:true}); }
});
