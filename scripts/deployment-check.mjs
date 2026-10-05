import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const url=process.env.WORKBENCH_URL || 'http://127.0.0.1:8080/';
const target = new URL(url);
assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname), 'HTTPS is required outside loopback');
assert.ok(!target.username && !target.password && !target.search && !target.hash, 'Use a URL without credentials, query or fragment');
const access=await readFile(process.env.ACCESS_FILE,'utf8');
const token=access.match(/^AGENT_CONTINUE_TOKEN=(.+)$/m)?.[1]?.trim();
assert.ok(token);
async function request(relative) {
  const response=await fetch(new URL(relative,url),{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200); return response.json();
}
const mode=process.argv[2];
const file=process.argv[3] || '.agent-continue/evidence/web-demo-server/persistence.json';
if(mode==='snapshot') {
  const sessions=(await request('api/sessions')).sessions;
  let selected, filename;
  for(const session of sessions.filter(s=>s.session.status==='completed')){const files=(await request(`api/sessions/${session.session.id}/files`)).files;if(files.length){selected=session;filename=files[0];break;}}
  assert.ok(selected);
  const id=selected.session.id, snapshot=await request(`api/sessions/${id}`), content=await request(`api/sessions/${id}/file?path=${encodeURIComponent(filename)}`), model=await request('api/workbench');
  await writeFile(file,JSON.stringify({id,filename,status:snapshot.session.status,sequence:snapshot.sequence,messages:snapshot.messages.length,runs:snapshot.runs.length,fileSha256:createHash('sha256').update(content.content).digest('hex'),model:model.model,modelReady:model.modelReady},null,2));
  console.log('Recorded a completed session and actual workspace hash.');
} else if(mode==='verify') {
  const before=JSON.parse(await readFile(file,'utf8'));
  const snapshot=await request(`api/sessions/${before.id}`), content=await request(`api/sessions/${before.id}/file?path=${encodeURIComponent(before.filename || 'pricing.json')}`),model=await request('api/workbench');
  assert.equal(snapshot.session.status,before.status); assert.equal(snapshot.sequence,before.sequence); assert.equal(snapshot.messages.length,before.messages); assert.equal(snapshot.runs.length,before.runs); assert.equal(createHash('sha256').update(content.content).digest('hex'),before.fileSha256);
  if(before.model){assert.equal(model.model,before.model);assert.equal(model.modelReady,before.modelReady);}
  console.log('PASS: service restart preserved session, event cursor, messages, runs and workspace file.');
} else { throw new Error('Use snapshot or verify'); }
