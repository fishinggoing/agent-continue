// Development verification only. The deployed application has no Node dependency.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.WORKBENCH_URL || 'http://127.0.0.1:8098/';
const target = new URL(url);
assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname), 'HTTPS is required outside loopback');
assert.ok(!target.username && !target.password && !target.search && !target.hash, 'Use a URL without credentials, query or fragment');
const output = path.resolve(process.env.EVIDENCE_DIR || '.agent-continue/evidence/real-chat');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
const errors = [];
const evidence = {};
async function authenticate(page) {
  if (!process.env.ACCESS_FILE) return;
  assert.equal(new URL(page.url()).origin, target.origin, 'Refusing to enter a token after an origin-changing redirect');
  const file = await readFile(process.env.ACCESS_FILE, 'utf8');
  const token = file.match(/^AGENT_CONTINUE_TOKEN=(.+)$/m)?.[1]?.trim();
  assert.ok(token, 'Access file must contain a private token');
  await page.locator('#token').fill(token);
  await page.locator('#connect-button').click();
  await page.locator('#access').waitFor({ state:'hidden' });
}
async function noOverflow(page) {
  const result = await page.evaluate(() => {const composer=document.getElementById('composer').getBoundingClientRect();return { viewport:innerWidth, width:document.documentElement.scrollWidth,height:innerHeight,pageHeight:document.documentElement.scrollHeight,composerBottom:composer.bottom,icons:document.querySelectorAll('svg.lucide').length };});
  assert.ok(result.width<=result.viewport+1, JSON.stringify(result));
  assert.ok(result.pageHeight<=result.height+1 && result.composerBottom<=result.height+1,JSON.stringify(result));
  assert.ok(result.icons>10, 'Lucide assets did not render');
  return result;
}
async function send(page,prompt) {
  await page.locator('#prompt').fill(prompt);
  const response=page.waitForResponse(r => /\/api\/sessions(?:\/[^/]+\/continue)?$/.test(r.url()) && [201,202].includes(r.status()));
  await page.locator('#send-message').click();
  await response;
  await page.locator('.message.user .message-text').filter({hasText:prompt}).last().waitFor();
}
async function completed(page) {
  await page.locator('#task-status').filter({hasText:'已完成'}).waitFor({timeout:180000});
}
try {
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url); await authenticate(page);
  await page.getByText('服务在线',{exact:true}).waitFor();
  assert.equal(await page.locator('#model-mode').inputValue(),'hyperion');
  assert.equal(await page.locator('#prompt').inputValue(),'');
  evidence.desktop=await noOverflow(page);
  await page.screenshot({path:path.join(output,'desktop-initial.png'),fullPage:true});
  await send(page,'请记住我的演示代号是 AC-4827。只回复：记住了。');
  await completed(page);
  const chatHash=await page.evaluate(()=>location.hash);
  evidence.chatSession=chatHash;
  assert.ok((await page.locator('.message.assistant').last().textContent()).includes('记住'));
  await send(page,'我的演示代号是什么？只回复代号。');
  await completed(page);
  assert.ok((await page.locator('.message.assistant').last().textContent()).includes('AC-4827'));
  assert.equal(await page.locator('.message.user').count(),2);
  await page.reload(); await page.locator('.message.user').nth(1).waitFor();
  assert.equal(await page.evaluate(()=>location.hash),chatHash);
  await page.screenshot({path:path.join(output,'desktop-conversation.png'),fullPage:true});
  await page.locator('#new-session').click();
  await page.locator('#code-files').setInputFiles({name:'calc.py',mimeType:'text/x-python',buffer:Buffer.from('# Keep this user comment\ndef add(a, b):\n    return a - b\n')});
  await page.locator('.attachment').waitFor();
  await send(page,'请读取 calc.py 并将 add 函数修复为两数相加。务必使用文件工具修改，保留注释，不要运行测试。');
  await page.locator('#approval-panel').waitFor({state:'visible',timeout:180000});
  assert.equal(await page.locator('#approval-path').textContent(),'calc.py');
  evidence.codeSession=await page.evaluate(()=>location.hash);
  await page.locator('#open-review').click();
  await page.locator('#file-content').filter({hasText:'a - b'}).waitFor();
  await page.screenshot({path:path.join(output,'desktop-approval.png'),fullPage:true});
  await page.reload(); await page.locator('#approval-panel').waitFor({state:'visible'});
  await page.locator('#allow-approval').click(); await completed(page);
  await page.locator('#open-review').click();
  await page.locator('#file-content').filter({hasText:'a + b'}).waitFor();
  assert.ok((await page.locator('#file-content').textContent()).includes('Keep this user comment'));
  const downloaded=page.waitForEvent('download'); await page.locator('#download-file').click();
  assert.equal((await downloaded).suggestedFilename(),'calc.py');
  await page.locator('#tab-diff').click(); await page.locator('.diff-line.added').waitFor();
  evidence.desktopAfterCode=await noOverflow(page);
  await page.screenshot({path:path.join(output,'desktop-code-diff.png'),fullPage:true});
  const mobile=await browser.newPage({viewport:{width:390,height:844}});
  mobile.on('pageerror',error=>errors.push(error.message));
  await mobile.goto(url); await authenticate(mobile); await mobile.waitForFunction(()=>document.getElementById('server-state').textContent==='服务在线');
  evidence.mobile=await noOverflow(mobile); await mobile.screenshot({path:path.join(output,'mobile-initial.png'),fullPage:true});
  await mobile.goto(url+evidence.codeSession); await mobile.locator('.message.user').waitFor();
  await mobile.locator('#open-review').click(); await mobile.locator('#tab-diff').click(); await mobile.locator('.diff-line.added').waitFor();
  evidence.mobileReview=await noOverflow(mobile); await mobile.screenshot({path:path.join(output,'mobile-code-diff.png'),fullPage:true});
  await page.locator('#new-session').click();
  await send(page,'请详细解释快速排序的实现过程、复杂度及各种边界情况。');
  await page.locator('#cancel-task').waitFor({state:'visible'}); await page.locator('#cancel-task').click();
  await page.locator('#task-status').filter({hasText:'已取消'}).waitFor();
  await page.reload(); await page.locator('#task-status').filter({hasText:'已取消'}).waitFor();
  evidence.cancelSession=await page.evaluate(()=>location.hash);
  await page.locator('#open-migration').click(); await page.locator('#demo').click(); await page.locator('#convert').click(); await page.locator('#artifact-download').waitFor({state:'visible'});
  evidence.flow=['real-chat','multi-turn-context','refresh-history','uploaded-code','approval-refresh','real-file-patch','file-download','actual-diff','mobile-review','cancel-model','migration-convert'];
  assert.deepEqual(errors,[]); evidence.browserErrors=errors;
  await writeFile(path.join(output,'result.json'),JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence,null,2));
} finally { await browser.close(); }
