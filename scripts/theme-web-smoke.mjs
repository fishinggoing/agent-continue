// Isolated local regression only; all conversations and credentials are synthetic.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.WORKBENCH_URL || 'http://127.0.0.1:8096/';
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Use an isolated loopback server');
const token = 'synthetic-security-local-access-token';
const output = path.resolve('.agent-continue/evidence/theme-browser');
const storageKey = `agent-continue-theme:${new URL('./', target).pathname}`;
const viewports = [
  { width: 1440, height: 960 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
];
const errors = [], external = [], metrics = [];
let demoPage, demoID, demoCompleted = false;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });

async function observedPage(context) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const requestURL = new URL(route.request().url());
    if (['http:', 'https:'].includes(requestURL.protocol) && requestURL.origin !== target.origin) {
      external.push(requestURL.origin);
      return route.abort();
    }
    return route.continue();
  });
  return page;
}

async function pageFor(context) {
  const page = await observedPage(context);
  await page.goto(url);
  await page.locator('#access').waitFor({ state: 'visible' });
  await page.locator('#token').fill(token);
  await page.locator('#connect-button').click();
  await page.locator('#access').waitFor({ state: 'hidden' });
  await ready(page);
  assert.equal(await page.locator('#token').inputValue(), '');
  return page;
}

async function ready(page) {
  await page.waitForFunction(() => document.getElementById('server-state').textContent === '\u670d\u52a1\u5728\u7ebf');
  await page.locator('#toggle-theme').waitFor({ state: 'visible' });
}

async function theme(page, expected, keyboard) {
  if (await page.locator('html').getAttribute('data-theme') !== expected) {
    if (keyboard) {
      await page.locator('#toggle-theme').focus();
      await page.keyboard.press(keyboard);
    } else {
      await page.locator('#toggle-theme').click();
    }
  }
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, expected);
  const button = page.locator('#toggle-theme');
  assert.ok(await button.getAttribute('aria-label'), 'Theme control needs an accessible name');
  assert.ok(await button.getAttribute('title'), 'Theme control needs a tooltip');
}

async function geometry(page, state) {
  const measured = await page.evaluate(() => {
    const shown = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const selectors = ['.topbar', '#composer', '.composer-toolbar', '#chat-scroll', '#access', '#sidebar', '#review-pane', '#review-pane .workspace-foot', '.approval-panel', '.approval-panel .approval-actions', '.approval-panel #deny-approval', '.approval-panel #allow-approval', '.migration-head', '.migration-grid'];
    const containers = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(shown).map(element => {
      const rect = element.getBoundingClientRect();
      const overflowing = [...element.querySelectorAll('*')].filter(shown).filter(child => child.getBoundingClientRect().right > rect.right + 1 || child.scrollWidth > child.clientWidth + 1).map(child => child.id || child.className || child.tagName);
      const parentRect = (selector.startsWith('.approval-panel ') ? element.closest('.approval-panel') : element.parentElement).getBoundingClientRect();
      return { selector, width: element.clientWidth, contentWidth: element.scrollWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, parentTop: parentRect.top, parentBottom: parentRect.bottom, overflowing: overflowing.slice(0, 8) };
    }));
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, containers };
  });
  metrics.push({ state, theme: await page.locator('html').getAttribute('data-theme'), ...measured });
  assert.ok(measured.documentWidth <= measured.width + 1, `${state}: document overflows horizontally (${measured.documentWidth}/${measured.width})`);
  assert.ok(measured.documentHeight <= measured.height + 1, `${state}: document overflows vertically (${measured.documentHeight}/${measured.height})`);
  for (const box of measured.containers) {
    assert.ok(box.contentWidth <= box.width + 1, `${state}: ${box.selector} overflows horizontally (${box.contentWidth}/${box.width}); ${box.overflowing.join(', ')}`);
    assert.ok(box.left >= -1 && box.right <= measured.width + 1, `${state}: ${box.selector} leaves the viewport`);
    if (['#composer', '.composer-toolbar', '#review-pane', '#review-pane .workspace-foot', '.approval-panel'].includes(box.selector)) {
      assert.ok(box.top >= -1 && box.bottom <= measured.height + 1, `${state}: ${box.selector} leaves the viewport vertically (${box.top}/${box.bottom}; height ${measured.height})`);
    }
    if (box.selector.startsWith('.approval-panel ')) {
      assert.ok(box.top >= box.parentTop - 1 && box.bottom <= box.parentBottom + 1, `${state}: ${box.selector} is clipped by its panel (${box.top}/${box.bottom}; panel ${box.parentTop}/${box.parentBottom})`);
    }
  }
}

