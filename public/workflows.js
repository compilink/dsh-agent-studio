import {workflowInputs} from './workflow-inputs.js';
const $ = id => document.getElementById(id);
const el = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
const choice = (label, value) => new Option(label, value);
const message = value => { $('message').textContent = value; };
const states = {waiting:'等待上游', checking:'检查中', dispatched:'已派发', review:'待人工审核', released:'已放行', rejected:'已退回', failed:'失败'};
let csrf, current, selected, dirty = false, templates = [], runs = [], agents = [], connectFrom, epoch = 0, instancesKey = '';
let editSerial = 0, saveTimer, saving, conflict = false;
const recoveryKey = 'studio-workflow-pending';
const graphs = new Map();
async function graphFor(templateId,version) {
  const key=templateId+':'+version;
  if(!graphs.has(key)) graphs.set(key,await api('/api/workflows/templates/'+templateId+'/versions/'+version));
  return graphs.get(key);
}
const inputs=workflowInputs({loadGraph:graphFor,message,changed:()=>{if(current) updateButtons();}});
function selectInputs() {return inputs.select($('runs').value,current?.id,Number($('versions').value));}
const annotations = new Map();
const uid = () => crypto.randomUUID();
const empty = () => ({id:uid(), revision:0, published:0, draft:{name:'新流程',nodes:[],edges:[]}});
async function api(path, method='GET', data) {
  const response = await fetch(path, {method, headers:{'Content-Type':'application/json','X-Studio-CSRF':csrf || ''},
    ...(data === undefined ? {} : {body:JSON.stringify(data)})});
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '请求失败'), {status:response.status});
  return result;
}
function action(fn) { return async event => { try { await fn(event); } catch (error) { message(error.message); } }; }
const templatePath = () => '/api/workflows/templates/' + current.id;
const currentNode = () => current.draft.nodes.find(node => node.id === selected);
function recordLocal() {
  try {
    if(dirty) sessionStorage.setItem(recoveryKey,JSON.stringify(current));
    else sessionStorage.removeItem(recoveryKey);
  } catch { /* SQLite remains the durable store when session storage is unavailable. */ }
}
function cache(template) {
  const i=templates.findIndex(entry=>entry.id===template.id);
  if(i<0) templates.unshift(template); else templates[i]=template;
}
function markDirty() {
  dirty=true; editSerial++; recordLocal(); updateButtons();
  clearTimeout(saveTimer);
  if(!conflict) saveTimer=setTimeout(()=>flush().catch(error=>message(error.message)),350);
}
async function flush() {
  clearTimeout(saveTimer);
  if(saving) return saving;
  if(conflict) throw new Error('其他窗口已修改模板。请保留所需文字，再重新载入。');
  if(!dirty) return;
  const owner=current;
  saving=(async()=>{
    while(owner===current && dirty) {
      const serial=editSerial;
      const saved=await api(templatePath(),'PUT',{expectedRevision:owner.revision, graph:structuredClone(owner.draft)});
      cache(saved);
      if(owner!==current) return;
      owner.revision=saved.revision;
      dirty=editSerial!==serial; recordLocal();
      const option=Array.from($('templates').options).find(item=>item.value===owner.id);
      if(option) option.textContent=saved.draft.name;
    }
  })().catch(error=>{
    if(owner===current && error.status===409) conflict=true;
    throw error;
  }).finally(()=>{saving=undefined;updateButtons();});
  updateButtons(); return saving;
}
function updateButtons() {
  $('publish').disabled=!!current.retired || conflict || !current.revision && !dirty;
  $('draft-state').textContent=current.retired?'模板已停用':conflict?'草稿冲突，本页修改尚未覆盖服务器':saving?'正在保存草稿…':dirty?'草稿待保存':current.revision?'草稿已保存':'';
  $('name').disabled=$('add').disabled=!!current.retired;
  $('surface').inert=!!current.retired;
  $('restore').disabled=!!current.retired || !current.published || conflict;
  $('history').disabled=!current.published;
  $('retire').disabled=!current.revision || conflict;
  $('retire').textContent=current.retired?'重新启用':'停用模板';
  $('start').disabled=!!current.retired || !current.published || !inputs.ready;
}
async function exclusive(fn) {
  const section=$('templates').closest('section');
  if(section.inert) return;
  section.inert=true; closeMenu();
  try { await fn(); } finally {section.inert=false;}
}
window.addEventListener('beforeunload',event=>{ if(dirty) {event.preventDefault();event.returnValue='';} });
function connect(from,to) {
  if (!from || !to || from===to) { message('请选择另一个节点作为下游'); return false; }
  const edges=current.draft.edges;
  if (edges.some(e=>e.from===from&&e.to===to)) return true;
  const stack=[to], seen=new Set();
  while(stack.length) {
    const node=stack.pop();
    if(node===from) { message('该连线会形成环'); return false; }
    if(seen.has(node)) continue;
    seen.add(node); for(const edge of edges) if(edge.from===node) stack.push(edge.to);
  }
  edges.push({from,to}); markDirty(); message('已连接节点'); return true;
}
function canvas() {
  const area = $('surface'), {nodes,edges} = current.draft;
  area.replaceChildren();
  area.style.width = Math.max(450, ...nodes.map(n=>n.x+192))+'px';
  area.style.height = Math.max(240, ...nodes.map(n=>n.y+76))+'px';
  const ns = 'http://www.w3.org/2000/svg';
  const lines = document.createElementNS(ns,'svg');
  const defs = document.createElementNS(ns,'defs'), marker = document.createElementNS(ns,'marker'), tip = document.createElementNS(ns,'path');
  for (const [k,v] of Object.entries({id:'arrow',viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'6',markerHeight:'6',orient:'auto'})) marker.setAttribute(k,v);
  tip.setAttribute('d','M 0 0 L 10 5 L 0 10 z'); tip.setAttribute('fill','#527a63'); marker.append(tip); defs.append(marker); lines.append(defs);
  const map = new Map(nodes.map(n=>[n.id,n]));
  for (const {from,to} of edges) {
    const a = map.get(from), b = map.get(to);
    const path = document.createElementNS(ns,'path');
    const leftToRight = a.x <= b.x, x1 = a.x + (leftToRight?164:0), x2 = b.x + (leftToRight?0:164), mid = (x1+x2)/2;
    path.setAttribute('d',`M ${x1} ${a.y+26} C ${mid} ${a.y+26}, ${mid} ${b.y+26}, ${x2} ${b.y+26}`);
    path.setAttribute('fill','none'); path.setAttribute('stroke','#527a63'); path.setAttribute('stroke-width','2'); path.setAttribute('marker-end','url(#arrow)'); lines.append(path);
  }
  area.append(lines);
  for (const node of nodes) {
    const button = el('button',node.name); button.className='node'; button.title=node.name; button.dataset.nodeId=node.id;
    button.style.left=node.x+'px'; button.style.top=node.y+'px'; button.setAttribute('aria-pressed',String(selected===node.id));
    button.onclick = () => { if(connectFrom) { connect(connectFrom,node.id);connectFrom=undefined; } selected=node.id; canvas(); editor(); };
    button.onpointerdown = event => {
      if (event.button !== 0 || connectFrom) return;
      const start = {x:event.clientX,y:event.clientY,left:node.x,top:node.y};
      button.setPointerCapture(event.pointerId);
      button.onpointermove = e => { if (!button.hasPointerCapture(e.pointerId)) return;
        const clamp = v=>Math.min(10000,Math.max(0,Math.round(v)));
        node.x=clamp(start.left+e.clientX-start.x); node.y=clamp(start.top+e.clientY-start.y);
        button.style.left=node.x+'px'; button.style.top=node.y+'px';
      };
      const end = () => { button.onpointermove=null; selected=node.id;
        if (node.x!==start.left || node.y!==start.top) markDirty();
        canvas(); editor();
      };
      button.onpointerup=end; button.onpointercancel=end;
    };
    const port=el('button'); port.className='port'; port.dataset.nodeId=node.id;
    port.setAttribute('aria-label',node.name+' 的输出连接点'); port.style.left=(node.x+155)+'px'; port.style.top=(node.y+17)+'px';
    port.onpointerdown=e=>{ if(e.button!==0)return; port.setPointerCapture(e.pointerId); };
    port.onpointerup=e=>{
      const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-node-id]')?.dataset.nodeId;
      if(target&&target!==node.id) { connect(node.id,target); connectFrom=undefined; canvas(); editor(); }
    };
    port.onclick=()=>{connectFrom=node.id;message('点选目标节点完成连线');};
    area.append(button,port);
  }
}
function editor() {
  const node = currentNode(); $('editor').disabled=!node || !!current.retired;
  if (!node) return;
  $('input-rule').value=node.inputRule || ''; $('output-rule').value=node.outputRule || '';
  $('node-name').value=node.name; $('instruction').value=node.instruction; $('review').checked=node.review;
  const run=runs.find(r=>r.id===$('runs').value), root=run?.agents.find(a=>a.id===run.orchestratorId);
  const allowed=(parent,target)=>!parent.delegateIds || parent.delegateIds.includes(target.id);
  const available=agents.filter(a=>{
    if (!root) return true;
    if (a.role==='orchestrator') return a.id===root.templateId && a.version===root.templateVersion;
    if (a.role==='manager') return run.mode!=='direct' && allowed(root,a);
    if (run.mode==='hierarchical') return agents.some(m=>m.role==='manager' && allowed(root,m) && allowed(m,a));
    return allowed(root,a);
  });
  const select=$('node-agent'); select.replaceChildren(choice('沿用协作编排',''),...available.map(a=>choice(a.name+' · '+a.role,a.id)));
  if (node.templateId&&!available.some(a=>a.id===node.templateId)) select.add(choice((agents.find(a=>a.id===node.templateId)?.name||node.templateId)+'（当前协作不可用）',node.templateId));
  select.value=node.templateId || '';
  const box=$('parents'); box.replaceChildren(el('span','上游输入 '));
  for (const other of current.draft.nodes.filter(n=>n.id!==node.id)) {
    const label=el('label'); label.className='check'; const check=el('input'); check.type='checkbox';
    check.checked = current.draft.edges.some(e=>e.from===other.id && e.to===node.id);
    check.onchange = () => {
      if (check.checked) { if(!connect(other.id,node.id)) {check.checked=false;return;} }
      else current.draft.edges=current.draft.edges.filter(e=>e.from!==other.id||e.to!==node.id);
      markDirty(); canvas();
    };
    label.append(check,document.createTextNode(other.name)); box.append(label);
  }
}
function show(template) {
  connectFrom=undefined; current=structuredClone(template); selected=current.draft.nodes[0]?.id; dirty=false; conflict=false;
  const select=$('templates'); select.replaceChildren(...templates.map(t=>choice(t.draft.name+(t.retired?'（已停用）':''),t.id)));
  if (!templates.some(t=>t.id===current.id)) select.add(choice('新建模板',current.id));
  select.value=current.id; $('name').value=current.draft.name;
  for(const select of [$('versions'),$('history')]) {
    select.replaceChildren();
    for(let i=current.published;i>=1;i--) select.add(choice('v'+i,String(i)));
  }
  canvas(); editor(); updateButtons(); void selectInputs();
}
async function lifecycle(operation, method, payload) {
  await exclusive(async()=>{
    await flush();
    const next=await api(templatePath()+'/'+operation,method,{expectedRevision:current.revision,...payload});
    cache(next); show(next); recordLocal();
    message(operation==='publish'?'已发布 v'+next.published:operation==='restore'?'历史版本已恢复至草稿':next.retired?'模板已停用':'模板已启用');
  });
}
async function reload(preferred=current?.id) {
  templates=await api('/api/workflows/templates'); show(templates.find(t=>t.id===preferred) || templates.find(t=>!t.retired) || templates[0] || empty());
}
async function listRuns() {
  const state=await api('/api/state'); runs=state.runs; agents=state.templates;
  const sel=$('runs'), old=sel.value || new URLSearchParams(location.search).get('run');
  sel.replaceChildren(...runs.map(r=>choice(r.title+(r.status==='stopped'?'（已停止）':''),r.id)));
  if(runs.some(r=>r.id===old)) sel.value=old;
  if(!runs.length) sel.add(choice('先在工作台新建协作',''));
  if(current) {editor();void selectInputs();}
}
function downloads(instanceId,nodeId,round) {
  const group=el('p'); group.className='downloads';
  for(const [format,label] of [['md','下载 Markdown'],['docx','下载 Word']]) {
    const link=el('a',label);
    link.href='/api/workflows/instances/'+encodeURIComponent(instanceId)+'/nodes/'+encodeURIComponent(nodeId)+'/rounds/'+round+'/export?format='+format;
    group.append(link);
  }
  return group;
}
async function renderRuns(force=false) {
  const run=$('runs').value, token=++epoch, box=$('instances');
  if(!run) { box.replaceChildren(); return; }
  const items=await api('/api/workflows/runs/'+run), signature=run+JSON.stringify(items);
  if(!force && (signature===instancesKey || box.contains(document.activeElement) && document.activeElement?.tagName==='TEXTAREA')) return;
  for (const item of items) {
    const key=item.templateId+':'+item.version;
    if(!graphs.has(key)) graphs.set(key,await api('/api/workflows/templates/'+item.templateId+'/versions/'+item.version));
  }
  if(token!==epoch || $('runs').value!==run) return;
  instancesKey=signature;
  const opened=new Set([...box.querySelectorAll('details[open]')].map(d=>d.dataset.id)); box.replaceChildren();
  for(const item of items) {
    const graph=graphs.get(item.templateId+':'+item.version), section=el('article');
    section.append(el('h3',graph.name+' · v'+item.version+(item.stopped?' · 已停止':'')));
    for(const n of item.nodes) {
      const spec=graph.nodes.find(node=>node.id===n.id), pass=n.passes.at(-1), details=el('details');
      details.dataset.id=item.id+':'+n.id; details.open=opened.has(details.dataset.id);
      details.append(el('summary',spec.name+' · '+states[pass.stage]+' · 第 '+n.passes.length+' 轮'));
      if(pass.taskId) details.append(el('p','任务 '+pass.taskId));
      if(pass.input?.length) details.append(el('p','上游版本：'+pass.input.map(ref=>graph.nodes.find(node=>node.id===ref.nodeId).name+' 第 '+ref.round+' 轮').join('、')));
      if(spec.agent) details.append(el('p','Agent '+spec.agent.name+' · v'+spec.agent.version));
      if(pass.output) details.append(el('pre',pass.output));
      if(pass.stage==='released') details.append(downloads(item.id,n.id,n.passes.length));
      if(pass.note) details.append(el('p',pass.note));
      const submit = async (op, extras={}) => {
        await api('/api/workflows/instances/'+item.id+'/nodes/'+n.id,'POST',{action:op,round:n.passes.length,taskId:pass.taskId,...extras});
        await renderRuns(true);
      };
      if(!item.stopped && pass.stage==='review') {
        const editKey=details.dataset.id+':'+n.passes.length, edit=annotations.get(editKey);
        const content=el('textarea'); content.value=edit?.content ?? pass.output; content.setAttribute('aria-label','放行内容'); content.rows=4;
        const note=el('textarea'); note.placeholder='审核意见'; note.setAttribute('aria-label','审核意见'); note.rows=2; note.value=edit?.note || '';
        content.oninput=note.oninput=()=>annotations.set(editKey,{content:content.value,note:note.value});
        const approve=el('button','放行此版本'),reject=el('button','退回');
        approve.onclick=action(()=>submit('approve',{content:content.value,note:note.value})); reject.onclick=action(()=>submit('reject',{note:note.value}));
        details.append(content,note,approve,reject);
      }
      if(!item.stopped && !['waiting','dispatched','checking'].includes(pass.stage)) {
        const again=el('button','重跑本节点及下游'); again.onclick=action(()=>submit('rerun')); details.append(again);
      }
      if(n.passes.length>1) {
        const older=el('details'); older.append(el('summary','历史执行'));
        for(const [i,p] of n.passes.slice(0,-1).entries()) {
          older.append(el('p','第 '+(i+1)+' 轮 · '+states[p.stage]+(p.note?' · '+p.note:'')),el('pre',p.output||''));
          if(p.stage==='released') older.append(downloads(item.id,n.id,i+1));
        }
        details.append(older);
      }
      section.append(details);
    }
    box.append(section);
  }
  if (!items.length) box.append(el('p','此协作尚无流程实例。'));
}
function closeMenu() { $('node-menu').hidden=true; }
function addNode(x,y) {
  const node={id:uid(),name:'节点 '+(current.draft.nodes.length+1),instruction:'',review:false,x,y};
  current.draft.nodes.push(node);selected=node.id;markDirty();canvas();editor();$('node-name').focus();
}
function deleteNode() {
  current.draft.nodes=current.draft.nodes.filter(n=>n.id!==selected);
  current.draft.edges=current.draft.edges.filter(e=>e.from!==selected&&e.to!==selected);
  selected=current.draft.nodes[0]?.id;markDirty();closeMenu();canvas();editor();
}
$('new').onclick=action(()=>exclusive(async()=>{await flush(); show(empty());}));
$('reload').onclick=action(()=>exclusive(async()=>{
  clearTimeout(saveTimer);
  if(saving) await saving.catch(()=>{});
  if(dirty&&!window.confirm('重新载入会放弃此页尚未保存的修改，继续吗？')) return;
  await reload();recordLocal();message('');
}));
$('templates').onchange=action(async()=>{
  const desired=$('templates').value; $('templates').value=current.id;
  await exclusive(async()=>{await flush(); show(templates.find(t=>t.id===desired)||empty());});
});
$('name').oninput=e=>{current.draft.name=e.target.value;markDirty();};
$('add').onclick=()=>{const i=current.draft.nodes.length;addNode(20+(i%4)*210,20+Math.floor(i/4)*85);};
$('surface').oncontextmenu=e=>{
  if(current.retired) return;
  e.preventDefault();closeMenu();
  const node=e.target.closest('[data-node-id]');
  if(!node) {
    const rect=$('surface').getBoundingClientRect();
    const position=value=>Math.max(0,Math.min(10000,Math.round(value)));
    addNode(position(e.clientX-rect.left),position(e.clientY-rect.top));
    return;
  }
  selected=node.dataset.nodeId;canvas();editor();
  const menu=$('node-menu');menu.hidden=false;
  menu.style.left=Math.min(e.clientX,window.innerWidth-menu.offsetWidth)+'px';
  menu.style.top=Math.min(e.clientY,window.innerHeight-menu.offsetHeight)+'px';
  $('configure-node').focus();
};
$('configure-node').onclick=()=>{closeMenu();$('node-name').focus();};
$('delete-node').onclick=deleteNode;
document.addEventListener('pointerdown',event=>{if(!$('node-menu').contains(event.target)) closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape') closeMenu();});
$('node-name').oninput=e=>{currentNode().name=e.target.value;markDirty();canvas();};
$('node-agent').onchange=e=>{const node=currentNode();if(e.target.value) node.templateId=e.target.value;else delete node.templateId;markDirty();};
for(const [field,property] of [['input-rule','inputRule'],['output-rule','outputRule']]) {
  $(field).oninput=event=>{const node=currentNode();if(event.target.value) node[property]=event.target.value;else delete node[property];markDirty();};
}
$('instruction').oninput=e=>{currentNode().instruction=e.target.value;markDirty();};
$('review').onchange=e=>{currentNode().review=e.target.checked;markDirty();};
$('remove').onclick=deleteNode;
$('publish').onclick=action(()=>lifecycle('publish','POST',{}));
$('restore').onclick=action(()=>window.confirm('用所选历史版本替换当前草稿？') && lifecycle('restore','POST',{sourceVersion:Number($('history').value)}));
$('retire').onclick=action(()=>lifecycle('retired','PUT',{retired:!current.retired}));
$('start').onclick=action(async()=>{
  const runId=$('runs').value, version=Number($('versions').value), templateId=current.id;
  const attempt=inputs.prepare(runId,templateId,version);
  try {await api('/api/workflows/templates/'+templateId+'/start','POST',{runId,version,requestId:attempt.requestId,...(attempt.files.length?{files:attempt.files}:{})});}
  catch(error) {attempt.finish(false);throw error;}
  attempt.finish(true);await renderRuns(true);message('已启动所选版本');
});
$('versions').onchange=action(selectInputs);
$('runs').onchange=action(async()=>{await selectInputs();editor();await renderRuns(true);});
$('refresh').onclick=action(async()=>{await listRuns();updateButtons();await renderRuns(true);});
try {
  csrf=(await api('/api/bootstrap')).csrfToken;
  await listRuns();
  let pending;
  try { pending=JSON.parse(sessionStorage.getItem(recoveryKey) || 'null'); } catch { /* No recoverable edit. */ }
  await reload(pending?.id || new URLSearchParams(location.search).get('template'));
  if(pending?.id && pending.draft?.nodes && pending.draft?.edges) {
    const saved=templates.find(t=>t.id===pending.id);
    if(saved && JSON.stringify(saved.draft)===JSON.stringify(pending.draft)) recordLocal();
    else {
      show(pending); conflict=!!saved && (saved.retired || saved.revision!==pending.revision);
      markDirty();
    }
  }
  await renderRuns();
  setInterval(()=>action(()=>renderRuns())(),2500);
} catch(error) {message(error.message);}
