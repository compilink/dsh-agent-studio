import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../dist/src/server.js';

const {chromium} = await import(process.env.STUDIO_PLAYWRIGHT_MODULE || 'playwright');
const home = await mkdtemp(join(tmpdir(), 'studio-model-ui-'));
const patch = join(home, 'cordis.patch.yml');
const provider = createServer(async (req, res) => {
  for await (const _chunk of req) { /* Drain the fixture request before replying. */ }
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  res.end('data: {"id":"test","object":"chat.completion.chunk","model":"second","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: [DONE]\n\n');
});
let app, browser;
try {
  await new Promise((accept, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', accept); });
  const baseURL = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const configure = id => writeFile(patch, JSON.stringify([{id:'llm-pi-ai', config:{providers:{fixture:{
    api:'openai-completions', baseURL, apiKeyEnv:'STUDIO_FIXTURE', models:[{id, contextWindow:32768, maxTokens:256}],
  }}}}]));
  await configure('first');
  await writeFile(join(home,'.env'), 'STUDIO_FIXTURE=local-fixture-key');
  app = await startServer({dataDir:join(home,'data'), dshHome:home, port:0});
  browser = await chromium.launch({headless:true, ...(process.env.STUDIO_CHROME_BIN ? {executablePath:process.env.STUDIO_CHROME_BIN} : {})});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('#settingsButton').click();
  await page.locator('#settingsDialog[open]').waitFor();
  assert.equal(await page.locator('#probeModel').isDisabled(), true);
  const name = page.locator('#templateName');
  const model = page.locator('#templateModel');
  assert.equal(await model.locator('option:not([disabled])').count(), 1);
  await name.fill('Unsaved edit');
  await model.selectOption({label:'first · fixture'});
  await configure('second');
  await page.getByRole('button',{name:'刷新模型目录'}).click();
  await page.locator('#modelStatus').filter({hasText:'已更新'}).waitFor();
  assert.equal(await name.inputValue(), 'Unsaved edit');
  assert.match(await model.locator(':checked').innerText(), /不可用.*first/);
  assert.equal(await page.locator('#probeModel').isDisabled(), true);
  await model.selectOption({label:'second · fixture'});
  await page.getByRole('button',{name:'测试连接'}).click();
  await page.locator('#modelStatus').filter({hasText:'真实响应'}).waitFor();
  await writeFile(patch,'invalid: [');
  await page.getByRole('button',{name:'刷新模型目录'}).click();
  await page.locator('#modelStatus').filter({hasText:'上次成功加载'}).waitFor();
  assert.equal(await model.inputValue(), JSON.stringify(['fixture','second']));
  assert.equal((await app.studio.snapshot()).runs.length, 0);
  assert.deepEqual(errors, []);
  console.log('Agent settings passed model refresh, connection probe and draft preservation.');
} finally {
  await browser?.close();
  await app?.close();
  provider.closeAllConnections();
  await new Promise(done => provider.close(done));
  await rm(home, {recursive:true, force:true});
}
