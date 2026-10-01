import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execute } from '../src/command.ts'
import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import { TARGET_ID, writeDsh } from './fixtures.ts'
import { configureHome, nativeCliVersion, withServer } from './native.ts'

test('native Codex accepts the proposed unknown-outcome extension across restarts', { timeout: 90_000 }, async (context) => {
  const binary = process.env.AGENT_CONTINUE_CODEX_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!binary || !probeRoot) {
    context.skip('Set AGENT_CONTINUE_CODEX_CLI and AGENT_CONTINUE_NATIVE_ROOT for isolated native verification')
    return
  }
  assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
  const cliVersion = nativeCliVersion(binary)
  context.diagnostic(`Native Codex version: ${cliVersion}; candidate extension is applied only to this isolated artifact`)
  const root = mkdtempSync(join(probeRoot, 'cli-recovery-extension-'))
  const home = join(root, 'codex-home')
  configureHome(home)
  await withServer(binary, home, root, async (call) => {
    assert.equal((await call('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' })).error, undefined)
  })
  const report = execute([
    'migrate', '--from', 'dsh', '--input', writeDsh(root, 'completed'), '--cwd', root,
    '--target-home', home, '--id', TARGET_ID, '--cli-version', cliVersion,
    '--model-provider', 'local-probe', '--model', 'offline-probe',
  ])
  const output = report.output as { path: string }
  const candidate = parseRollout(readFileSync(output.path, 'utf8'))
  assert.equal(candidate.failures.length, 0)
  const result = candidate.records.find((record) => record.type === 'response_item' && record.payload.type === 'function_call_output')!
  result.payload.isError = true
  result.payload.recovery = 'TOOL_OUTCOME_UNKNOWN'
  result.payload.output = 'Synthetic tool execution was interrupted; the actual outcome is unknown.'
  writeFileSync(output.path, `${candidate.records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const pending = [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withServer(binary, home, root, async (call, notifications) => {
      const resumed = await call('thread/resume', { threadId: TARGET_ID, cwd: root, model: 'offline-probe', modelProvider: 'local-probe', approvalPolicy: 'on-request', sandbox: 'read-only' })
      assert.equal(resumed.error, undefined)
      const history = await call('thread/items/list', { threadId: TARGET_ID, limit: 20 })
      assert.equal(history.error, undefined)
      const items = JSON.stringify(history.result?.data)
      assert.ok(items.includes('SYNTHETIC PRIVATE QUESTION') && items.includes('SYNTHETIC PRIVATE ANSWER'))
      assert.ok(!notifications.some((notification) => notification.id !== undefined), 'Native recovery does not request execution or approval of the marked tool')
    })
    assert.deepEqual(execute(['inspect', '--from', 'codex', '--input', output.path]).pendingOperations, pending)
    const after = parseRollout(readFileSync(output.path, 'utf8'))
    assert.equal(after.failures.length, 0)
    const results = after.records.filter((record) => record.type === 'response_item' && record.payload.type === 'function_call_output')
    assert.equal(results.length, 1)
    assert.equal(results[0]!.payload.recovery, 'TOOL_OUTCOME_UNKNOWN')
    assert.equal(results[0]!.payload.isError, true)
  }
})
