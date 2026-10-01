import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execute } from '../src/command.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { writeArtifact } from '../../dsh-adapter/src/write.ts'
import { CONVERSATION_TEXTS, codexConversation, codexRecords, dshLog } from './fixtures.ts'
import { withRpcServer } from './native.ts'

for (const scenario of ['multi-turn-completed-tool', 'interrupted-tool', 'native-completed-control', 'native-interrupted-control'] as const) {
  test(`DSH native restoration: ${scenario}`, { timeout: 90_000 }, async (context) => {
    const binary = process.env.AGENT_CONTINUE_DSH_CLI
    const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
    if (!binary || !probeRoot || process.platform !== 'win32') {
      context.skip('Set AGENT_CONTINUE_DSH_CLI and AGENT_CONTINUE_NATIVE_ROOT for Windows isolated DSH verification')
      return
    }
    assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
    const root = mkdtempSync(join(probeRoot, 'cli-dsh-'))
    const home = join(root, 'dsh-home')
    const appdata = join(home, 'appdata')
    const localappdata = join(home, 'localappdata')
    mkdirSync(appdata, { recursive: true })
    mkdirSync(localappdata)
    const profile = 'codex-native-test'
    const env = {
      DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile),
      USERPROFILE: home, HOME: home, APPDATA: appdata, LOCALAPPDATA: localappdata,
      SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
    }
    const configured = spawnSync('cmd.exe', ['/d', '/c', binary, profile, '--from-default-profile', 'acp', '--dump-config'], {
      cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(configured.status, 0, 'Isolated ACP profile initialization succeeds without user credentials')
    const records = scenario === 'multi-turn-completed-tool' ? codexConversation(root) : codexRecords(root, 'pending')
    if (scenario === 'interrupted-tool') {
      const callIndex = records.findIndex((record) => record.payload.type === 'function_call')
      records.splice(callIndex + 1)
    }
    const input = join(root, 'source-rollout.jsonl')
    writeFileSync(input, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const id = randomUUID()
    const nativeControl = scenario.startsWith('native-')
    const interrupted = scenario.includes('interrupted')
    let output: { path: string }
    if (nativeControl) {
      const source = dshLog(root, interrupted ? 'pending' : 'completed', 1790730000000, interrupted ? undefined : CONVERSATION_TEXTS)
      output = writeArtifact(join(home, 'sessions'), { ...source.header, id }, source.events)
    } else {
      const report = execute(['migrate', '--from', 'codex', '--input', input, '--cwd', root, '--target-home', home, '--id', id])
      const pending = interrupted ? [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }] : []
      assert.deepEqual(report.pendingOperations, pending)
      assert.equal(report.toolsExecuted, 0)
      assert.equal(report.modelRequests, 0)
      output = report.output as { path: string }
    }
    const restored = parseSessionLog(readFrames(readFileSync(output.path)).text, 4)
    const restoredText = JSON.stringify(restored.events)
    if (!interrupted) {
      for (const text of CONVERSATION_TEXTS) assert.ok(restoredText.includes(text))
      assert.ok(restoredText.includes('SYNTHETIC PRIVATE RESULT'))
      assert.equal(restored.events.filter((event) => event.type === 'turn/start').length, 2)
      assert.equal(restored.events.filter((event) => event.type === 'tool/result').length, 1)
    } else {
      assert.equal(restored.events.filter((event) => event.type === 'tool/result').length, 0)
      assert.ok(restoredText.includes('SYNTHETIC PRIVATE QUESTION'))
    }
    await withRpcServer('cmd.exe', ['/d', '/c', binary, profile], env, root, async (call, notifications) => {
      const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent_continue_cli_test', version: '0.0.1' } })
      assert.equal(initialized.error, undefined)
      const listed = await call('session/list', { cwd: root })
      assert.equal(listed.error, undefined)
      assert.ok((listed.result?.sessions as { sessionId: string }[]).some((session) => session.sessionId === id))
      const resumed = await call('session/resume', { cwd: root, sessionId: id })
      assert.equal(resumed.error, undefined, `Native DSH rejected converted history: ${JSON.stringify(resumed.error)}`)
      assert.ok(resumed.result?.configOptions !== undefined)
      assert.ok(!notifications.some((notification) => notification.id !== undefined), 'No historical tool execution or approval request is issued during native recovery')
    })
    const after = parseSessionLog(readFrames(readFileSync(output.path)).text, 4)
    const results = after.events.filter((event) => event.type === 'tool/result')
    assert.equal(results.length, 1, 'Native recovery preserves the completed result or records an unknown-outcome repair')
    if (interrupted) {
      const data = results[0]!.data as { error: { code: string }; message: { isError: boolean } }
      assert.equal(data.error.code, 'TOOL_OUTCOME_UNKNOWN')
      assert.equal(data.message.isError, true)
      const inspected = execute(['inspect', '--from', 'dsh', '--input', output.path])
      assert.deepEqual(inspected.pendingOperations, [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }], 'A native unknown-outcome repair cannot resolve the actual tool outcome')
    } else {
      assert.ok(JSON.stringify(results[0]!.data).includes('SYNTHETIC PRIVATE RESULT'))
    }
  })
}