async function screenshot(page, state) {
  const size = page.viewportSize();
  await page.screenshot({ path: path.join(output, `${state}-${size.width}x${size.height}.png`) });
  await geometry(page, state);
}

async function sidebarCommand(page, id) {
  if (!await page.locator(`#${id}`).isVisible()) await page.locator('#menu-button').click();
  await page.locator(`#${id}`).click();
}

async function request(page, route, data) {
  return page.evaluate(async ({ route, data }) => {
    const response = await fetch(new URL(route, new URL('./', location.href)), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  }, { route, data });
}

try {
  const context = await browser.newContext({ viewport: viewports[0] });
  const page = await pageFor(context);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'A new browser starts in dark theme');
  const darkBackground = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor);
  await theme(page, 'light', 'Enter');
  assert.notEqual(await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), darkBackground, 'Theme changes the rendered background');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), 'light');
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Light theme survives reload');
  await theme(page, 'dark', 'Space');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), 'dark');
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'Dark theme survives reload');

  for (const size of viewports) {
    await page.setViewportSize(size);
    for (const value of ['dark', 'light']) {
      await theme(page, value);
      await screenshot(page, `welcome-${value}`);
    }
    const prompt = `SyntheticLongPrompt_${'no_real_conversation_or_secret_'.repeat(90)}`;
    await page.locator('#prompt').fill(prompt);
    await screenshot(page, 'long-prompt');
    await page.locator('#prompt').fill('');
    if (size.width < 640) {
      await page.locator('#menu-button').click();
      await screenshot(page, 'mobile-menu');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#sidebar').isVisible(), false, 'Escape closes the mobile menu');
    }
  }

  await page.setViewportSize(viewports[0]);
  await theme(page, 'dark');
  const longName = `SyntheticUser_${Date.now().toString(36)}_${'X'.repeat(48)}`.slice(0, 48);
  await sidebarCommand(page, 'open-settings');
  await page.locator('#new-user-name').fill(longName);
  await page.locator('#create-user').click();
  const syntheticUser = page.locator('#user-list .user-entry').filter({ hasText: longName });
  await syntheticUser.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#model-key').inputValue(), '', 'Model credentials remain empty in the browser');
  for (const size of viewports) {
    await page.setViewportSize(size);
    await syntheticUser.scrollIntoViewIfNeeded();
    await screenshot(page, 'settings-long-name');
  }
  page.once('dialog', dialog => dialog.accept());
  await syntheticUser.locator('button').click();
  await syntheticUser.waitFor({ state: 'detached' });
  await page.locator('#access form[method="dialog"] button').click();
  await page.locator('#notice').waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await page.setViewportSize(viewports[0]);

  const longTask = `SyntheticUnbrokenTaskTitle${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(70)}\n\nPlease fix the pricing demo and verify its four rules. Synthetic data only.`;
  const started = await request(page, 'api/sessions', { prompt: longTask, mode: 'demo' });
  assert.equal(started.status, 201, 'Start the deterministic demo without provider credentials');
  const sessionID = started.data.sessionId;
  demoPage = page; demoID = sessionID;
  await page.evaluate(id => { location.hash = `session=${id}`; }, sessionID);
  await page.locator('#approval-panel').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#task-title').textContent()).length, 48, 'Exercise the longest task title');
  for (const size of viewports) {
    await page.setViewportSize(size);
    for (const value of ['dark', 'light']) {
      await theme(page, value);
      await screenshot(page, `approval-${value}`);
    }
  }
  await page.locator('#chat-scroll').evaluate(element => { element.scrollTop = 0; });
  await screenshot(page, 'long-conversation');
  await page.locator('#allow-approval').click();
  await page.waitForFunction(() => document.getElementById('task-status').classList.contains('success'));
  demoCompleted = true;
  assert.equal(await page.locator('#test-badge').textContent(), '4 / 4 \u901a\u8fc7', 'Approval runs the actual demo tests');
  for (const size of viewports) {
    await page.setViewportSize(size);
    await page.locator('#open-review').click();
    await page.locator('#review-pane').waitFor({ state: 'visible' });
    for (const value of ['dark', 'light']) {
      await theme(page, value);
      await page.locator('#tab-diff').click();
      assert.equal(await page.locator('#tab-diff').getAttribute('aria-selected'), 'true');
      await page.locator('#diff-content .diff-line.added').waitFor();
      await screenshot(page, `review-diff-${value}`);
      await page.locator('#tab-tests').click();
      assert.equal(await page.locator('#tab-tests').getAttribute('aria-selected'), 'true');
      await page.locator('#test-content .test-group').first().waitFor();
      await screenshot(page, `review-tests-${value}`);
    }
    await page.locator('#close-review').click();
    assert.equal(await page.locator('#review-pane').isVisible(), false, 'Review closes on every viewport');
  }

  await page.setViewportSize(viewports[0]);
  await sidebarCommand(page, 'open-migration');
  await page.locator('#demo').click();
  await page.locator('#convert').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('convert').disabled);
  await page.locator('#convert').click();
  await page.locator('#download-panel').waitFor({ state: 'visible' });
  assert.match(await page.locator('#sha').textContent(), /^[a-f0-9]{64}$/);
  assert.ok(Number(await page.locator('#record-count').textContent()) > 0, 'Migration processed synthetic records');
  for (const size of viewports) {
    await page.setViewportSize(size);
    await page.locator('#migration-view').evaluate(element => { element.scrollTop = 0; });
    for (const value of ['dark', 'light']) {
      await theme(page, value);
      await screenshot(page, `migration-converted-${value}`);
    }
  }
  await page.locator('#close-migration').click();
  assert.equal(await page.locator('#workspace-view').isVisible(), true);

  const restrictedContext = await browser.newContext({ viewport: viewports[2] });
  await restrictedContext.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Synthetic disabled storage', 'SecurityError'); } });
  });
  const restricted = await pageFor(restrictedContext);
  assert.equal(await restricted.locator('html').getAttribute('data-theme'), 'dark');
  await theme(restricted, 'light', 'Enter');
  await screenshot(restricted, 'storage-disabled-light');
  await theme(restricted, 'dark', 'Space');
  await restricted.reload();
  await ready(restricted);
  await screenshot(restricted, 'storage-disabled-reloaded');
  await sidebarCommand(restricted, 'open-settings');
  await restricted.locator('#access').waitFor({ state: 'visible' });
  await geometry(restricted, 'storage-disabled-settings');
  await restrictedContext.close();

  const rateContext = await browser.newContext({ viewport: viewports[2] });
  const ratePage = await observedPage(rateContext);
  await ratePage.route('**/api/workbench', route => route.fulfill({
    status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many authentication attempts' }),
  }));
  await ratePage.goto(url);
  await ratePage.locator('#access').waitFor({ state: 'visible' });
  const loginError = await ratePage.locator('#connection-error').textContent();
  assert.match(loginError, /\u767b\u5f55\u5c1d\u8bd5/, 'Initial login throttling explains the login limit');
  assert.doesNotMatch(loginError, /API Key/, 'Login throttling must not suggest changing model credentials');
  await screenshot(ratePage, 'initial-login-rate-limit');
  await rateContext.close();

  assert.deepEqual(errors, [], 'No browser runtime errors');
  assert.deepEqual(external, [], 'No external network requests');
  console.log(`PASS: theme keyboard/persistence, ${viewports.length} viewport layouts, demo approval/diff/tests, migration, long text, disabled storage, initial login throttling, and zero runtime/external requests. ${metrics.length} geometry checks; synthetic data only.`);
} finally {
  if (demoID && !demoCompleted && !demoPage.isClosed()) {
    await request(demoPage, `api/sessions/${demoID}/cancel`, {}).catch(() => {});
  }
  await writeFile(path.join(output, 'geometry.json'), JSON.stringify(metrics, null, 2));
  await browser.close();
}
