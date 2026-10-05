/* Legacy migration flow, isolated as a browser module. */
'use strict';
const el = id => document.getElementById(id);
const baseURL = new URL('./', location.href);
let file = null, report = null, artifact = null, busy = false;
let identityEpoch=0, identityAbort=new AbortController();
window.addEventListener('agent-continue:identity-reset',()=>{
 identityEpoch++;identityAbort.abort();identityAbort=new AbortController();file=null;busy=false;clearResult();
 el('file').value='';el('file-name').textContent='选择会话文件';el('file-meta').textContent='JSONL / ZSTD · 最大 16 MiB';
 for(const id of ['cwd','cliVersion','modelProvider','model','title','home'])el(id).value='';
 for(const id of ['raw','sha','install-command','record-count','pending-count','loss-count'])el(id).textContent='';
 el('losses').replaceChildren();el('pending').replaceChildren();availability();status('尚未选择文件');
});
function status(message, error = false) { el('status').textContent = message; el('status').className = error ? 'error' : ''; }
function availability() { for (const id of ['inspect', 'plan', 'convert']) el(id).disabled = busy || !file; el('demo').disabled = busy; }
function clearResult() { report = null; artifact = null; el('report').hidden = true; el('empty-report').hidden = false; el('download-panel').hidden = true; el('report-status').textContent = '等待检查'; }
function selectFile(next) {
 if (!next) return;
 if (next.size > 16 * 1024 * 1024) { status('网页上传上限为 16 MiB，更大文件请使用本地 CLI。', true); return; }
 file = next; clearResult(); el('file-name').textContent = next.name; el('file-meta').textContent = `${(next.size / 1024).toFixed(1)} KiB · 已选择`;
 if (next.name.endsWith('.zstd')) { el('from').value = 'dsh'; direction(); }
 availability(); status('文件已准备好。先检查内容，或预览转换结果。');
}
function direction() { const reverse = el('from').value === 'dsh'; el('codex-options').hidden = !reverse; el('target-badge').textContent = reverse ? 'Codex' : 'DeepSeek Harness'; }
el('from').addEventListener('change', () => { direction(); clearResult(); });
el('file').addEventListener('change', e => selectFile(e.target.files[0]));
for (const type of ['dragenter','dragover']) el('drop').addEventListener(type, e => { e.preventDefault(); el('drop').classList.add('drag'); });
for (const type of ['dragleave','drop']) el('drop').addEventListener(type, e => { e.preventDefault(); el('drop').classList.remove('drag'); });
el('drop').addEventListener('drop', e => selectFile(e.dataTransfer.files[0]));
async function checkedFetch(url, options = {}) {
 const epoch=identityEpoch;
 const response = await fetch(new URL(url.slice(1), baseURL), { ...options, signal:identityAbort.signal });
 if(epoch!==identityEpoch)throw new DOMException('登录状态已变化','AbortError');
 if (!response.ok) { if (response.status === 401 && !el('access').open) el('access').showModal(); const body = await response.json().catch(() => ({})); throw new Error(body.error || `请求失败（${response.status}）`); }
 return response;
}
el('demo').addEventListener('click', async () => {
 const epoch=identityEpoch;
 busy = true; availability(); status('正在准备合成示例…');
 try { const response = await checkedFetch('/api/demo');const blob=await response.blob();if(epoch!==identityEpoch)return; el('from').value = 'codex'; direction(); el('cwd').value = '/demo/project'; selectFile(new File([blob], 'demo-rollout.jsonl', { type: 'application/x-ndjson' })); }
 catch (error) { if(epoch===identityEpoch)status(error.message, true); } finally { if(epoch===identityEpoch){busy = false; availability();} }
});
function showList(id, values, empty) { const list = el(id); list.replaceChildren(); for (const value of values.length ? values : [empty]) { const item = document.createElement('li'); item.textContent = value; list.append(item); } }
function showReport(value) {
 report = value; el('empty-report').hidden = true; el('report').hidden = false;
 el('report-status').textContent = value.status === 'converted' ? '转换完成' : value.status === 'planned' ? '预览完成' : '检查完成';
 el('record-count').textContent = value.source.records; const pending = value.pendingOperations || []; el('pending-count').textContent = pending.length;
 const losses = value.losses || []; el('loss-count').textContent = losses.length; showList('losses', losses, value.command === 'inspect' ? '预览转换后显示损失信息。' : '本次没有记录到转换损失。');
 showList('pending', pending.map(item => `${item.name} · ${item.callId}（结果未知）`), '没有发现结果未知的工具调用。');
 el('raw').textContent = JSON.stringify(value, null, 2);
}
async function request(action) {
 const epoch=identityEpoch;
 if (!file || busy) return;
 if (action !== 'inspect' && !el('cwd').value.trim()) { status('请填写目标工程的绝对路径。', true); el('cwd').focus(); return; }
 if (action !== 'inspect' && el('from').value === 'dsh' && (!el('cliVersion').value.trim() || !el('modelProvider').value.trim())) { status('迁往 Codex 时，请填写 CLI 版本和模型提供方。', true); return; }
 busy = true; availability(); artifact = null; el('download-panel').hidden = true; status(action === 'inspect' ? '正在检查会话…' : '正在转换并核对会话…');
 const body = new FormData(); body.append('file', file); body.append('from', el('from').value);
 if (action !== 'inspect') { body.append('cwd', el('cwd').value.trim()); if (el('from').value === 'dsh') for (const id of ['cliVersion','modelProvider','model','title']) if (el(id).value.trim()) body.append(id, el(id).value.trim()); }
 try {
  const response = await checkedFetch(`/api/${action}`, { method: 'POST', body }); const result = await response.json();if(epoch!==identityEpoch)return; showReport(result.report);
  if (result.artifact) { artifact = result.artifact; el('download-panel').hidden = false; el('sha').textContent = artifact.sha256; updateCommand(); }
  status(action === 'convert' ? '转换完成。请下载产物和报告，并在目标机器导入。' : action === 'plan' ? '预览完成。确认报告后，可生成转换产物。' : '检查完成。填写目标目录后可预览转换。');
 } catch (error) { if(epoch===identityEpoch){clearResult(); el('report-status').textContent = '需要处理'; status(error.message, true);} }
 finally { if(epoch===identityEpoch){busy = false; availability();} }
}
for (const action of ['inspect', 'plan', 'convert']) el(action).addEventListener('click', () => request(action));
function download(blob, name) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 15000); }
el('report-download').addEventListener('click', () => { if (report) download(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), 'migration-report.json'); });
el('artifact-download').addEventListener('click', () => { if (!artifact) return; const bytes = Uint8Array.from(atob(artifact.data), char => char.charCodeAt(0)); download(new Blob([bytes], { type: 'application/octet-stream' }), artifact.name); });
// Single-quoted paths are literal in PowerShell and POSIX shells; escape per shell.
function quote(value, windows) { return windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`; }
function updateCommand() { if (!artifact) return; const windows = /^[a-zA-Z]:[\\/]|^\\\\/.test(artifact.cwd); const q = value => quote(value, windows); const home = el('home').value.trim() || '<目标工具 home 的绝对路径>'; const extra = artifact.harness === 'codex' ? `${artifact.model ? ` --model ${q(artifact.model)}` : ''}${artifact.title ? ` --title ${q(artifact.title)}` : ''}` : ''; el('install-command').textContent = `${windows ? '.\\agent-continue.exe' : './agent-continue'} install --from ${artifact.harness} --input ${q(artifact.name)} --cwd ${q(artifact.cwd)} --target-home ${q(home)}${extra} --dry-run`; }
el('home').addEventListener('input', updateCommand);
direction(); availability();
