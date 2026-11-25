import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import {ModelCatalog} from '../src/model-catalog.js';
import {validateWithModel} from '../src/workflow-checks.js';

test('configured DSH model validates workflow rules with complete receipts and sanitized failures', {timeout:15000}, async () => {
  const ctx = new Context();
  const home = await mkdtemp(join(tmpdir(),'studio-model-rule-'));
  const catalog = new ModelCatalog(ctx,home);
  const selection = {provider:'rule-fixture',model:'rule-checker'};
  const key = randomUUID();
  const rule = 'The report should distinguish observations from judgments.';
  const content = 'An observer recorded three arrivals. The reviewer considered that unusual.';
  const passed = {status:'passed',reason:'Observations and judgments are identified separately.'};
  const failed = {status:'failed',reason:'The observation lacks a source.'};
  const cases = [
    {text:JSON.stringify(passed),finish:'stop',expected:'passed'},
    {text:JSON.stringify(failed),finish:'stop',expected:'failed'},
    {text:JSON.stringify({status:'passed',reason:12}),finish:'stop',expected:'unknown'},
    {text:'invalid output ' + key,finish:'stop',expected:'unknown'},
    {text:'{"status":"passed","reason":"incomplete',finish:'stop',expected:'unknown'},
    {text:JSON.stringify(passed),finish:'length',expected:'unknown'},
    {text:'',finish:'error',expected:'unknown'},
  ];
  const observed: {authorized:boolean; selected:boolean; quoted:boolean; noTools:boolean}[] = [];
  const endpoint = createServer(async (req,res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      model:string; tools?:unknown[]; messages:{role:string; content:unknown}[];
    };
    const sample = cases[observed.length];
    const user = request.messages.find(item => item.role === 'user')?.content;
    const payload = typeof user === 'string' ? user :
      Array.isArray(user) ? user.map(block => block.text || '').join('') : '';
    const input = JSON.parse(payload);
    observed.push({authorized:req.headers.authorization === 'Bearer ' + key, selected:request.model === selection.model,
      quoted:input.rule === rule && input.content === content,noTools:!request.tools?.length});
    if (!sample || sample.finish === 'error') {
      res.writeHead(401,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'simulated private diagnostic ' + key}}));
      return;
    }
    const event = (delta: object, finish_reason: string | null) => 'data: ' + JSON.stringify({
      id:'rule-check',object:'chat.completion.chunk',created:1,model:selection.model,choices:[{index:0,delta,finish_reason}],
    }) + '\n\n';
    const cut = Math.floor(sample.text.length/2);
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(event({role:'assistant',content:sample.text.slice(0,cut)},null) +
      event({content:sample.text.slice(cut)},null) + event({},sample.finish) + 'data: [DONE]\n\n');
  });
  try {
    await new Promise<void>((resolve,reject) => { endpoint.once('error',reject); endpoint.listen(0,'127.0.0.1',resolve); });
    const address = endpoint.address();
    assert.ok(address && typeof address !== 'string');
    await writeFile(join(home,'cordis.patch.yml'),JSON.stringify([{id:'llm-pi-ai',config:{providers:{
      [selection.provider]:{api:'openai-completions',baseURL:'http://127.0.0.1:'+address.port+'/v1',apiKeyEnv:'STUDIO_RULE_TEST_KEY',
        models:[{id:selection.model,contextWindow:32768,maxTokens:2048}]},
    }}}]));
    await writeFile(join(home,'.env'),'STUDIO_RULE_TEST_KEY='+key);
    await ctx.plugin(LlmRuntime);
    await catalog.refresh();
    for (const sample of cases) {
      const result = await catalog.using(() => validateWithModel(ctx.llm,selection,rule,content,AbortSignal.timeout(3000)));
      assert.ok(!JSON.stringify(result).includes(key), 'Raw provider output and credentials must not appear in failure diagnostics');
      assert.equal(result.status,sample.expected);
      if (sample.expected === 'passed' || sample.expected === 'failed') assert.deepEqual(result,JSON.parse(sample.text));
      else assert.ok(result.reason.trim().length);
    }
    assert.equal(observed.length,cases.length);
    assert.ok(observed.every(o => o.authorized && o.selected && o.quoted && o.noTools));
  } finally {
    await catalog.close();
    await ctx.fiber.dispose();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await rm(home,{recursive:true,force:true});
  }
});
