const byId = id => document.getElementById(id);
let version, token;
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function load() {
  byId('save').disabled = true;
  try {
    const [settings, calls, auth] = await Promise.all([api('/api/network/settings'), api('/api/network/calls'), api('/api/bootstrap')]);
    version = settings.version; token = auth.csrfToken;
    byId('sources').replaceChildren(...settings.catalog.map(({id,name}) => {
      const label = document.createElement('label'), box = document.createElement('input');
      box.type = 'checkbox'; box.name = 'source'; box.value = id; box.checked = settings.sources.includes(id);
      label.append(box, ' ' + name); return label;
    }));
    byId('endpoint').value = settings.endpoint;
    byId('hint').textContent = settings.bundled ? '维基百科直连，其他来源默认由独立搜索服务查询。' : '维基百科直连。其他来源需要填写提供 JSON 查询的公开 HTTPS 搜索服务。';
    byId('calls').replaceChildren(...calls.map(call => {
      const row = document.createElement('li');
      row.textContent = new Date(call.at).toLocaleString() + ' · ' + (call.operation === 'search' ? '搜索' : '读取') + ' · ' + ({allowed:'已完成', denied:'授权已关闭',failed:'失败'}[call.outcome]) + ' · Attempt ' + call.attemptId;
      for (const source of call.sources) {
        const link = document.createElement('a');
        link.href = source.url; link.rel = 'noopener noreferrer'; link.target = '_blank'; link.textContent = source.title;
        row.append(' ',link);
      }
      return row;
    }));
    if (!calls.length) byId('calls').textContent = '暂无访问记录。';
    byId('save').disabled = false;
    byId('status').textContent = '';
  } catch (error) { byId('status').textContent = error.message; }
}
byId('reload').addEventListener('click', load);
byId('searchSettings').addEventListener('submit', async event => {
  event.preventDefault();
  byId('save').disabled = true; byId('reload').disabled = true;
  try {
    const settings = await api('/api/network/settings',{method:'PUT',headers:{'content-type':'application/json','x-studio-csrf':token},
      body:JSON.stringify({expectedVersion:version,sources:new FormData(event.target).getAll('source'), endpoint:byId('endpoint').value.trim()})});
    version = settings.version; byId('status').textContent = '已保存，后续搜索使用新设置。';
  } catch (error) { byId('status').textContent = error.message; }
  finally { byId('save').disabled = false; byId('reload').disabled = false; }
});
void load();
