// A selection belongs to one prospective execution, not to the editable template or other runs.
export function workflowInputs({loadGraph, message, changed}) {
  const $=id=>document.getElementById(id);
  const scopes=new Map();
  let current;
  function render() {
    const scope=current;
    $('input-node').replaceChildren();
    for(const node of scope?.graph?.nodes || []) $('input-node').add(new Option(node.name,node.id));
    if(scope?.node) $('input-node').value=scope.node;
    if(scope) scope.node=$('input-node').value;
    $('input-files').disabled=!scope?.node || scope.starting;
    $('input-node').disabled=!scope?.node || scope.starting;
    $('attachments').hidden=!scope;
    const list=$('input-list'); list.replaceChildren();
    for(const file of scope?.files || []) {
      const entry=document.createElement('li'), remove=document.createElement('button');
      const node=scope.graph?.nodes.find(node=>node.id===file.nodeId);
      entry.append(document.createTextNode((node?.name || file.nodeId)+' · '+file.name+(file.reading?'（读取中）':'')+' '));
      remove.type='button'; remove.textContent='撤下'; remove.disabled=scope.starting;
      remove.setAttribute('aria-label','撤下 '+file.name);
      remove.onclick=()=>{scope.files=scope.files.filter(f=>f!==file); scope.requestId=undefined; render();};
      entry.append(remove);list.append(entry);
    }
    changed();
  }
  async function select(runId, templateId, version) {
    const key=runId && templateId && version>0 ? JSON.stringify([runId,templateId,version]) : '';
    if(!key) {current=undefined; render();return;}
    let scope=scopes.get(key);
    if(!scope) {
      scope={key, files:[], requestId:undefined, starting:false};
      scopes.set(key,scope);
    }
    current=scope; render();
    if(!scope.graph && !scope.loading) {
      scope.loading=true;
      try { scope.graph=await loadGraph(templateId,version); }
      catch(error) {if(current===scope) message(error.message);}
      finally {scope.loading=false;if(current===scope) render();}
    }
  }
  async function add(files) {
    const scope=current,nodeId=$('input-node').value;
    if(!scope?.graph || !nodeId || scope.starting) return;
    const entries=Array.from(files,file=>({file,entry:{nodeId,name:file.name,reading:true,content:''}}));
    if(!entries.length) return;
    scope.requestId=undefined; scope.files.push(...entries.map(x=>x.entry)); render();
    await Promise.all(entries.map(async({file,entry})=>{
      try {
        if(file.size>14*1024*1024) throw new Error('附件超过启动请求的 14 MiB 上限');
        const bytes=await file.arrayBuffer(), text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        if(text.includes('\u0000')) throw new Error('文件内容不是 UTF-8 文本');
        entry.content=text;entry.reading=false;
      } catch(error) {
        if(scope.files.includes(entry)) {
          scope.files=scope.files.filter(item=>item!==entry);
          const reason=error instanceof TypeError?'文件不是有效的 UTF-8 文本':error.message;
          scope.error=entry.name+'：'+reason;
        }
      }
    }));
    if(current===scope) {render();if(scope.error) {message(scope.error);delete scope.error;}}
  }
  $('input-node').onchange=()=>{if(current)current.node=$('input-node').value;};
  $('input-files').onchange=event=>{const files=[...event.target.files];event.target.value='';void add(files);};
  $('drop-files').ondragover=event=>{event.preventDefault();event.dataTransfer.dropEffect='copy';};
  $('drop-files').ondrop=event=>{event.preventDefault();void add([...event.dataTransfer.files]);};
  return {
    select,
    get ready() {return !!current?.graph && !current.starting && current.files.every(f=>!f.reading);},
    prepare(runId,templateId,version) {
      const scope=current;
      if(!this.ready || scope.key!==JSON.stringify([runId,templateId,version])) throw new Error('请等待所选版本和附件读取完成');
      scope.starting=true; scope.requestId??=crypto.randomUUID(); render();
      const files=scope.files.map(({nodeId,name,content})=>({nodeId,name,content}));
      return {requestId:scope.requestId,files,finish(success) {
        if(success) {scope.files=[];scope.requestId=undefined;}
        scope.starting=false;
        if(current===scope) render();
      }};
    },
  };
}
