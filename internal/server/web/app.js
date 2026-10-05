'use strict';
const el = id => document.getElementById(id);
const baseURL = new URL('./', location.href);
const icons = () => window.lucide?.createIcons();
const labels = { queued: '排队中', running: '执行中', awaiting_approval: '待审批', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', proposed: '已提出', approved: '已批准', denied: '已拒绝', unknown: '结果未知' };
const toolNames = { read_file: '读取文件', list_files: '列举文件', apply_patch: '应用补丁', create_file: '新建文件', run_tests: '运行规则测试' };
let current = null, sessions = [], stream = null, busy = false, approvalBusy = false, refreshTimer = null, noticeTimer = null;
let selectedFile = '', eventCursor = 0, eventRows = [], partial = '', fileVersion = 0, navigation = 0;
let connection = null, attachments = [], workspaceFiles = [], currentFileContent = '', settingsBusy = false;
let authEpoch = 0, authController = new AbortController();
const identityChannel = new BroadcastChannel(`agent-continue-auth:${baseURL.pathname}`);
identityChannel.onmessage=()=>{resetIdentity();location.replace(location.pathname);};
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) { el('token').value = fragment.get('token'); fragment.delete('token'); history.replaceState(null, '', `${location.pathname}#${fragment}`); }
function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function icon(name) { const i = document.createElement('i'); i.dataset.lucide = name; return i; }
function badge(status) { return node('span', `badge ${status === 'completed' ? 'success' : status === 'awaiting_approval' ? 'warning' : ['failed','unknown','interrupted'].includes(status) ? 'error' : ''}`, labels[status] || status); }
function notify(message) { el('notice').textContent = message; el('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { el('notice').hidden = true; }, 6000); }
function showSettings() { if (!el('access').open) el('access').showModal(); }
function errorText(text) {
  if (text.includes('Too many authentication attempts')) return '登录尝试过于频繁，请稍后重试。';
  if (text.includes('authentication')) return '模型认证失败，请检查 API Key。';
  if (text.includes('quota')) return '模型额度不足。';
  if (text.includes('rate_limit')) return '模型请求过于频繁，请稍后重试。';
  if (text.includes('timeout')) return '模型请求超时，可以继续此会话。';
  if (text.includes('disconnected')) return '模型连接中断，回复尚未完成。';
  if (text.includes('unsupported_protocol')) return '模型接口不支持这次请求。';
  return text;
}
async function api(path, options = {}) {
  const epoch = authEpoch;
  const headers = { ...options.headers };
  if (options.body && typeof options.body !== 'string') { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  const signal = options.signal ? AbortSignal.any([authController.signal, options.signal]) : authController.signal;
  const response = await fetch(new URL(path.slice(1), baseURL), { ...options, headers, signal });
  checkIdentity(epoch);
  if (!response.ok) { const body = await response.json().catch(() => ({})); checkIdentity(epoch); if (response.status === 401) { resetIdentity(); showSettings(); } throw new Error(errorText(body.error || `请求失败（${response.status}）`)); }
  return response;
}
function checkIdentity(epoch) { if (epoch !== authEpoch) throw new DOMException('登录状态已变化', 'AbortError'); }
async function json(path, options) { const epoch=authEpoch; const data=await (await api(path, options)).json(); checkIdentity(epoch); return data; }
function resetIdentity() {
  authEpoch++; authController.abort(); authController=new AbortController();
  connection=null; sessions=[]; currentFileContent=''; fileVersion++; busy=false; approvalBusy=false;
  el('current-user').textContent='未登录'; el('current-user').title=''; el('disconnect-button').hidden=true;
  el('model-settings').hidden=true; el('user-management').hidden=true; el('model-key').value='';
  el('token').value='';
  el('created-user-token').value=''; el('created-user').hidden=true; el('copy-user-token').replaceChildren();
  el('new-user-name').value=''; el('user-error').textContent=''; el('session-search').value='';
  el('user-list').replaceChildren();
  el('model-ready').textContent='待检查'; el('model-error').textContent=''; el('model-check-state').textContent='';
  el('server-state').textContent='尚未连接'; el('connection-dot').classList.remove('online');
  window.dispatchEvent(new Event('agent-continue:identity-reset')); newSession();
}
function active() { return current && ['running','queued','awaiting_approval'].includes(current.session.status); }
function availability() {
  el('send-message').disabled = busy || active() || !el('prompt').value.trim();
  el('new-session').disabled = busy;
  document.querySelectorAll('.session-item').forEach(button => { button.disabled = busy; });
  el('cancel-task').hidden = !active(); el('cancel-task').disabled = busy;
  el('model-mode').disabled = Boolean(current) || busy || connection?.user?.admin === false;
  el('export-session').disabled = !current;
  el('allow-approval').disabled = approvalBusy; el('deny-approval').disabled = approvalBusy;
  el('attach-files').disabled = busy || active() || current?.session.modelRef === 'demo';
  el('download-file').disabled = !current || !selectedFile;
  el('save-model').disabled = settingsBusy || !connection?.user?.admin;
}
function updateConnection(status) {
  connection = status;
  el('current-user').textContent=status.user.name; el('current-user').title=status.user.name;
  el('disconnect-button').hidden=false; el('model-settings').hidden=!status.user.admin;
  el('user-management').hidden=!status.user.admin || !status.multiUserEnabled;
  el('server-state').textContent = '服务在线'; el('connection-dot').classList.add('online');
  el('model-ready').textContent = status.modelReady ? status.model : '未配置 API Key'; el('model-ready').className = `badge ${status.modelReady ? 'success' : 'warning'}`;
  el('setting-model').value = status.model;
  if (!current) el('model-mode').value = status.provider;
  el('model-badge').textContent = status.model;
  el('welcome-model').textContent = status.provider === 'hyperion' ? `${status.model} · xhigh` : status.model;
  if (status.permissionMode === 'readonly') el('permission-label').textContent = '只读文件';
}
async function connect() {
  el('connect-button').disabled = true; el('connection-error').textContent = '';
  try {
    if (el('token').value) {
      const token=el('token').value; resetIdentity();
      await json('/api/disconnect', {method:'POST'});
      identityChannel.postMessage('changed');
      await json('/api/connect', { method: 'POST', body: { token } }); el('token').value = '';
      identityChannel.postMessage('changed');
      location.replace(location.pathname); return;
    }
    updateConnection(await json('/api/workbench'));
    if (el('access').open) el('access').close();
    await refreshSessions();
    await refreshUsers();
    const restoredSession = new URLSearchParams(location.hash.slice(1)).get('session');
    if (!current && restoredSession) await selectSession(restoredSession);
  } catch (error) { el('server-state').textContent = '尚未连接'; el('connection-dot').classList.remove('online'); el('connection-error').textContent = error.message; if (!connection) showSettings(); }
  finally { el('connect-button').disabled = false; availability(); }
}
async function refreshSessions() { sessions = (await json('/api/sessions')).sessions; renderSessions(); }
async function refreshUsers() {
  if(!connection?.user?.admin || !connection.multiUserEnabled)return;
  const result=await json('/api/users'); const list=el('user-list'); list.replaceChildren();
  for(const user of result.users){
    const row=node('div','user-entry'),revoke=node('button','icon-button');revoke.type='button';
    revoke.title=`撤销 ${user.name} 的访问`;revoke.setAttribute('aria-label',revoke.title);revoke.append(icon('user-x'));
    revoke.addEventListener('click',async()=>{
      if(!window.confirm(`撤销 ${user.name} 的访问？`))return;
      revoke.disabled=true;
      try{await json(`/api/users/${encodeURIComponent(user.id)}`,{method:'DELETE'});el('created-user-token').value='';el('created-user').hidden=true;el('copy-user-token').replaceChildren();await refreshUsers();notify('已撤销用户访问');}
      catch(error){if(error.name!=='AbortError')notify(error.message);revoke.disabled=false;}
    });
    row.append(node('span','',user.name),revoke);list.append(row);
  }
  icons();
}
function renderSessions() {
  const list = el('session-list'); list.replaceChildren(); const search = el('session-search').value.toLowerCase();
  for (const item of sessions.filter(item => item.title.toLowerCase().includes(search))) {
    const button = node('button', `session-item ${current?.session.id === item.session.id ? 'active' : ''}`); button.append(icon('message-square'));
    button.disabled = busy;
    const info = node('span', 'session-info'); info.append(node('strong', '', item.title), node('small', '', `${labels[item.session.status] || item.session.status} · ${new Date(item.session.updatedAt).toLocaleDateString('zh-CN', { month:'2-digit',day:'2-digit' })}`));
    button.append(info); button.addEventListener('click', () => selectSession(item.session.id).catch(error => notify(error.message))); list.append(button);
  }
  if (!list.children.length) list.append(node('p', 'muted', search ? '无匹配会话' : '尚无会话')); icons();
}
function workspaceView() { el('workspace-view').hidden = false; el('migration-view').hidden = true; }
function stopStream() { stream?.abort(); stream = null; clearTimeout(refreshTimer); partial = ''; el('stream-message').hidden = true; }
async function selectSession(id) {
  const version = ++navigation;
  stopStream(); const snap = await json(`/api/sessions/${encodeURIComponent(id)}`);
  if (version !== navigation) return;
  current = snap;
  eventCursor = 0; eventRows = []; selectedFile = ''; workspaceFiles = []; attachments = []; renderAttachments();
  history.replaceState(null, '', `${location.pathname}#session=${id}`);
  el('sidebar').classList.remove('open'); workspaceView(); render(); await loadFiles();
  if (version !== navigation) return;
  startStream(id); renderSessions();
}
function newSession() {
  navigation++;
  stopStream(); current = null; eventCursor = 0; eventRows = []; history.replaceState(null, '', location.pathname); el('sidebar').classList.remove('open');
  el('prompt').value = ''; el('model-mode').value = connection?.provider || 'hyperion'; attachments = []; workspaceFiles = []; selectedFile = ''; renderAttachments(); toggleReview(false); el('activity-list').replaceChildren(node('p','empty-state','暂无执行记录')); workspaceView(); render(); renderSessions(); el('prompt').focus();
}
async function send() {
  if (busy || active()) return;
  const prompt = el('prompt').value.trim(); if (!prompt) return;
  const mode = current?.session.modelRef || el('model-mode').value;
  if (mode !== 'demo' && (!connection?.modelReady || connection.provider !== mode)) { showSettings(); el('setting-model').value = mode === 'hyperion' ? 'gpt-6.1-sol' : 'deepseek-flash'; el('model-key').focus(); return; }
  busy = true; availability();
  try {
    const run = current ? await json(`/api/sessions/${current.session.id}/continue`, { method: 'POST', body: { prompt, files: attachments } }) : await json('/api/sessions', { method: 'POST', body: { prompt, mode, files: attachments } });
    el('prompt').value = ''; await selectSession(run.sessionId); await refreshSessions();
  } catch (error) { notify(error.message); } finally { busy = false; availability(); }
}
function render() {
  const openTools = new Set([...document.querySelectorAll('.tool-entry[open]')].map(e => e.dataset.call));
  const snap = current; el('welcome').hidden = Boolean(snap); el('messages').replaceChildren(); el('approval-panel').hidden = true;
  el('task-title').textContent = snap ? snap.title : '新对话'; el('task-status').replaceWith(Object.assign(badge(snap?.session.status || '就绪'), { id: 'task-status' }));
  el('workspace-name').textContent = snap?.session.workspace === 'pricing-demo' ? '演示工程' : workspaceFiles.length ? '代码文件' : '对话';
  el('model-badge').textContent = snap?.session.modelRef === 'demo' ? '固定演示' : snap?.session.modelRef === 'deepseek' ? 'DeepSeek' : connection?.model || 'gpt-6.1-sol'; el('workspace-id').textContent = snap ? snap.session.id.slice(0,8) : '—';
  el('tab-tests').hidden = snap?.session.modelRef !== 'demo';
  if (el('tab-tests').hidden && el('tab-tests').getAttribute('aria-selected') === 'true') el('tab-files').click();
  if (!snap) { el('file-list').replaceChildren(node('p','empty-state','暂无文件')); el('selected-file').textContent = '—'; el('file-content').textContent = ''; renderDiff('', ''); el('test-content').replaceChildren(); el('event-count').textContent = '0'; el('run-summary').textContent = ''; el('stream-state').textContent = connection?.modelReady ? '就绪' : '等待模型配置'; availability(); return; }
  el('model-mode').value = snap.session.modelRef;
  for (const message of snap.messages) {
    const item = node('article', `message ${message.role}`); const head = node('div','message-head'); head.append(icon(message.role === 'user' ? 'user-round' : 'terminal-square'), node('span','',message.role === 'user' ? '你' : snap.session.modelRef === 'demo' ? '演示模型' : 'Agent Continue')); item.append(head);
    const text = message.content.map(part => part.text).join(''); if (text) { const content = node('div','message-text'); if(message.role === 'assistant')renderText(content,text);else content.textContent=text; item.append(content); if (message.role === 'assistant') item.append(copyButton(text,'复制回复')); }
    for (const call of message.toolCalls || []) {
      const entry = snap.tools.find(e => e.call.id === call.id); const detail = node('details','tool-entry'); detail.dataset.call = call.id; detail.open = openTools.has(call.id);
      const summary = node('summary'); summary.append(icon(call.name === 'run_tests' ? 'flask-conical' : call.name === 'apply_patch' ? 'file-pen-line' : 'file-search'), node('span','',toolNames[call.name] || call.name), badge(entry?.call.status || 'proposed'));
      detail.append(summary); const output = entry?.result; detail.append(node('pre','', output ? [output.output,output.stderr,output.error,output.exitCode !== undefined ? `exit code: ${output.exitCode}` : ''].filter(Boolean).join('\n') : JSON.stringify(call.arguments,null,2))); item.append(detail);
    }
    el('messages').append(item);
  }
  const pending = snap.tools.find(t => t.approval?.status === 'pending');
  if (pending) { el('approval-panel').hidden = false; const patch = JSON.parse(pending.approval.summary); el('approval-path').textContent = patch.path; el('approval-diff').textContent = patch.content !== undefined ? `+ ${patch.content}` : `- ${patch.before}\n+ ${patch.after}`; }
  if (snap.error) el('messages').append(node('p','run-error',errorText(snap.error)));
  if (snap.partial && !active()) { const interrupted=node('div','message-text'); interrupted.append(node('small','muted','回复已中断\n'),node('div','',snap.partial)); el('messages').append(interrupted); }
  const run = snap.runs.at(-1); el('run-summary').textContent = `${run?.steps || 0} 步 · ${run?.toolsExecuted || 0} 次工具执行 · ${run?.modelRequests || 0} 次模型 HTTP 请求`;
  el('stream-state').textContent = active() ? '任务运行中' : labels[snap.session.status]; renderTests(); availability(); icons();
}
function renderTests() {
  const tests = current.tools.filter(t => t.call.name === 'run_tests' && t.result); const panel = el('test-content'); panel.replaceChildren();
  if (!tests.length) { panel.append(node('p','empty-state','暂无测试结果')); return; }
  const last = tests.at(-1).result; const passing = last.exitCode === 0;
  el('test-badge').textContent = passing ? '4 / 4 通过' : '未通过'; el('test-badge').className = `badge ${passing ? 'success' : 'error'}`;
  for (const [index,entry] of tests.entries()) { const group = node('div',`test-group ${entry.result.exitCode === 0 ? '' : 'failed'}`); const title = node('div','test-group-title',`第 ${index+1} 次运行`); title.append(badge(entry.result.status)); group.append(title,node('pre','',entry.result.stdout || entry.result.error || entry.result.output)); panel.append(group); }
}
async function loadFile() {
  const version = ++fileVersion; const id = current?.session.id; const name = selectedFile; if (!id || !name) return;
  const file = await json(`/api/sessions/${id}/file?path=${encodeURIComponent(name)}`);
  if (version !== fileVersion || current?.session.id !== id || selectedFile !== name) return;
  el('selected-file').textContent = selectedFile; el('file-content').textContent = file.content;
  currentFileContent = file.content; el('diff-file').textContent = selectedFile;
  document.querySelectorAll('[data-file]').forEach(button => button.classList.toggle('active', button.dataset.file === selectedFile));
  const before = current.baselines?.[selectedFile] ?? (selectedFile === 'pricing.json' ? current.baseline : '');
  renderDiff(before, file.content);
}
async function loadFiles() {
  const id = current?.session.id; if (!id) return;
  const result = await json(`/api/sessions/${id}/files`); if (current?.session.id !== id) return;
  workspaceFiles = result.files;
  const list = el('file-list'); list.replaceChildren();
  for (const name of workspaceFiles) { const button=node('button','file-row'); button.dataset.file=name; button.append(icon('file-code'),node('span','',name)); button.addEventListener('click',()=>{selectedFile=name;loadFile().catch(e=>notify(e.message));}); list.append(button); }
  if (!workspaceFiles.length) { list.append(node('p','empty-state','暂无文件')); selectedFile=''; el('selected-file').textContent='—'; el('file-content').textContent=''; renderDiff('',''); }
  else { if (!workspaceFiles.includes(selectedFile)) selectedFile=workspaceFiles[0]; await loadFile(); }
  availability(); icons();
}
function renderDiff(before,after) {
  const panel = el('diff-content'); panel.replaceChildren(); const changed = before !== after; el('diff-count').textContent = changed ? '1' : '0';
  el('diff-stat').textContent = changed ? '已修改' : '无改动'; if (!changed) { panel.append(node('p','empty-state','暂无任务修改')); return; }
  const oldLines = before.trimEnd().split('\n'), newLines = after.trimEnd().split('\n');
  if (oldLines.length*newLines.length>1000000) { panel.append(node('pre','diff-line removed',before),node('pre','diff-line added',after)); el('diff-stat').textContent='已修改'; return; }
  // LCS aligns the two actual file versions without inventing a patch preview.
  const table = Array.from({length:oldLines.length+1}, () => new Uint16Array(newLines.length+1));
  for (let i=oldLines.length-1;i>=0;i--) for(let j=newLines.length-1;j>=0;j--) table[i][j] = oldLines[i] === newLines[j] ? table[i+1][j+1]+1 : Math.max(table[i+1][j],table[i][j+1]);
  let i=0,j=0, added=0, removed=0;
  while(i<oldLines.length || j<newLines.length) {
    if(i<oldLines.length && j<newLines.length && oldLines[i]===newLines[j]) { panel.append(node('div','diff-line context',`  ${oldLines[i]}`)); i++;j++; }
    else if(i<oldLines.length && (j===newLines.length || table[i+1][j]>=table[i][j+1])) { panel.append(node('div','diff-line removed',`- ${oldLines[i++]}`)); removed++; }
    else { panel.append(node('div','diff-line added',`+ ${newLines[j++]}`)); added++; }
  }
  el('diff-stat').textContent = `+${added} −${removed}`;
}
const eventNames = { 'run.started':'任务开始', 'message.completed':'回复完成', 'tool.proposed':'工具已提出', 'tool.started':'工具开始', 'tool.completed':'工具结束', 'approval.requested':'等待修改审批', 'approval.resolved':'审批已处理', 'run.completed':'任务结束', 'run.failed':'任务失败', 'run.cancelled':'任务已取消' };
function addEvent(event) {
  eventCursor = event.sequence; el('event-count').textContent = String(eventCursor);
  if (event.type === 'message.delta') { const scroll=el('chat-scroll'), follow=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<120; partial += event.data.text || ''; el('stream-message').textContent = partial; el('stream-message').hidden = false; if(follow)scroll.scrollTop=scroll.scrollHeight; return; }
  if (event.type === 'message.completed' || event.type.startsWith('run.')) { partial=''; el('stream-message').hidden=true; }
  eventRows.push(event); if(eventRows.length>80) eventRows.shift(); const list=el('activity-list'); list.replaceChildren();
  for(const e of eventRows) { const row=node('div','activity-row'); const symbol=e.data.result?.status==='failed' || e.type==='run.failed' ? 'circle-x' : e.type.startsWith('approval.') ? 'shield-check' : 'circle-check'; row.append(icon(symbol), node('span','', `${eventNames[e.type] || e.type}${e.data.error ? ` · ${e.data.error}` : ''}`),node('time','',new Date(e.time).toLocaleTimeString('zh-CN',{hour12:false}))); list.append(row); } list.scrollTop=list.scrollHeight; icons();
  clearTimeout(refreshTimer); const id = current?.session.id; refreshTimer=setTimeout(() => refreshCurrent(id).catch(error=>notify(error.message)),60);
}
async function refreshCurrent(id) {
  if (!id || current?.session.id!==id) return;
  const snap = await json(`/api/sessions/${id}`); if (current?.session.id!==id || snap.sequence < current.sequence) return;
  const scroll=el('chat-scroll'), atBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<120;
  current=snap; render(); await loadFiles(); if(atBottom) scroll.scrollTop=scroll.scrollHeight; await refreshSessions();
}
async function startStream(id) {
  stream = new AbortController(); const controller=stream;
  while (!controller.signal.aborted && current?.session.id === id) {
    try {
      const response=await api(`/api/sessions/${id}/events?after=${eventCursor}`,{signal:controller.signal});
      el('stream-state').textContent='事件流已连接'; const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='';
      while(true) { const {value,done}=await reader.read(); if(done) break; buffer+=decoder.decode(value,{stream:true}); let split;
        while((split=buffer.indexOf('\n\n'))>=0) { const frame=buffer.slice(0,split); buffer=buffer.slice(split+2); const data=frame.split('\n').find(line=>line.startsWith('data: ')); if(data) { const event=JSON.parse(data.slice(6)); if(event.sequence>eventCursor && current?.session.id===id) addEvent(event); } }
      }
    } catch(error) { if(controller.signal.aborted) return; el('stream-state').textContent='连接中断，重连中'; if(el('access').open) return; }
    if(!controller.signal.aborted) await new Promise(resolve=>setTimeout(resolve,800));
  }
}
async function resolveApproval(allow) {
  const pending=current?.tools.find(t=>t.approval?.status==='pending'); if(!pending || approvalBusy) return;
  const p=pending.approval; approvalBusy=true; availability();
  try { await json(`/api/sessions/${p.sessionId}/approvals/${p.id}`,{method:'POST',body:{runId:p.runId,callId:p.callId,argumentsHash:p.argumentsHash,allow}}); await refreshCurrent(p.sessionId); }
  catch(error) { notify(error.message); } finally { approvalBusy=false; availability(); }
}
el('composer').addEventListener('submit',e=>{e.preventDefault();send();}); el('prompt').addEventListener('input',availability);
el('prompt').addEventListener('keydown',e=>{if(e.key==='Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing){e.preventDefault();send();}});
el('new-session').addEventListener('click',newSession);
el('refresh-sessions').addEventListener('click',()=>refreshSessions().catch(e=>notify(e.message))); el('session-search').addEventListener('input',renderSessions);
el('open-settings').addEventListener('click',showSettings); el('connect-button').addEventListener('click',connect);
el('disconnect-button').addEventListener('click',async()=>{resetIdentity();try{await json('/api/disconnect',{method:'POST'});identityChannel.postMessage('changed');location.replace(location.pathname);}catch(error){notify(error.message);showSettings();}});
el('token').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();connect();}});
el('user-management').addEventListener('submit',async event=>{
  event.preventDefault(); el('create-user').disabled=true; el('user-error').textContent='';
  el('created-user-token').value=''; el('created-user').hidden=true; el('copy-user-token').replaceChildren();
  try {const result=await json('/api/users',{method:'POST',body:{name:el('new-user-name').value}});el('created-user-name').textContent=`${result.user.name} · 访问码`;el('created-user-token').value=result.token;el('created-user').hidden=false;el('copy-user-token').append(copyButton(result.token,'复制用户访问码'));el('new-user-name').value='';await refreshUsers();icons();}
  catch(error){if(error.name!=='AbortError')el('user-error').textContent=error.message;}finally{el('create-user').disabled=false;}
});
el('allow-approval').addEventListener('click',()=>resolveApproval(true)); el('deny-approval').addEventListener('click',()=>resolveApproval(false));
el('cancel-task').addEventListener('click',async()=>{if(!current || busy)return;busy=true;availability();try{await json(`/api/sessions/${current.session.id}/cancel`,{method:'POST'});await refreshCurrent(current.session.id);}catch(e){notify(e.message);}finally{busy=false;availability();}});
el('export-session').addEventListener('click',async()=>{if(!current)return;const epoch=authEpoch,id=current.session.id;try{const response=await api(`/api/sessions/${id}/export`);const blob=await response.blob();checkIdentity(epoch);const url=URL.createObjectURL(blob);const a=node('a');a.href=url;a.download=`session-${id.slice(0,8)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){if(e.name!=='AbortError')notify(e.message);}});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-tab]').forEach(b=>{b.setAttribute('aria-selected',String(b===button));el(`panel-${b.dataset.tab}`).hidden=b!==button;});}));
function toggleReview(open) { el('workspace-view').classList.toggle('review-open',open); el('review-pane').classList.toggle('open',open); }
el('open-review').addEventListener('click',()=>toggleReview(!el('review-pane').classList.contains('open'))); el('close-review').addEventListener('click',()=>toggleReview(false));
el('menu-button').addEventListener('click',()=>el('sidebar').classList.toggle('open'));
el('open-migration').addEventListener('click',()=>{el('workspace-view').hidden=true;el('migration-view').hidden=false;el('sidebar').classList.remove('open');}); el('close-migration').addEventListener('click',workspaceView);
document.addEventListener('keydown',e=>{if(e.key==='Escape'){el('sidebar').classList.remove('open');toggleReview(false);}});
function copyButton(text,label) { const button=node('button','icon-button copy-button'); button.title=label; button.setAttribute('aria-label',label); button.append(icon('copy')); button.addEventListener('click',async()=>{ try { if(navigator.clipboard){await navigator.clipboard.writeText(text);}else{const area=node('textarea','clipboard-text',text);document.body.append(area);area.select();if(!document.execCommand('copy'))throw new Error();area.remove();} notify('已复制'); }catch{notify('复制失败');} }); return button; }
function renderText(container,text) {
  if(!window.marked || !window.DOMPurify){container.textContent=text;return;}
  container.classList.add('markdown');
  const fragment=window.DOMPurify.sanitize(window.marked.parse(text,{gfm:true,breaks:true}),{RETURN_DOM_FRAGMENT:true,USE_PROFILES:{html:true},FORBID_TAGS:['img','video','audio','iframe','form','input','button','style','script'],FORBID_ATTR:['style','id','name']});
  container.append(fragment);
  for(const code of container.querySelectorAll('pre>code')){const pre=code.parentElement,block=node('div','code-block'),head=node('div','code-block-head',(code.className.match(/language-([^ ]+)/)||[])[1]||'');head.append(copyButton(code.textContent,'复制代码'));pre.replaceWith(block);block.append(head,pre);}
  for(const table of container.querySelectorAll('table')){const wrap=node('div','table-scroll');table.replaceWith(wrap);wrap.append(table);}
  for(const link of container.querySelectorAll('a')){link.rel='noreferrer noopener';link.target='_blank';}
}
function renderAttachments() {
  const panel=el('attachments'); panel.replaceChildren(); panel.hidden=!attachments.length;
  for(const file of attachments){const chip=node('span','attachment');const remove=node('button','icon-button');remove.type='button';remove.title=`移除 ${file.path}`;remove.setAttribute('aria-label',remove.title);remove.append(icon('x'));remove.addEventListener('click',()=>{attachments=attachments.filter(f=>f!==file);renderAttachments();});chip.append(icon('file-code'),node('span','',file.path),remove);panel.append(chip);} icons();
}
el('attach-files').addEventListener('click',()=>el('code-files').click());
el('code-files').addEventListener('change',async()=>{
  const epoch=authEpoch;
  try {
    const added=[];const decoder=new TextDecoder('utf-8',{fatal:true});
    for(const file of el('code-files').files){if(file.size>65536)throw new Error('单个文件最大 64 KiB');const content=decoder.decode(await file.arrayBuffer());if(content.includes('\0'))throw new Error('请选择文本或代码文件');added.push({path:file.name,content});}
    checkIdentity(epoch);const next=[...attachments,...added];if(next.length>32 || next.reduce((n,f)=>n+new TextEncoder().encode(f.content).length,0)>524288)throw new Error('最多 32 个文件，总大小 512 KiB');if(new Set(next.map(f=>f.path.toLowerCase())).size!==next.length)throw new Error('文件名重复');attachments=next;renderAttachments();
  }catch(error){notify(error.message);}finally{el('code-files').value='';}
});
el('download-file').addEventListener('click',()=>{if(!selectedFile)return;const url=URL.createObjectURL(new Blob([currentFileContent],{type:'text/plain;charset=utf-8'}));const link=node('a');link.href=url;link.download=selectedFile.split('/').at(-1);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
el('save-model').addEventListener('click',async()=>{
  if(settingsBusy)return;settingsBusy=true;availability();el('model-error').textContent='';el('model-check-state').textContent='正在验证模型…';
  try {await json('/api/model',{method:'PUT',body:{model:el('setting-model').value,apiKey:el('model-key').value}});el('model-key').value='';updateConnection(await json('/api/workbench'));await json('/api/model/check',{method:'POST'});el('model-check-state').textContent='模型连接成功';notify('模型连接成功');el('access').close();render();}
  catch(error){el('model-error').textContent=error.message;el('model-check-state').textContent='';}finally{el('model-key').value='';settingsBusy=false;availability();}
});
el('model-mode').addEventListener('change',()=>{if(el('model-mode').value!==connection?.provider){showSettings();el('setting-model').value=el('model-mode').value==='hyperion'?'gpt-6.1-sol':'deepseek-flash';}});
document.querySelectorAll('[data-prompt]').forEach(button=>button.addEventListener('click',()=>{el('prompt').value=button.dataset.prompt;el('prompt').focus();availability();}));
window.addEventListener('hashchange',()=>{const id=new URLSearchParams(location.hash.slice(1)).get('session');if(id && id!==current?.session.id)selectSession(id).catch(error=>notify(error.message));else if(!id && current)newSession();});
window.addEventListener('pageshow',event=>{if(event.persisted){resetIdentity();location.replace(location.pathname);}});
icons(); window.addEventListener('load',icons); availability(); connect();
