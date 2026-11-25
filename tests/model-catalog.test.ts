import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import {ModelCatalog} from '../src/model-catalog.js';
import {probeConfiguredModel} from '../src/model-probe.js';
import {startServer} from '../src/server.js';
import type {ModelOption} from '../src/types.js';

test('refresh reads replaced DSH files, atomically changes live routes and preserves a probe already in progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-model-refresh-'));
  const home = join(root, 'dsh');
  const profile = join(home, 'profiles', 'web');
  await mkdir(profile, {recursive:true});
  let acknowledge!: () => void;
  let release!: () => void;
  const received = new Promise<void>(resolve => { acknowledge = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const reached: string[] = [];
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    const {model} = JSON.parse(Buffer.concat(chunks).toString());
    reached.push(model);
    if (model === 'original') { acknowledge(); await proceed; }
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const part = (choices: unknown[]) => 'data: ' + JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model,choices}) + '\n\n';
    res.end(part([{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]) +
      part([{index:0,delta:{},finish_reason:'stop'}]) + 'data: [DONE]\n\n');
  });
  await new Promise<void>((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done); });
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const baseURL = 'http://127.0.0.1:' + address.port + '/v1';
  const path = join(profile, 'cordis.patch.yml');
  const config = (id: string) => JSON.stringify([{id:'llm-pi-ai',config:{providers:{
    fixture:{api:'openai-completions',baseURL,apiKeyEnv:'STUDIO_FIXTURE',models:[{id,contextWindow:32768,maxTokens:256}]}
  }}}]);
  await writeFile(path, config('original'));
  await writeFile(join(home,'.env'), 'STUDIO_FIXTURE=local-fixture-key');
  const app = await startServer({dataDir:join(root,'data'),dshHome:home,port:0});
  try {
    const api = app.url + '/api';
    const {csrfToken} = await fetch(app.url+'/api/bootstrap').then(r => r.json());
    const post = (route: string, body = {}) => fetch(api+route,{method:'POST',headers:{
      'x-studio-csrf':csrfToken,'content-type':'application/json'
    },body:JSON.stringify(body)});
    const list = async () => (await fetch(api+'/models').then(r=>r.json()) as ModelOption[]).map(m=>m.model);
    assert.deepEqual(await list(), ['original']);
    const original = post('/models/probe', {provider:'fixture',model:'original'});
    const timeout = AbortSignal.timeout(6000);
    await Promise.race([received, new Promise<void>((_,reject) => timeout.addEventListener('abort',() => reject(new Error('Original probe did not reach fixture')),{once:true}))]);
    await writeFile(path+'.next', config('replacement'));
    await rename(path+'.next', path);
    // The current provider continues serving its old request while the refreshed route is already usable.
    const updated = await post('/models/refresh');
    assert.equal(updated.status,200);
    assert.deepEqual((await updated.json() as ModelOption[]).map(m=>m.model), ['replacement']);
    const replacement = {provider:'fixture',model:'replacement'};
    const active = await post('/models/probe', replacement);
    assert.equal((await active.json()).status,'verified');
    release();
    assert.equal((await (await original).json()).status,'verified');
    assert.deepEqual(reached,['original','replacement']);
    const template = {id:'research', role:'worker', name:'Researcher', systemPrompt:'Use the available sources.'};
    const save = (selected: {provider:string; model:string}) => app.studio.saveTemplate({...template, role:'worker', selection:selected});
    assert.equal((await save(replacement)).selection.model, 'replacement');
    await assert.rejects(save({provider:'fixture', model:'original'}), /Unknown configured model/);
    assert.equal((await post('/models/probe', {provider:'studio-demo',model:'executor'})).status, 200);
    assert.equal((await app.studio.snapshot()).templates.find(t => t.id === 'worker-default')?.selection.provider,'studio-demo');
    await writeFile(path, 'private-placeholder: [invalid');
    const rejected = await post('/models/refresh');
    assert.equal(rejected.status,400);
    assert.doesNotMatch(await rejected.text(), /private-placeholder/);
    assert.deepEqual(await list(),['replacement']);
    await writeFile(path, '[]');
    assert.deepEqual((await (await post('/models/refresh')).json() as ModelOption[]).map(m=>m.model),[]);
    assert.deepEqual(await list(),[]);
  } finally {
    release();
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>(done=>provider.close(()=>done()));
    await rm(root,{recursive:true,force:true});
  }
});

test('each catalog generation calls only its own endpoint with its own credentials, even during shutdown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'studio-generation-'));
  const ctx = new Context();
  const catalog = new ModelCatalog(ctx, home);
  const selection = {provider:'generation-fixture',model:'test'};
  const startEndpoint = async () => {
    const key = randomUUID();
    const matches: boolean[] = [];
    const endpoint = createServer((req,res) => {
      matches.push(req.headers.authorization === 'Bearer ' + key);
      req.resume();
      res.writeHead(200, {'content-type':'text/event-stream'});
      res.end('data: ' + JSON.stringify({id:'t',object:'chat.completion.chunk',created:1,model:'test',
        choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]}) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((done,reject) => { endpoint.once('error',reject); endpoint.listen(0,'127.0.0.1',done); });
    const address = endpoint.address();
    assert.ok(address && typeof address !== 'string');
    return {key, matches, url:'http://127.0.0.1:'+address.port+'/v1', close:async () => {
      endpoint.closeAllConnections();
      await new Promise<void>(done => endpoint.close(() => done()));
    }};
  };
  const first = await startEndpoint();
  const second = await startEndpoint();
  const configure = async (endpoint: typeof first) => {
    await writeFile(join(home,'cordis.patch.yml'), JSON.stringify([{id:'llm-pi-ai',config:{providers:{
      [selection.provider]:{api:'openai-completions',baseURL:endpoint.url,apiKeyEnv:'STUDIO_GENERATION_KEY',
        models:[{id:selection.model,contextWindow:32768,maxTokens:128}]}
    }}}]));
    await writeFile(join(home,'.env'),'STUDIO_GENERATION_KEY='+endpoint.key);
    await catalog.refresh();
  };
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const probe = async () => {
    const result = await probeConfiguredModel(ctx.llm,selection,new AbortController().signal,3000);
    assert.equal(result.status,'verified',result.message);
  };
  try {
    await ctx.plugin(LlmRuntime);
    await configure(first);
    const oldCycle = catalog.using(async () => { await probe(); started(); await gate; await probe(); });
    await Promise.race([oldCycle, ready]);
    await configure(second);
    await catalog.using(probe);
    const draining = catalog.close();
    await assert.rejects(catalog.using(probe), /unavailable/);
    release();
    await Promise.all([oldCycle,draining]);
    assert.deepEqual(first.matches,[true,true]);
    assert.deepEqual(second.matches,[true]);
  } finally {
    release();
    await catalog.close();
    await ctx.fiber.dispose();
    await Promise.all([first.close(),second.close()]);
    await rm(home,{recursive:true,force:true});
  }
});
