import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dist/src/server.js';

const {chromium}=await import(process.env.STUDIO_PLAYWRIGHT_MODULE || 'playwright');
const dataDir=await mkdtemp(join(tmpdir(),'studio-flow-browser-'));
let app, browser;
try {
  app=await startServer({dataDir,port:0,scheduler:{pollIntervalMs:20}});
  const {csrfToken}=await (await fetch(app.url+'/api/bootstrap')).json();
  const created=await fetch(app.url+'/api/runs',{method:'POST',headers:{'content-type':'application/json','x-studio-csrf':csrfToken},body:JSON.stringify({prompt:'Prepare a demo run',mode:'direct'})});
  assert.equal(created.status,201);
  browser=await chromium.launch({headless:true,...(process.env.STUDIO_CHROME_BIN?{executablePath:process.env.STUDIO_CHROME_BIN}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:1050}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.goto(app.url);
  await page.getByRole('link',{name:'任务流程'}).click();
  await page.locator('#name').fill('Browser workflow');
  await page.locator('#surface').click({button:'right',position:{x:36,y:44}});
  await page.getByRole('button',{name:'节点 1',exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'节点设置'}).click();
  await page.locator('#node-name').fill('Collect');
  await page.locator('#instruction').fill('Collect facts');
  await page.locator('#node-agent').selectOption('worker-default');
  await page.locator('#review').check();
  await page.locator('#input-rule').fill('至少 2 份输入材料');
  await page.locator('#output-rule').fill('必须包含「Accepted」');
  await page.getByRole('button',{name:'添加节点'}).click();
  await page.locator('#node-name').fill('Deliver');
  await page.locator('#instruction').fill('Use the upstream facts');
  const port=page.getByRole('button',{name:'Collect 的输出连接点'});
  await port.dragTo(page.getByRole('button',{name:'Deliver',exact:true}));
  await page.getByRole('button',{name:'Deliver',exact:true}).click();
  assert.ok(await page.getByRole('checkbox',{name:'Collect',exact:true}).isChecked());
  await page.locator('#surface').click({button:'right',position:{x:410,y:145}});
  await page.getByRole('button',{name:'节点 3',exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'删除节点'}).click();
  await page.waitForFunction(()=>document.querySelector('#draft-state').textContent==='草稿已保存');
  const template=app.studio.workflows.templates()[0];
  assert.deepEqual(template.draft.nodes.map(n=>n.name),['Collect','Deliver']);
  assert.deepEqual([template.draft.nodes[0].x,template.draft.nodes[0].y],[36,44]);
  await page.getByRole('button',{name:'发布版本'}).click();
  await page.locator('#input-node').selectOption({label:'Collect'});
  await page.locator('#input-files').setInputFiles([
    {name:'first.txt',mimeType:'text/plain',buffer:Buffer.from('original input A')},
    {name:'remove.txt',mimeType:'text/plain',buffer:Buffer.from('unused')},
  ]);
  await page.getByRole('button',{name:'撤下 remove.txt'}).click();
  await page.evaluate(()=>{
    const transfer=new DataTransfer();
    transfer.items.add(new File(['original input B'],'second.md',{type:'text/markdown'}));
    document.querySelector('#drop-files').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  await page.getByRole('button',{name:'撤下 second.md'}).waitFor();
  await page.getByRole('button',{name:'启动此版本'}).click();
  await page.getByText('Collect · 待人工审核 · 第 1 轮',{exact:true}).click();
  const review=page.getByRole('textbox',{name:'放行内容'});
  await review.fill('Incomplete manual revision');
  await page.getByRole('button',{name:'放行此版本'}).click();
  await page.getByText('检查未通过：必须包含「Accepted」',{exact:true}).waitFor();
  await review.fill('Accepted browser fixture');
  await page.getByRole('button',{name:'放行此版本'}).click();
  await page.getByText('Deliver · 已放行 · 第 1 轮',{exact:true}).waitFor({timeout:20_000});
  const state=await (await fetch(app.url+'/api/state')).json();
  assert.ok(state.runs[0].tasks.some(task=>task.prompt.includes('Accepted browser fixture')));
  assert.ok(state.runs[0].tasks.some(task=>task.prompt.includes('original input A') && task.prompt.includes('original input B') && !task.prompt.includes('remove.txt')));
  const approved=page.locator('details').filter({has:page.getByText('Collect · 已放行 · 第 1 轮',{exact:true})}).first();
  const downloadEvent=page.waitForEvent('download');
  await approved.getByRole('link',{name:'下载 Markdown'}).click();
  const download=await downloadEvent;
  assert.match(await readFile(await download.path(),'utf8'),/Accepted browser fixture/);

  // Hold one actual save response while further typing and switching out of the template.
  let releaseSave, reachedSave;
  const gate=new Promise(resolve=>{releaseSave=resolve;}), reached=new Promise(resolve=>{reachedSave=resolve;});
  let delayOnce=true;
  await page.route('**/api/workflows/templates/'+template.id,async route=>{
    if(!delayOnce || route.request().method()!=='PUT') return route.continue();
    delayOnce=false;
    const response=await route.fetch(); reachedSave(); await gate; await route.fulfill({response});
  });
  await page.locator('#name').fill('Slow edit');
  await reached;
  await page.locator('#name').fill('Latest edit');
  await page.getByRole('button',{name:'新建模板'}).click();
  releaseSave();
  await page.waitForFunction(()=>document.querySelector('#name').value==='新流程');
  assert.equal(app.studio.workflows.templates()[0].draft.name,'Latest edit');
  await page.locator('#templates').selectOption(template.id);
  await page.getByRole('button',{name:'发布版本'}).click();
  await page.waitForFunction(()=>document.querySelector('#message').textContent==='已发布 v2');
  await page.locator('#history').selectOption('1');
  await page.getByRole('button',{name:'恢复为草稿'}).click();
  await page.waitForFunction(()=>document.querySelector('#name').value==='Browser workflow');
  assert.equal(app.studio.workflows.graph(template.id,2).name,'Latest edit');

  const other=await browser.newPage(); other.on('dialog',dialog=>dialog.accept());
  await other.goto(app.url+'/workflows.html?template='+template.id);
  await other.waitForFunction(()=>document.querySelector('#name').value==='Browser workflow');
  await page.locator('#name').fill('Fresh remote edit');
  await page.waitForFunction(()=>document.querySelector('#draft-state').textContent==='草稿已保存');
  await other.locator('#name').fill('Retained local edit');
  await other.waitForFunction(()=>document.querySelector('#draft-state').textContent.includes('冲突'));
  assert.equal(await other.locator('#name').inputValue(),'Retained local edit');
  assert.equal(app.studio.workflows.templates()[0].draft.name,'Fresh remote edit');
  await other.getByRole('button',{name:'重新载入'}).click();
  await other.waitForFunction(()=>document.querySelector('#name').value==='Fresh remote edit');
  await other.close();

  // A late read remains with the original Run, published version and node.
  const originalRun=state.runs[0].id;
  const different=await app.studio.createRun({prompt:'Separate input scope',mode:'direct'});
  await page.getByRole('button',{name:'刷新进度'}).click();
  await page.locator('#versions').selectOption('1');
  await page.locator('#input-node').selectOption({label:'Collect'});
  await page.evaluate(()=>{
    let resume; const paused=new Promise(done=>{resume=done;});window.releaseFixtureRead=resume;
    const original=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=async function(){if(this.name==='late.txt') await paused;return original.call(this);};
    const transfer=new DataTransfer();transfer.items.add(new File(['local scoped file'],'late.txt'));
    document.querySelector('#drop-files').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  await page.locator('#runs').selectOption(different.id);
  await page.evaluate(()=>window.releaseFixtureRead());
  assert.equal(await page.locator('#input-list li').count(),0);
  await page.getByRole('button',{name:'启动此版本'}).click();
  await page.getByText('Collect · 失败 · 第 1 轮',{exact:true}).click();
  await page.getByText('检查未通过：至少 2 份输入材料',{exact:true}).waitFor();
  await page.locator('#runs').selectOption(originalRun);
  await page.getByRole('button',{name:'撤下 late.txt'}).waitFor();
  await page.locator('#versions').selectOption('2');
  assert.equal(await page.locator('#input-list li').count(),0);
  await page.locator('#versions').selectOption('1');
  await page.getByRole('button',{name:'撤下 late.txt'}).click();

  await page.getByRole('button',{name:'停用模板'}).click();
  await page.getByRole('button',{name:'重新启用'}).waitFor();
  assert.ok(await page.locator('#start').isDisabled());
  assert.ok(await page.locator('#publish').isDisabled());
  assert.equal(app.studio.workflows.instances(state.runs[0].id).length,1);
  await page.getByRole('button',{name:'重新启用'}).click();
  await page.getByRole('button',{name:'停用模板'}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Workflow UI passed: template, drag connection, pinned Worker, human review, and dependent task handoff.');
} finally { await browser?.close(); await app?.close(); await rm(dataDir,{recursive:true,force:true}); }
