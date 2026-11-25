/** Domain acceptance checks against real SQLite transactions and persisted task records. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioStore} from '../src/store.js';
import {TaskEngine} from '../src/task-engine.js';
import {MemoryService} from '../src/memory.js';
import type {StoredAgent} from '../src/store.js';

async function fixture() {
  const path=await mkdtemp(join(tmpdir(),'studio-engine-'));
  const store=new StudioStore(path);
  for (const role of ['orchestrator','manager','worker'] as const) store.saveTemplate({id:role,name:role,role,systemPrompt:role,selection:{provider:'studio-demo',model:role},version:1,memoryIdentityId:`template-${role}`});
  store.saveRun({id:'run',title:'test',mode:'auto',orchestratorId:'o',status:'idle',createdAt:new Date().toISOString()});
  const root: StoredAgent={id:'o',sessionId:'session-o',runId:'run',parentId:null,createdBy:null,templateId:'orchestrator',templateVersion:1,memoryIdentityId:'identity-o',name:'O',role:'orchestrator',selection:{provider:'studio-demo',model:'planner'},systemPrompt:'O',status:'idle',createdAt:new Date().toISOString()};
  store.saveAgent(root);
  let notices=0;
  const engine=new TaskEngine(store,{onChange:()=>notices++});
  return {store,engine,notices:()=>notices,close:async()=>{store.close();await rm(path,{recursive:true,force:true});}};
}

test('rolled-back task admission leaves neither a task, user message nor queued delivery', async()=>{
  const f=await fixture();
  try {
    assert.throws(()=>f.store.atomic(()=>{f.engine.createTask('run',{prompt:'never committed',requestId:'r'});throw new Error('rollback');}),/rollback/);
    assert.equal(f.store.tasks().length,0);assert.equal(f.store.deliveries().length,0);assert.equal(f.store.run('run')!.messages.length,0);assert.equal(f.notices(),0);
    const task=f.engine.createTask('run',{prompt:'committed',requestId:'r'});
    assert.equal(f.store.deliveries()[0]!.taskId,task.id);assert.equal(f.notices(),1);
  } finally {await f.close();}
});

test('execution ownership rejects cross-group delegation and stale reports after retry',async()=>{
  const f=await fixture();
  try {
    const task=f.engine.createTask('run',{prompt:'test',requestId:'a'});
    const manager=f.engine.delegate('o',{taskId:task.id,role:'manager',prompt:task.prompt});
    const other=f.engine.createTask('run',{prompt:'other',requestId:'b'});
    const outsider=f.engine.delegate('o',{taskId:other.id,role:'worker',prompt:other.prompt});
    assert.throws(()=>f.engine.delegate(manager.agentId,{taskId:task.id,role:'worker',prompt:task.prompt,agentId:outsider.agentId}),/outside/);
    assert.throws(()=>f.engine.delegate(manager.agentId,{taskId:other.id,role:'worker',prompt:'steal'}),/coordinator/);
    assert.throws(()=>f.engine.delegate(manager.agentId,{taskId:task.id,role:'manager',prompt:'promote'}),/Role cannot/);
    const work=f.engine.delegate(manager.agentId,{taskId:task.id,role:'worker',prompt:'refined execution instruction'});
    const delivery=f.store.deliveries().find(d=>d.attemptId===work.attemptId)!;
    f.engine.beginDelivery(delivery.id);f.engine.failDelivery(delivery.id,'failed',1,10);
    const retried=f.engine.retryTask('run',task.id);
    assert.notEqual(retried.latestAttemptId,work.attemptId);
    assert.equal(f.store.attempt(work.attemptId!)!.status,'failed');
    assert.equal(f.store.deliveries().find(d=>d.kind==='task'&&d.attemptId===retried.latestAttemptId)!.text,'refined execution instruction');
    assert.throws(()=>f.engine.report(work.agentId,{taskId:task.id,attemptId:work.attemptId!,text:'late result'}),/current Worker attempt/);
    assert.equal(f.store.task(task.id)!.status,'queued');
    assert.throws(()=>f.engine.accept(outsider.agentId,{taskId:task.id,text:'fake acceptance'}),/coordinator/);
  } finally {await f.close();}
});

test('native delivery errors after committed delegation, report or acceptance cannot roll back business progress',async()=>{
  const f=await fixture();
  try {
    const task=f.engine.createTask('run',{prompt:'test',requestId:'a'});
    const rootDelivery=f.store.deliveries().find(d=>d.agentId==='o')!;
    f.engine.beginDelivery(rootDelivery.id);
    const manager=f.engine.delegate('o',{taskId:task.id,role:'manager',prompt:'manage'});
    const managerDelivery=f.store.deliveries().find(d=>d.agentId===manager.agentId)!;
    f.engine.beginDelivery(managerDelivery.id);
    const work=f.engine.delegate(manager.agentId,{taskId:task.id,role:'worker',prompt:'execute'});
    const workerDelivery=f.store.deliveries().find(d=>d.attemptId===work.attemptId)!;
    f.engine.beginDelivery(workerDelivery.id);
    f.engine.failDelivery(rootDelivery.id,'root flush failed after delegation',1,10);
    f.engine.failDelivery(managerDelivery.id,'manager flush failed after delegation',1,10);
    assert.equal(f.store.task(task.id)!.status,'running');
    assert.equal(f.store.attempt(work.attemptId!)!.status,'running');
    assert.equal(f.store.delivery(rootDelivery.id)!.state,'done');
    assert.equal(f.store.delivery(managerDelivery.id)!.state,'done');
    assert.throws(()=>f.engine.retryTask('run',task.id),/Only failed or blocked/);
    f.engine.report(work.agentId,{taskId:task.id,attemptId:work.attemptId!,text:'actual result'});
    const review=f.store.deliveries().find(d=>d.kind==='review')!;
    f.engine.beginDelivery(review.id);f.engine.accept(manager.agentId,{taskId:task.id,text:'verified'});
    f.engine.failDelivery(workerDelivery.id,'worker flush failed after acceptance',1,10);
    f.engine.failDelivery(review.id,'review flush failed after acceptance',1,10);
    assert.equal(f.store.task(task.id)!.status,'completed');
    assert.equal(f.store.attempt(work.attemptId!)!.status,'reported');
    assert.equal(f.store.delivery(workerDelivery.id)!.state,'done');
    assert.equal(f.store.delivery(review.id)!.state,'done');
    assert.equal(f.store.delivery(review.id)!.error,'review flush failed after acceptance');
    assert.equal(f.store.attempts(task.id).length,1);
  } finally {await f.close();}
});

test('a committed report survives recovery without repeating the Worker or losing coordinator review',async()=>{
  const f=await fixture();
  try {
    const task=f.engine.createTask('run',{prompt:'test',requestId:'a'});
    const work=f.engine.delegate('o',{taskId:task.id,role:'worker',prompt:task.prompt});
    const delivery=f.store.deliveries().find(d=>d.attemptId===work.attemptId)!;
    f.engine.beginDelivery(delivery.id);
    f.engine.report(work.agentId,{taskId:task.id,attemptId:work.attemptId!,text:'actual result',evidence:['probe']});
    f.engine.report(work.agentId,{taskId:task.id,attemptId:work.attemptId!,text:'actual result',evidence:['probe']});
    f.engine.recover();
    assert.equal(f.store.attempts(task.id).length,1);assert.equal(f.store.delivery(delivery.id)!.state,'done');
    const reviews=f.store.deliveries().filter(d=>d.kind==='review');assert.equal(reviews.length,1);
    f.engine.beginDelivery(reviews[0]!.id);f.engine.failDelivery(reviews[0]!.id,'reviewer unavailable',1,10);
    f.engine.retryTask('run',task.id);
    assert.equal(f.store.attempts(task.id).length,1,'review retry never repeats completed Worker execution');
    assert.equal(f.store.task(task.id)!.status,'review');
    const retriedReview=f.store.deliveries().find(d=>d.kind==='review'&&d.state==='pending')!;
    f.engine.beginDelivery(retriedReview.id);f.engine.accept('o',{taskId:task.id,text:'verified'});
    f.engine.accept('o',{taskId:task.id,text:'verified'});
    assert.equal(f.store.deliveries().filter(d=>d.kind==='result').length,1);
    const result=f.store.deliveries().find(d=>d.kind==='result')!;
    f.engine.beginDelivery(result.id);f.engine.failDelivery(result.id,'temporary notification failure',3,10);
    assert.equal(f.store.task(task.id)!.status,'completed','notification failure cannot undo accepted work');
    assert.equal(f.store.delivery(result.id)!.state,'pending','accepted result still retries delivery');
  } finally {await f.close();}
});

test('schema one migrates transactionally without changing legacy chat or inventing task completion',async()=>{
  const path=await mkdtemp(join(tmpdir(),'studio-migration-'));
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(join(path,'studio.sqlite'));
  db.exec(`CREATE TABLE templates(id TEXT PRIMARY KEY,document TEXT NOT NULL);
    CREATE TABLE runs(id TEXT PRIMARY KEY,document TEXT NOT NULL);
    CREATE TABLE agents(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),role TEXT NOT NULL,parent_id TEXT,document TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),document TEXT NOT NULL);
    CREATE TABLE activity(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),document TEXT NOT NULL);
    CREATE TABLE runtime_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,nonce TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const legacy={id:'legacy',title:'Phase one conversation',mode:'direct',orchestratorId:'old-o',status:'idle',createdAt:'2026-10-13T00:00:00Z'};
  db.prepare('INSERT INTO runs VALUES(?,?)').run(legacy.id,JSON.stringify(legacy));
  const message={id:'m',role:'user',text:'retain historical content',createdAt:legacy.createdAt};
  db.prepare('INSERT INTO messages VALUES(?,?,?)').run(message.id,legacy.id,JSON.stringify(message));
  db.prepare('INSERT INTO runtime_owner VALUES(1,?,?)').run(process.pid,'live-old-runtime');
  assert.throws(()=>new StudioStore(path),/already owned/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,1,'a competing runtime must not migrate a live data directory');
  db.exec('DELETE FROM runtime_owner');db.close();
  const store=new StudioStore(path);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version,3);
    const migrated=store.run('legacy')!;
    assert.equal(migrated.title,legacy.title);assert.deepEqual(migrated.messages,[message]);
    assert.deepEqual(migrated.tasks,[]);assert.deepEqual(migrated.attempts,[]);
    assert.equal(store.deliveries().length,0);
  } finally {store.close();await rm(path,{recursive:true,force:true});}
});

test('explicit historical child reuse preserves only long-term identity in fresh Sessions and rejects cross-group sources',async()=>{
  const f=await fixture();
  try {
    const oldTask=f.engine.createTask('run',{prompt:'old',requestId:'old'});
    const oldManager=f.engine.delegate('o',{taskId:oldTask.id,role:'manager',prompt:'old manager'});
    const oldWorker=f.engine.delegate(oldManager.agentId,{taskId:oldTask.id,role:'worker',prompt:'old worker'});
    const memories=new MemoryService(f.store);
    const long=memories.write(oldWorker.agentId,{layer:'long',title:'Method',summary:'Reusable method',content:'Persistent private method'});
    const medium=memories.write(oldWorker.agentId,{layer:'medium',title:'Old task',summary:'Task facts',content:'Must stay in old Run',taskId:oldTask.id});
    f.store.saveRun({id:'next',title:'new',mode:'auto',orchestratorId:'next-o',status:'idle',createdAt:new Date().toISOString(),memorySourceRunId:'run'});
    f.store.saveAgent({...f.store.agent('o')!,id:'next-o',runId:'next',sessionId:'new-root-session',memorySourceAgentId:'o'});
    const task=f.engine.createTask('next',{prompt:'new',requestId:'new'});
    assert.deepEqual(f.engine.memorySources('next-o').map(a=>a.agentId),[oldManager.agentId]);
    assert.throws(()=>f.engine.delegate('next-o',{taskId:task.id,role:'worker',prompt:'cross group',memorySourceAgentId:oldWorker.agentId}),/authorized historical child/);
    const manager=f.engine.delegate('next-o',{taskId:task.id,role:'manager',prompt:'new manager',memorySourceAgentId:oldManager.agentId});
    const worker=f.engine.delegate(manager.agentId,{taskId:task.id,role:'worker',prompt:'new worker',memorySourceAgentId:oldWorker.agentId});
    assert.notEqual(worker.agentId,oldWorker.agentId);
    assert.notEqual(f.store.agent(worker.agentId)!.sessionId,f.store.agent(oldWorker.agentId)!.sessionId);
    assert.equal(f.store.agent(worker.agentId)!.memoryIdentityId,f.store.agent(oldWorker.agentId)!.memoryIdentityId);
    assert.equal(memories.read(worker.agentId,{id:long.id}).content,'Persistent private method');
    assert.throws(()=>memories.read(worker.agentId,{id:medium.id}),/unavailable/);
    const another=f.engine.createTask('next',{prompt:'another',requestId:'another'});
    f.engine.delegate('next-o',{taskId:another.id,role:'manager',prompt:'manage another',agentId:manager.agentId});
    assert.throws(()=>f.engine.delegate(manager.agentId,{taskId:another.id,role:'worker',prompt:'duplicate identity',memorySourceAgentId:oldWorker.agentId}),/authorized historical child/);
    const fresh=f.engine.delegate(manager.agentId,{taskId:another.id,role:'worker',prompt:'new identity'});
    assert.notEqual(f.store.agent(fresh.agentId)!.memoryIdentityId,f.store.agent(worker.agentId)!.memoryIdentityId);
    assert.throws(()=>memories.read(fresh.agentId,{id:long.id}),/unavailable/);
    f.store.saveRun({id:'unselected',title:'no source',mode:'auto',orchestratorId:'third-o',status:'idle',createdAt:new Date().toISOString()});
    f.store.saveAgent({...f.store.agent('o')!,id:'third-o',runId:'unselected',sessionId:'third-root'});
    const noSource=f.engine.createTask('unselected',{prompt:'no source',requestId:'no-source'});
    assert.throws(()=>f.engine.delegate('third-o',{taskId:noSource.id,role:'manager',prompt:'unselected',memorySourceAgentId:oldManager.agentId}),/authorized historical child/);
  } finally {await f.close();}
});

test('a split binds permitted templates atomically and nested pause ownership survives recovery', async () => {
  const f = await fixture();
  try {
    const root = f.store.agent('o')!;
    f.store.saveAgent({...root, delegateIds:['manager']});
    const parent = f.engine.createTask('run',{prompt:'parallel',requestId:'split'});
    assert.throws(() => f.engine.split(root.id,parent.id,[{templateId:'manager',prompt:'valid'},{templateId:'worker',prompt:'not allowed'}]), /scope/);
    assert.equal(f.store.tasks().length,1);
    const children = f.engine.split(root.id,parent.id,[{templateId:'manager',prompt:'one'},{templateId:'manager',prompt:'two'}]);
    assert.notEqual(f.store.task(children[0]!)!.coordinatorId,f.store.task(children[1]!)!.coordinatorId);
    const sub = f.engine.split(f.store.task(children[0]!)!.coordinatorId,children[0]!,[{templateId:'worker',prompt:'nested'}])[0]!;
    f.engine.pauseTask('run',children[0]!);
    f.engine.pauseTask('run',parent.id);
    assert.deepEqual(f.store.task(sub)!.pauseOwners,[children[0],parent.id]);
    f.engine.recover();
    f.engine.resumeTask('run',parent.id);
    assert.equal(f.store.task(sub)!.status,'paused');
    assert.equal(f.store.task(children[1]!)!.status,'queued');
    f.engine.resumeTask('run',children[0]!);
    assert.equal(f.store.task(sub)!.status,'queued');
    f.engine.cancelTask('run',parent.id);
    assert.ok(f.store.tasks().every(t => t.status === 'cancelled'));
  } finally { await f.close(); }
});

test('a paused handoff finishes its active turn and resumes the original inbox delivery', async () => {
  const f = await fixture();
  try {
    const prompt = 'word '.repeat(6000);
    const task = f.engine.createTask('run',{prompt,requestId:'long'});
    const root = f.store.deliveries()[0]!;
    f.engine.beginDelivery(root.id);
    assert.equal(f.engine.pauseTask('run',task.id).pauseRequested,true);
    const delegated = f.engine.delegate('o',{taskId:task.id,role:'worker',prompt});
    f.engine.finishDelivery(root.id);
    assert.equal(f.store.task(task.id)!.status,'paused');
    const worker = f.store.deliveries().find(d => d.attemptId === delegated.attemptId)!;
    assert.equal(f.engine.beginDelivery(worker.id),undefined);
    f.engine.resumeTask('run',task.id);
    assert.equal(f.engine.beginDelivery(worker.id)?.text,prompt);
    f.engine.report(delegated.agentId,{taskId:task.id,attemptId:delegated.attemptId!,text:prompt});
    f.engine.accept('o',{taskId:task.id,text:prompt});
    assert.equal(f.store.task(task.id)!.result,prompt);
    f.engine.message('run',prompt,'long-message');
    f.engine.message('run',prompt,'long-message');
    assert.throws(() => f.engine.message('run','changed','long-message'),/conflict/);
    assert.equal(f.store.deliveries().filter(d => d.kind === 'message').length,1);
  } finally { await f.close(); }
});

test('a bound Worker receives the published template through an authorized Manager in hierarchical mode', async () => {
  const f = await fixture();
  try {
    f.store.saveRun({...f.store.run('run')!,mode:'hierarchical'});
    const root = f.store.agent('o')!;
    f.store.saveAgent({...root,delegateIds:['manager']});
    const manager = f.store.template('manager')!;
    f.store.saveTemplate({...manager,delegateIds:['worker']});
    const pinned = f.store.template('worker')!;
    f.store.saveTemplate({...pinned,version:2,systemPrompt:'newer configuration'});
    const task = f.engine.createAssignedTask('run',{prompt:'bound',requestId:'r'},pinned);
    const worker = f.store.agent(f.store.attempt(task.latestAttemptId!)!.workerId)!;
    assert.equal(worker.templateVersion,1);
    assert.equal(worker.systemPrompt,pinned.systemPrompt);
    assert.equal(f.store.agent(worker.parentId!)!.templateId,'manager');
    assert.deepEqual(f.store.deliveries().filter(d => d.state === 'pending').map(d => d.agentId),[worker.id]);
    assert.equal(f.engine.createAssignedTask('run',{prompt:'bound',requestId:'r'},pinned).id,task.id);
    f.store.saveTemplate({...manager,delegateIds:[]});
    assert.throws(() => f.engine.createAssignedTask('run',{prompt:'blocked',requestId:'z'},pinned),/No authorized Manager/);
    assert.equal(f.store.tasks('run').length,1);
    assert.throws(() => f.engine.createAssignedTask('run',{prompt:'bound',requestId:'r'},{...pinned,version:2}),/conflict/);
  } finally {await f.close();}
});

test('a coordinator can return one accepted branch for revision without redoing its siblings',async () => {
  const f = await fixture();
  try {
    const parent = f.engine.createTask('run',{prompt:'parent',requestId:'p'});
    const [left,right] = f.engine.split('o',parent.id,[{templateId:'worker',prompt:'left instructions'},{templateId:'worker',prompt:'right instructions'}]);
    const complete = (id:string,summary:string) => {
      const attemptId = f.store.task(id)!.latestAttemptId!;
      const attempt = f.store.attempt(attemptId)!;
      const work = f.store.deliveries('run').find(d => d.kind === 'task' && d.attemptId === attemptId)!;
      f.engine.beginDelivery(work.id);
      f.engine.report(attempt.workerId,{taskId:id,attemptId,text:summary});
      f.engine.finishDelivery(work.id);
      const review = f.store.deliveries('run').find(d => d.kind === 'review' && d.attemptId === attemptId)!;
      f.engine.beginDelivery(review.id);
      f.engine.accept('o',{taskId:id,text:'Accepted '+summary});
      f.engine.finishDelivery(review.id);
    };
    complete(left!,'left');
    complete(right!,'right');
    const review = f.store.deliveries('run').find(d => d.taskId === parent.id && d.kind === 'review')!;
    f.engine.beginDelivery(review.id);
    assert.throws(() => f.engine.revise('o',parent.id,'fix','unknown'), /direct child/);
    f.engine.revise('o',parent.id,'address the gap',left);
    assert.equal(f.store.delivery(review.id)!.state,'done');
    const attempts = f.store.attempts(left);
    assert.equal(attempts.length,2);
    assert.equal(attempts[0]!.status,'reported');
    assert.equal(attempts[0]!.workerId,attempts[1]!.workerId);
    assert.match(f.store.deliveries('run').find(d => d.attemptId === attempts[1]!.id)!.text,/left instructions[\s\S]*left[\s\S]*address the gap/);
    assert.equal(f.store.task(right!)!.status,'completed');
    assert.equal(f.store.attempts(right).length,1);
    complete(left!,'revised');
    assert.equal(f.store.task(parent.id)!.status,'review');
  } finally {await f.close();}
});

test('resuming a paused split reconciles a cancelled or failed branch bottom-up, including after restart', async () => {
  for (const nested of [false,true]) {
    const f = await fixture();
    try {
      const parent = f.engine.createTask('run',{prompt:'parent', requestId:'parent'});
      const dispatch = f.store.deliveries()[0]!;
      f.engine.beginDelivery(dispatch.id);
      const branch = f.engine.split('o',parent.id,[{templateId:nested?'manager':'worker',prompt:'branch'}])[0]!;
      f.engine.finishDelivery(dispatch.id);
      let leaf = branch;
      if (nested) {
        const delegation = f.store.deliveries().find(d => d.taskId === branch)!;
        f.engine.beginDelivery(delegation.id);
        leaf = f.engine.split(delegation.agentId,branch,[{templateId:'worker',prompt:'leaf'}])[0]!;
        f.engine.finishDelivery(delegation.id);
      }
      const work = f.store.deliveries().find(d => d.taskId === leaf)!;
      if (nested) f.engine.beginDelivery(work.id);
      f.engine.pauseTask('run',parent.id);
      if (nested) f.engine.failDelivery(work.id,'failed during pause',1,1);
      else f.engine.cancelTask('run',leaf);
      assert.equal(f.store.task(parent.id)!.status,'paused');
      // A runtime recovery while still paused must keep the explicit pause.
      f.engine.recover();
      assert.equal(f.store.task(parent.id)!.status,'paused');
      const before = f.store.deliveries().length;
      for(let i=0;i<2;i++) {
        assert.equal(f.engine.resumeTask('run',parent.id).status,'blocked');
        if (nested) assert.equal(f.store.task(branch)!.status,'blocked');
      }
      // Repair the stale waiting state written by previous releases, even without another manual resume.
      for(const id of new Set([parent.id,...(nested ? [branch] : [])])) {
        f.store.saveTask({...f.store.task(id)!,status:'running',error:undefined});
      }
      f.store.setRunStatus('run','running');
      for(let i=0;i<2;i++) {
        f.engine.recover();
        assert.equal(f.store.task(parent.id)!.status,'blocked');
        assert.equal(f.store.task(leaf)!.status,nested?'failed':'cancelled');
        assert.equal(f.store.run('run')!.status,'blocked');
        assert.equal(f.store.deliveries().length,before);
        assert.ok(!f.store.deliveries().some(d => d.state === 'pending' || d.state === 'running'));
      }
    } finally {await f.close();}
  }
});

test('stopped Runs reject new work but replay previously acknowledged idempotent submissions', async () => {
  const f = await fixture();
  try {
    const task = f.engine.createTask('run',{prompt:'before stop',requestId:'task'});
    f.engine.message('run','before stop','message');
    f.engine.pauseTask('run',task.id);
    f.engine.cancelRun('run');
    const before = f.store.run('run')!;
    assert.equal(f.engine.createTask('run',{prompt:task.prompt,requestId:'task'}).id,task.id);
    f.engine.message('run','before stop','message');
    assert.throws(() => f.engine.createTask('run',{prompt:'different',requestId:'task'}),/conflict/);
    assert.throws(() => f.engine.message('run','different','message'),/conflict/);
    assert.throws(() => f.engine.createTask('run',{prompt:'new',requestId:'new'}),/stopped/);
    assert.throws(() => f.engine.message('run','new'),/stopped/);
    assert.throws(() => f.engine.message('run','new','new'),/stopped/);
    assert.throws(() => f.engine.retryTask('run',task.id),/stopped/);
    assert.throws(() => f.engine.resumeTask('run',task.id),/stopped/);
    f.engine.recover();
    assert.deepEqual(f.store.run('run'),before);
  } finally {await f.close();}
});
