import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile, rename} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const project = 'studio-test-' + randomUUID();
const cwd = fileURLToPath(new URL('..',import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(),'studio-docker-test-'));
const home = join(sandbox,'model-source');
const data = join(sandbox,'data');
const extraSearch = process.env.STUDIO_TEST_BUNDLED_SEARCH === '1';
const env = {...process.env, STUDIO_DSH_HOME:home, STUDIO_DATA_DIR:data, STUDIO_PORT:'0', STUDIO_DEMO:'0',
  STUDIO_UID:String(process.getuid()),STUDIO_GID:String(process.getgid())};
const compose = (...args) => execFileSync('docker',['compose','--project-name',project,'-f','compose.yaml',
  ...(extraSearch ? ['-f','compose.search.yaml'] : []),...args],{cwd,env,encoding:'utf8',timeout:120000}).trim();
let origin;
async function connect() {
  const port = compose('port','studio','4317');
  assert.match(port,/^127\.0\.0\.1:\d+$/);
  origin = 'http://' + port;
  return (await (await fetch(origin+'/api/bootstrap')).json()).csrfToken;
}
function post(path,token,body) {
  return fetch(origin+path,{method:'POST',headers:{'content-type':'application/json','x-studio-csrf':token,origin},body:JSON.stringify(body)});
}
const patch = join(home,'cordis.patch.yml');
const config = id => JSON.stringify([{id:'llm-pi-ai',config:{providers:{fixture:{api:'openai-completions',
  baseURL:'http://127.0.0.1:1/v1',models:[{id,contextWindow:32768,maxTokens:256}]}}}}]);
try {
  await Promise.all([mkdir(data),mkdir(home)]);
  await writeFile(patch,config('first'));
  compose('up','-d','--no-build','--wait');
  const token = await connect();
  const catalog = async () => (await (await fetch(origin+'/api/models')).json()).filter(m=>!m.demo).map(m=>m.model);
  assert.deepEqual(await catalog(),['first']);
  await writeFile(patch+'.new',config('second'));
  await rename(patch+'.new',patch);
  assert.equal((await post('/api/models/refresh',token,{})).status,200);
  assert.deepEqual(await catalog(),['second']);
  const rejected = await new Promise((accept,reject) => {
    const req = request(origin+'/api/state',{headers:{host:'untrusted.example'}},res=>{res.resume();accept(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(rejected,403);
  assert.equal((await fetch(origin+'/api/models/refresh',{method:'POST',headers:{'x-studio-csrf':token,origin:'https://untrusted.example'}})).status,403);
  const settings = await (await fetch(origin+'/api/network/settings')).json();
  assert.equal(settings.bundled,extraSearch);
  const result = await post('/api/runs',token,{mode:'direct',prompt:'Check the deterministic Worker and report.'});
  assert.equal(result.status,201);
  const runId = (await result.json()).id;
  let completed;
  for (let i=0;i<100&&!completed;i++) {
    const state = await (await fetch(origin+'/api/state')).json();
    completed = state.runs.find(run=>run.id===runId && run.tasks[0]?.status==='completed');
    if (!completed) await delay(100);
  }
  assert.ok(completed,'Expected completed deterministic task');
  const beforeId = compose('ps','-q','studio');
  compose('kill','-s','SIGKILL','studio');
  compose('up','-d','--force-recreate','--no-deps','--no-build','--wait','studio');
  assert.notEqual(compose('ps','-q','studio'),beforeId);
  await connect();
  const restored = (await (await fetch(origin+'/api/state')).json()).runs.find(run=>run.id===runId);
  assert.equal(restored.tasks[0].status,'completed');
  assert.deepEqual(restored.agents.map(agent=>agent.sessionId),completed.agents.map(agent=>agent.sessionId));
  assert.deepEqual(restored.attempts.map(attempt=>attempt.id),completed.attempts.map(attempt=>attempt.id));
  assert.deepEqual(await catalog(),['second']);
  console.log('Docker checks passed: loopback publishing, Host/Origin, model socket refresh, deterministic Worker, persistent Run and Attempt after container replacement.');
} finally {
  try { compose('down','--volumes','--remove-orphans'); }
  finally { await rm(sandbox,{recursive:true,force:true}); }
}
