import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execute } from '../src/command.ts'
import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { writeArtifact } from '../../dsh-adapter/src/write.ts'
import { dshLog } from './fixtures.ts'
import { configureHome, nativeCliVersion, withRpcServer, withServer } from './native.ts'

interface UnknownToolResult {
  error: { name: string; code: string }
  message: { isError: boolean; toolCallId: string; source: { callId: string }; content: { type: string; text: string }[] }
}

test('native unknown tool recovery survives unmodified migration, restarts and the return direction', { timeout: 120_000 }, async (context) => {
  const codex = process.env.AGENT_CONTINUE_CODEX_CLI
  const dsh = process.env.AGENT_CONTINUE_DSH_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!codex || !dsh || !probeRoot || process.platform !== 'win32') {
    context.skip('Set both AGENT_CONTINUE native CLI paths and AGENT_CONTINUE_NATIVE_ROOT for isolated Windows verification')
    return
  }
  assert.ok(isAbsolute(codex) && isAbsolute(dsh) && isAbsolute(probeRoot))
  const root = mkdtempSync(join(probeRoot, 'cli-recovery-roundtrip-'))
  const cliVersion = nativeCliVersion(codex)
  context.diagnostic(`Native Codex version: ${cliVersion}; no migration output is manually corrected`)
  const pending = [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }]
  const restoreDsh = async (home: string, id: string): Promise<void> => {
    const appdata = join(home, 'appdata')
    const localappdata = join(home, 'localappdata')
    mkdirSync(appdata, { recursive: true })
    mkdirSync(localappdata, { recursive: true })
    const profile = 'codex-roundtrip-test'
    const env = {
      DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile),
      USERPROFILE: home, HOME: home, APPDATA: appdata, LOCALAPPDATA: localappdata,
      SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
    }
    if (!existsSync(env.DSH_PROFILE_DIR)) {
      const configured = spawnSync('cmd.exe', ['/d', '/c', dsh, profile, '--from-default-profile', 'acp', '--dump-config'], {
        cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      })
      assert.equal(configured.status, 0, `Isolated profile initialization failed: ${configured.stdout}${configured.stderr}`)
    }
    await withRpcServer('cmd.exe', ['/d', '/c', dsh, profile], env, root, async (call, notifications) => {
      const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent_continue_roundtrip_test', version: '0.0.1' } })
      assert.equal(initialized.error, undefined)
      context.diagnostic(`Native DSH agent: ${JSON.stringify(initialized.result?.agentInfo ?? null)}`)
      const listed = await call('session/list', { cwd: root })
      assert.equal(listed.error, undefined)
      assert.ok((listed.result?.sessions as { sessionId: string }[]).some((session) => session.sessionId === id))
      assert.equal((await call('session/resume', { cwd: root, sessionId: id })).error, undefined)
      assert.ok(!notifications.some((notification) => notification.id !== undefined), 'Native DSH does not request tool execution or approval')
    })
  }

  const sourceHome = join(root, 'source-dsh-home')
  const sourceId = randomUUID()
  const source = dshLog(root, 'pending')
  const written = writeArtifact(join(sourceHome, 'sessions'), { ...source.header, id: sourceId }, source.events)
  await restoreDsh(sourceHome, sourceId)
  const repaired = parseSessionLog(readFrames(readFileSync(written.path)).text, 4)
  const sourceResults = repaired.events.filter((event) => event.type === 'tool/result')
  assert.equal(sourceResults.length, 1)
  const expected = sourceResults[0]!.data as UnknownToolResult
  assert.equal(expected.error.code, 'TOOL_OUTCOME_UNKNOWN')
  assert.equal(expected.message.isError, true)
  assert.deepEqual(execute(['inspect', '--from', 'dsh', '--input', written.path]).pendingOperations, pending)

  const home = join(root, 'codex-home')
  configureHome(home)
  await withServer(codex, home, root, async (call) => {
    assert.equal((await call('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' })).error, undefined)
  })
  const threadId = randomUUID()
  const migrated = execute([
    'migrate', '--from', 'dsh', '--input', written.path, '--cwd', root, '--target-home', home,
    '--id', threadId, '--cli-version', cliVersion, '--model-provider', 'local-probe', '--model', 'offline-probe',
  ])
  assert.deepEqual(migrated.pendingOperations, pending)
  assert.equal(migrated.modelRequests, 0)
  assert.equal(migrated.toolsExecuted, 0)
  const output = migrated.output as { path: string }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = parseRollout(readFileSync(output.path, 'utf8'))
    assert.equal(parsed.failures.length, 0)
    const results = parsed.records.filter((record) => record.type === 'response_item' && record.payload.type === 'function_call_output')
    assert.equal(results.length, 1)
    assert.equal(results[0]!.payload.call_id, 'synthetic-call')
    assert.equal(results[0]!.payload.recovery, 'TOOL_OUTCOME_UNKNOWN')
    assert.equal(results[0]!.payload.isError, true)
    assert.equal(results[0]!.payload.output, expected.message.content.map((block) => block.text).join(''))
    await withServer(codex, home, root, async (call, notifications) => {
      const listed = await call('thread/list', { useStateDbOnly: true, sourceKinds: ['exec'], modelProviders: ['local-probe'], limit: 20 })
      assert.equal(listed.error, undefined)
      assert.ok((listed.result?.data as { id: string }[]).some((thread) => thread.id === threadId))
      assert.equal((await call('thread/resume', { threadId, cwd: root, model: 'offline-probe', modelProvider: 'local-probe', approvalPolicy: 'on-request', sandbox: 'read-only' })).error, undefined)
      const history = await call('thread/items/list', { threadId, limit: 20 })
      assert.equal(history.error, undefined)
      const items = JSON.stringify(history.result?.data)
      assert.ok(items.includes('SYNTHETIC PRIVATE QUESTION') && items.includes('SYNTHETIC PRIVATE ANSWER'))
      assert.ok(!notifications.some((notification) => notification.id !== undefined), 'Native Codex does not request tool execution or approval')
    })
    assert.deepEqual(execute(['inspect', '--from', 'codex', '--input', output.path]).pendingOperations, pending)
  }

  const returnedHome = join(root, 'returned-dsh-home')
  const returnedId = randomUUID()
  const returned = execute([
    'migrate', '--from', 'codex', '--input', output.path, '--cwd', root, '--target-home', returnedHome, '--id', returnedId,
  ])
  assert.deepEqual(returned.pendingOperations, pending)
  assert.equal(returned.modelRequests, 0)
  assert.equal(returned.toolsExecuted, 0)
  const returnedPath = (returned.output as { path: string }).path
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await restoreDsh(returnedHome, returnedId)
    const restored = parseSessionLog(readFrames(readFileSync(returnedPath)).text, 4)
    const results = restored.events.filter((event) => event.type === 'tool/result')
    assert.equal(results.length, 1, 'Native DSH cannot replace or duplicate the preserved recovery result')
    const result = results[0]!.data as UnknownToolResult
    assert.deepEqual(result.error, expected.error)
    assert.equal(result.message.isError, true)
    assert.equal(result.message.toolCallId, 'synthetic-call')
    assert.equal(result.message.source.callId, 'synthetic-call')
    assert.deepEqual(result.message.content, expected.message.content)
    const text = JSON.stringify(restored.events)
    assert.ok(text.includes('SYNTHETIC PRIVATE QUESTION') && text.includes('SYNTHETIC PRIVATE ANSWER'))
    assert.deepEqual(execute(['inspect', '--from', 'dsh', '--input', returnedPath]).pendingOperations, pending)
  }
})
