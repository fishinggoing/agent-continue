import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execute } from '../src/command.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { USAGE_CASES, usageRecords } from '../../contract/tests/usage-fixtures.ts'
import { configureHome, nativeCliVersion, waitForNotification, withRpcServer, withServer } from './native.ts'
import { withResponsesFixture } from './responses.ts'

test('native Codex reports cached input inside aggregate input and reasoning inside output', { timeout: 90_000 }, async (context) => {
  const binary = process.env.AGENT_CONTINUE_CODEX_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!binary || !probeRoot) {
    context.skip('Set AGENT_CONTINUE_CODEX_CLI and AGENT_CONTINUE_NATIVE_ROOT for isolated native verification')
    return
  }
  assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
  const root = mkdtempSync(join(probeRoot, 'cli-usage-accounting-'))
  const home = join(root, 'codex-home')
  context.diagnostic(`Native Codex version: ${nativeCliVersion(binary)}`)
  await withResponsesFixture(async (fixture) => {
    configureHome(home, fixture.baseUrl)
    await withServer(binary, home, root, async (call, notifications) => {
      const started = await call('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only', model: 'offline-probe', modelProvider: 'local-probe' })
      assert.equal(started.error, undefined)
      const threadId = (started.result?.thread as { id: string }).id
      const turn = await call('turn/start', {
        threadId, input: [{ type: 'text', text: 'SYNTHETIC TOKEN ACCOUNTING QUESTION' }],
        model: 'offline-probe', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' },
      })
      assert.equal(turn.error, undefined)
      const turnId = (turn.result?.turn as { id: string }).id
      await waitForNotification(notifications, (notification) => notification.method === 'turn/completed' && (notification.params?.turn as { id?: string })?.id === turnId)
      const usage = await waitForNotification(notifications, (notification) => notification.method === 'thread/tokenUsage/updated' && notification.params?.threadId === threadId)
      const last = (usage.params?.tokenUsage as { last: Record<string, number> }).last
      assert.deepEqual(last, { inputTokens: 24, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 30 })
      context.diagnostic(`Native token breakdown: ${JSON.stringify(last)}`)
      assert.equal(fixture.requests.length, 1)
      assert.equal(fixture.credentialHeaderPresent, false)
      assert.ok(!notifications.some((notification) => notification.id !== undefined))
    })
  }, {
    input_tokens: 24, input_tokens_details: { cached_tokens: 4 },
    output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 30,
  })
})

test('DSH restores sparse usage and preserves exact keys and recorded counters across restarts', { timeout: 120_000 }, async (context) => {
  const binary = process.env.AGENT_CONTINUE_DSH_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!binary || !probeRoot || process.platform !== 'win32') {
    context.skip('Set AGENT_CONTINUE_DSH_CLI and AGENT_CONTINUE_NATIVE_ROOT for Windows isolated DSH verification')
    return
  }
  assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
  const root = mkdtempSync(join(probeRoot, 'cli-usage-native-'))
  const home = join(root, 'dsh-home')
  const appdata = join(home, 'appdata')
  const localappdata = join(home, 'localappdata')
  mkdirSync(appdata, { recursive: true })
  mkdirSync(localappdata)
  const profile = 'codex-usage-test'
  const env = {
    DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile),
    USERPROFILE: home, HOME: home, APPDATA: appdata, LOCALAPPDATA: localappdata,
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
  }
  const configured = spawnSync('cmd.exe', ['/d', '/c', binary, profile, '--from-default-profile', 'acp', '--dump-config'], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(configured.status, 0)
  const imported = USAGE_CASES.map((scenario, index) => {
    const input = join(root, `usage-${index}.jsonl`)
    writeFileSync(input, `${usageRecords(root, scenario.source).map((record, ordinal) => JSON.stringify({ ...record, ordinal })).join('\n')}\n`)
    const id = randomUUID()
    const report = execute(['migrate', '--from', 'codex', '--input', input, '--cwd', root, '--target-home', home, '--id', id])
    assert.equal(report.modelRequests, 0)
    assert.equal(report.toolsExecuted, 0)
    if (scenario.loss) assert.match((report.losses as string[]).join('\n'), scenario.loss)
    return { scenario, id, path: (report.output as { path: string }).path }
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withRpcServer('cmd.exe', ['/d', '/c', binary, profile], env, root, async (call, notifications) => {
      const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent_continue_usage_test', version: '0.0.1' } })
      assert.equal(initialized.error, undefined)
      context.diagnostic(`Native DSH agent: ${JSON.stringify(initialized.result?.agentInfo ?? null)}`)
      const listed = await call('session/list', { cwd: root })
      assert.equal(listed.error, undefined)
      const ids = (listed.result?.sessions as { sessionId: string }[]).map((session) => session.sessionId)
      for (const item of imported) {
        assert.ok(ids.includes(item.id))
        const resumed = await call('session/resume', { cwd: root, sessionId: item.id })
        assert.equal(resumed.error, undefined, `Native DSH rejected usage case ${item.scenario.name}: ${JSON.stringify(resumed.error)}`)
        const after = parseSessionLog(readFrames(readFileSync(item.path)).text, 4)
        const assistant = after.events.find((event) => event.type === 'assistant/message')!
        assert.deepEqual(assistant.data.usage, item.scenario.expected, item.scenario.name)
        assert.equal(Object.hasOwn(assistant.data, 'usage'), item.scenario.expected !== undefined)
        const history = JSON.stringify(after.events)
        assert.ok(history.includes('SYNTHETIC USAGE QUESTION') && history.includes('SYNTHETIC USAGE ANSWER'))
        assert.equal(after.events.filter((event) => event.type === 'turn/start').length, 1)
      }
      assert.ok(!notifications.some((notification) => notification.id !== undefined), 'Usage restoration cannot request execution or approval')
    })
  }
})
