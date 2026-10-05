// Isolated local regression only; this script never accepts production credentials.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.WORKBENCH_URL || 'http://127.0.0.1:8096/';
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Run only against an isolated loopback server');
const token = 'synthetic-security-local-access-token';
const output = path.resolve('.agent-continue/evidence/security-browser');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
const errors = [], external = [];

async function pageFor(context, accessToken) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== target.origin) external.push(new URL(request.url()).origin); });
  await page.goto(url);
  await page.locator('#access').waitFor({ state: 'visible' });
  await page.locator('#token').fill(accessToken);
  await page.locator('#connect-button').click();
  await page.locator('#access').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('server-state').textContent === '服务在线');
  assert.equal(await page.locator('#token').inputValue(), '');
  return page;
}

async function request(page, route, method = 'GET', data) {
  return page.evaluate(async ({ route, method, data }) => {
    const response = await fetch(new URL(route, location.href), { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }, { route, method, data });
}

async function noOverflow(page) {
  const result = await page.evaluate(() => ({ width: innerWidth, actual: document.documentElement.scrollWidth, dialogWidth: document.getElementById('access').clientWidth, dialogContent: document.getElementById('access').scrollWidth }));
  assert.ok(result.actual <= result.width + 1, 'Page overflows horizontally');
  assert.ok(result.dialogContent <= result.dialogWidth + 1, 'Settings overflow horizontally');
}

try {
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const admin = await pageFor(adminContext, token);
  await admin.locator('#open-settings').click();
  const runID = Date.now().toString(36);
  const aliceName = `${runID} <img src=x onerror=alert(1)>`;
  const bobName = `Synthetic Bob ${runID}`;
  const credentials = [];
  for (const name of [aliceName, bobName]) {
    await admin.locator('#new-user-name').fill(name);
    await admin.locator('#create-user').click();
    await admin.locator('#created-user').waitFor({ state: 'visible' });
    await admin.locator('#user-list .user-entry').filter({ hasText: name }).waitFor();
    const value = await admin.locator('#created-user-token').inputValue();
    assert.match(value, /^[a-f0-9]{64}$/);
    credentials.push(value);
  }
  assert.equal(await admin.locator('#user-list img').count(), 0);
  await admin.locator('#user-list').scrollIntoViewIfNeeded();
  await noOverflow(admin);
  await admin.screenshot({ path: path.join(output, 'desktop-users.png'), fullPage: true });
  await admin.setViewportSize({ width: 390, height: 844 });
  await noOverflow(admin);
  await admin.screenshot({ path: path.join(output, 'mobile-users.png'), fullPage: true });
  await admin.setViewportSize({ width: 1440, height: 960 });

  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const alice = await pageFor(aliceContext, credentials[0]);
  const bob = await pageFor(bobContext, credentials[1]);
  const started = await request(alice, 'api/sessions', 'POST', { prompt: 'Synthetic private conversation', mode: 'demo' });
  assert.equal(started.status, 201);
  const id = started.data.sessionId;
  for (const suffix of ['', '/export', '/file?path=pricing.json', '/events']) {
    assert.equal((await request(bob, `api/sessions/${id}${suffix}`)).status, 404, 'Foreign session access must fail');
  }
  assert.equal((await request(bob, 'api/users')).status, 403);
  const payload = '<img src="https://attacker.invalid/key" onerror="window.__xss=1"><svg onload="window.__xss=1"></svg><math><mi href="javascript:window.__xss=1">x</mi></math><a id="connection" name="fetch" href="javascript:window.__xss=1">unsafe</a><script>window.__xss=1</script>\n\n**Synthetic markdown**';
  await alice.route(`**/api/sessions/${id}`, async route => {
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const snapshot = await response.json();
    snapshot.messages.push({ id: 'synthetic-xss', role: 'assistant', content: [{ type: 'text', text: payload }] });
    await route.fulfill({ response, json: snapshot });
  });
  await alice.goto(`${url}#session=${id}`);
  await alice.locator('.message.assistant strong').filter({ hasText: 'Synthetic markdown' }).first().waitFor();
  assert.equal(await alice.locator('.message-text img,.message-text svg,.message-text math,.message-text script,.message-text iframe').count(), 0);
  assert.equal(await alice.evaluate(() => window.__xss), undefined);
  assert.equal(await alice.locator('.message-text [id],.message-text [name],.message-text a[href^="javascript:"]').count(), 0);
  await alice.screenshot({ path: path.join(output, 'sanitized-conversation.png'), fullPage: true });

  const users = (await request(admin, 'api/users')).data.users;
  const aliceID = users.find(user => user.name === aliceName).id;
  admin.once('dialog', dialog => dialog.accept());
  await admin.locator('#user-list .user-entry').filter({ hasText: aliceName }).locator('button').click();
  await admin.locator('#user-list .user-entry').filter({ hasText: aliceName }).waitFor({ state: 'detached' });
  assert.equal((await request(alice, `api/sessions/${id}/export`)).status, 401, 'Revoked browser still accesses history');
  assert.equal((await request(bob, 'api/workbench')).status, 200);
  const cookies = await bobContext.cookies();
  const captured = cookies.find(cookie => cookie.name === 'agent_continue_session').value;
  if (!await bob.locator('#disconnect-button').isVisible()) await bob.locator('#menu-button').click();
  await bob.locator('#disconnect-button').click();
  await bob.locator('#access').waitFor({ state: 'visible' });
  const replay = await bobContext.request.get(new URL('api/workbench', url).href, { headers: { Cookie: `agent_continue_session=${captured}` } });
  assert.equal(replay.status(), 401, 'Logged-out cookie can be replayed');
  assert.equal(await bob.locator('#session-list .session-item').count(), 0);
  assert.equal(await bob.locator('#model-key').inputValue(), '');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('PASS: user management, cross-user denial, XSS sanitization, revocation, logout replay, and desktop/mobile layout. Synthetic data only.');
} finally {
  await browser.close();
}
