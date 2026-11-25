const el = id => document.getElementById(id);
let token;
let entries = [];
let selected = null;
let loadedVersion = 0;
let dirty = false;
let loading = false;
let sequence = 0;

async function api(url, method = 'GET', value) {
  const options = method === 'GET' ? {} : {
    method,
    headers: {'content-type':'application/json','x-studio-csrf':token},
    body: JSON.stringify(value),
  };
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function controls() {
  const editable = !selected || (!selected.retired && loadedVersion === selected.version);
  for (const id of ['name','summary','body']) el(id).readOnly = !editable || loading;
  el('save').disabled = !token || loading || !editable || !dirty;
  el('save').textContent = selected ? '保存新版本' : '创建 Skill';
  el('retire').hidden = !selected || !editable;
  el('retire').disabled = loading;
}
async function show(id, version) {
  const ticket = ++sequence;
  selected = entries.find(entry => entry.id === id) || null;
  loadedVersion = selected ? Number(version || selected.version) : 0;
  el('selection').value = selected?.id || '';
  el('revisions').hidden = !selected;
  el('revision').replaceChildren(...Array.from({length:selected?.version || 0}, (_,index) => {
    const v = selected.version - index;
    return new Option(String(v),String(v));
  }));
  el('revision').value = String(loadedVersion);
  loading = true;
  dirty = false;
  controls();
  try {
    const data = selected ? await api('/api/skills/'+encodeURIComponent(id)+'?version='+loadedVersion) : {};
    if (ticket !== sequence) return;
    for (const key of ['name','summary','body']) el(key).value = data[key] || '';
    el('status').textContent = selected?.retired ? '此 Skill 已退役。已创建的成员可以继续读取原版本。' : '';
    loading = false;
  } catch (error) {
    if (ticket === sequence) el('status').textContent = error.message;
  } finally {
    if (ticket === sequence) controls();
  }
}
async function load(id) {
  entries = await api('/api/skills'+(el('showRetired').checked ? '?includeRetired=1' : ''));
  el('selection').replaceChildren(new Option('新建 Skill',''),...entries.map(entry =>
    new Option(entry.name+(entry.retired?'（已退役）':''),entry.id)));
  await show(id);
}
const discard = () => !dirty || window.confirm('放弃当前未保存的修改？');
el('editor').addEventListener('input', event => {
  if (!['name','summary','body'].includes(event.target.id)) return;
  dirty = true; controls();
});
el('selection').onchange = () => {
  if (discard()) void show(el('selection').value);
  else el('selection').value = selected?.id || '';
};
el('revision').onchange = () => {
  if (discard()) void show(selected.id,el('revision').value);
  else el('revision').value = String(loadedVersion);
};
el('showRetired').onchange = async () => {
  if (!discard()) { el('showRetired').checked = !el('showRetired').checked; return; }
  try { await load(selected?.id); } catch (error) { el('status').textContent = error.message; }
};
el('editor').onsubmit = async event => {
  event.preventDefault();
  if (loading || el('save').disabled) return;
  loading = true; controls();
  try {
    const value = {name:el('name').value,summary:el('summary').value,body:el('body').value};
    const skill = selected
      ? await api('/api/skills/'+selected.id,'PUT',{...value,expectedVersion:selected.version})
      : await api('/api/skills','POST',value);
    await load(skill.id);
    el('status').textContent = '已保存版本 '+skill.version;
  } catch (error) { el('status').textContent = error.message; }
  finally { loading = false; controls(); }
};
el('retire').onclick = async () => {
  if (!selected || loading || !confirm('退役后，新成员将不再获得此 Skill。确认退役？')) return;
  loading = true; controls();
  try {
    const skill = await api('/api/skills/'+selected.id,'DELETE',{expectedVersion:selected.version});
    await load(skill.id);
    el('status').textContent = '已退役。已绑定旧版本的成员可继续使用。';
  } catch (error) { el('status').textContent = error.message; }
  finally { loading = false; controls(); }
};
(async () => {
  try { token = (await api('/api/bootstrap')).csrfToken; await load(); }
  catch (error) { el('status').textContent = error.message; }
})();
