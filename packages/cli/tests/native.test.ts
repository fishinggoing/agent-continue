import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execute } from '../src/command.ts'
import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import { TARGET_ID, writeDsh } from './fixtures.ts'
import { configureHome, nativeCliVersion, withServer } from './native.ts'

test('CLI imports listable native history without replaying unresolved tools', { timeout: 90_000 }, async (context) => {
  const binary = process.env.AGENT_CONTINUE_CODEX_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!binary || !probeRoot) {
    context.skip('Set AGENT_CONTINUE_CODEX_CLI and AGENT_CONTINUE_NATIVE_ROOT for isolated native verification')
    return
  }
  assert.ok(isAbsolute(binary) && isAbsolute(probeRoot), 'Native verification requires explicit absolute paths')
  const cliVersion = nativeCliVersion(binary)
  context.diagnostic(`Native Codex version: ${cliVersion}`)
  const root = mkdtempSync(join(probeRoot, 'cli-native-'))
  const home = join(root, 'codex-home')
  configureHome(home)
  await withServer(binary, home, root, async (call) => {
    const started = await call('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' })
    assert.equal(started.error, undefined)
  })
  const report = execute([
    'migrate', '--from', 'dsh', '--input', writeDsh(root, 'pending'), '--cwd', root,
    '--target-home', home, '--id', TARGET_ID, '--cli-version', cliVersion,
    '--model-provider', 'local-probe', '--model', 'offline-probe',
  ])
  assert.equal(report.nativeValidation, 'not-run')
  assert.equal(report.toolsExecuted, 0)
  assert.equal(report.modelRequests, 0)
  assert.deepEqual(report.pendingOperations, [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }])
  await withServer(binary, home, root, async (call) => {
    const listed = await call('thread/list', { useStateDbOnly: true, sourceKinds: ['exec'], modelProviders: ['local-probe'], limit: 20 })
    assert.equal(listed.error, undefined)
    assert.ok((listed.result?.data as { id: string }[]).some((thread) => thread.id === TARGET_ID), 'Native listing includes the imported thread')
    const resumed = await call('thread/resume', { threadId: TARGET_ID, cwd: root, model: 'offline-probe', modelProvider: 'local-probe', approvalPolicy: 'on-request', sandbox: 'read-only' })
    assert.equal(resumed.error, undefined)
    const history = await call('thread/items/list', { threadId: TARGET_ID, limit: 20 })
    assert.equal(history.error, undefined, `Native history rejected the import: ${JSON.stringify(history.error)}`)
    const items = JSON.stringify(history.result?.data)
    assert.ok(items.includes('SYNTHETIC PRIVATE QUESTION'), 'Native history preserves the user text')
    assert.ok(items.includes('SYNTHETIC PRIVATE ANSWER'), 'Native history preserves the assistant text')
  })
  const output = report.output as { path: string }
  const restored = parseRollout(readFileSync(output.path, 'utf8'))
  assert.equal(restored.failures.length, 0)
  assert.equal(restored.records.filter((record) => record.type === 'response_item' && record.payload.type === 'function_call_output').length, 0, 'Native loading does not invent a result or replay the unresolved call')
})
