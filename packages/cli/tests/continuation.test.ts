import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execute } from '../src/command.ts'
import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import { CONVERSATION_TEXTS, TARGET_ID, writeDshConversation } from './fixtures.ts'
import { configureHome, nativeCliVersion, waitForNotification, withServer } from './native.ts'
import { CONTINUATION_REPLY, withResponsesFixture } from './responses.ts'

function textOfMessage(message: Record<string, unknown>): string {
  const content = message.content
  if (!Array.isArray(content)) return ''
  return content.map((block: Record<string, unknown>) => typeof block.text === 'string' ? block.text : '').join('')
}

test('native continuation receives multiple turns and completed tool results without replay', { timeout: 90_000 }, async (context) => {
  const binary = process.env.AGENT_CONTINUE_CODEX_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!binary || !probeRoot) {
    context.skip('Set AGENT_CONTINUE_CODEX_CLI and AGENT_CONTINUE_NATIVE_ROOT for isolated native verification')
    return
  }
  assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
  const cliVersion = nativeCliVersion(binary)
  context.diagnostic(`Native Codex version: ${cliVersion}`)
  const root = mkdtempSync(join(probeRoot, 'cli-continuation-'))
  const home = join(root, 'codex-home')
  await withResponsesFixture(async (fixture) => {
    configureHome(home, fixture.baseUrl)
    await withServer(binary, home, root, async (call) => {
      const started = await call('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' })
      assert.equal(started.error, undefined)
    })
    const report = execute([
      'migrate', '--from', 'dsh', '--input', writeDshConversation(root), '--cwd', root,
      '--target-home', home, '--id', TARGET_ID, '--cli-version', cliVersion,
      '--model-provider', 'local-probe', '--model', 'offline-probe',
    ])
    assert.deepEqual(report.pendingOperations, [])
    assert.equal(report.toolsExecuted, 0)
    assert.equal(report.modelRequests, 0)
    assert.equal(fixture.requests.length, 0)
    await withServer(binary, home, root, async (call, notifications) => {
      const resumed = await call('thread/resume', { threadId: TARGET_ID, cwd: root, model: 'offline-probe', modelProvider: 'local-probe', approvalPolicy: 'on-request', sandbox: 'read-only' })
      assert.equal(resumed.error, undefined)
      const turns = await call('thread/turns/list', { threadId: TARGET_ID, itemsView: 'full', sortDirection: 'asc', limit: 10 })
      assert.equal(turns.error, undefined)
      assert.equal((turns.result?.data as unknown[]).length, 2, 'Both original turns survive native restoration')
      const history: unknown[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await call('thread/items/list', { threadId: TARGET_ID, limit: 1, sortDirection: 'asc', ...(cursor === undefined ? {} : { cursor }) })
        assert.equal(page.error, undefined)
        history.push(...page.result?.data as unknown[])
        cursor = typeof page.result?.nextCursor === 'string' ? page.result.nextCursor : undefined
        if (cursor !== undefined) {
          assert.ok(!cursors.has(cursor), 'Pagination must advance')
          cursors.add(cursor)
        }
        assert.ok(cursors.size <= 20, 'Small synthetic history should not generate an unbounded page chain')
      } while (cursor !== undefined)
      for (const text of CONVERSATION_TEXTS) assert.ok(JSON.stringify(history).includes(text), 'Native pagination preserves each original message')
      assert.equal(fixture.requests.length, 0, 'Reading original history makes no model request')
      const followup = 'SYNTHETIC FOLLOW-UP'
      const started = await call('turn/start', { threadId: TARGET_ID, input: [{ type: 'text', text: followup }], model: 'offline-probe', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } })
      assert.equal(started.error, undefined)
      const turnId = (started.result?.turn as { id: string }).id
      const completed = await waitForNotification(notifications, (notification) => notification.method === 'turn/completed' && (notification.params?.turn as { id?: string } | undefined)?.id === turnId)
      assert.equal((completed.params?.turn as { status: string }).status, 'completed')
      assert.equal(fixture.requests.length, 1, 'Continuation uses exactly one local synthetic response')
      assert.equal(fixture.credentialHeaderPresent, false)
      const input = fixture.requests[0]!.input as Record<string, unknown>[]
      const positions: number[] = []
      for (const [index, text] of CONVERSATION_TEXTS.entries()) {
        const role = index % 2 === 0 ? 'user' : 'assistant'
        const matches = input.flatMap((message, position) => message.role === role && textOfMessage(message) === text ? [position] : [])
        assert.equal(matches.length, 1, 'Provider input contains each original message exactly once in its correct role')
        positions.push(matches[0]!)
      }
      const followupPositions = input.flatMap((message, position) => message.role === 'user' && textOfMessage(message) === followup ? [position] : [])
      const callPositions = input.flatMap((message, position) => message.type === 'function_call' && message.call_id === 'synthetic-call' ? [position] : [])
      const resultPositions = input.flatMap((message, position) => message.type === 'function_call_output' && message.call_id === 'synthetic-call' && message.output === 'SYNTHETIC PRIVATE RESULT' ? [position] : [])
      assert.equal(followupPositions.length, 1)
      assert.equal(callPositions.length, 1, 'Original tool call appears exactly once in model history')
      assert.equal(resultPositions.length, 1, 'Original completed tool result reaches model history exactly once and unchanged')
      const ordered = [positions[0]!, positions[1]!, callPositions[0]!, resultPositions[0]!, positions[2]!, positions[3]!, followupPositions[0]!]
      assert.ok(ordered.every((position, index) => index === 0 || position > ordered[index - 1]!), 'Original messages, tool call/result and follow-up retain chronological order')
      assert.ok(!notifications.some((notification) => notification.id !== undefined), 'No native request to execute or approve a historical tool is received')
      const after = await call('thread/items/list', { threadId: TARGET_ID, limit: 20 })
      assert.equal(after.error, undefined)
      assert.ok(JSON.stringify(after.result?.data).includes(CONTINUATION_REPLY), 'Local continuation is appended to the imported thread')
    })
    await withServer(binary, home, root, async (call, notifications) => {
      const resumed = await call('thread/resume', { threadId: TARGET_ID, cwd: root, model: 'offline-probe', modelProvider: 'local-probe', approvalPolicy: 'on-request', sandbox: 'read-only' })
      assert.equal(resumed.error, undefined)
      const turns = await call('thread/turns/list', { threadId: TARGET_ID, itemsView: 'full', sortDirection: 'asc', limit: 10 })
      assert.equal(turns.error, undefined)
      assert.equal((turns.result?.data as unknown[]).length, 3, 'The original turns and continuation survive a native process restart')
      const history = await call('thread/items/list', { threadId: TARGET_ID, limit: 20, sortDirection: 'asc' })
      assert.equal(history.error, undefined)
      const items = JSON.stringify(history.result?.data)
      for (const text of [...CONVERSATION_TEXTS, 'SYNTHETIC FOLLOW-UP', CONTINUATION_REPLY]) {
        assert.ok(items.includes(text), 'Every original and continued message remains readable after restart')
      }
      assert.equal(fixture.requests.length, 1, 'Resuming the continued thread makes no additional model request')
      assert.ok(!notifications.some((notification) => notification.id !== undefined), 'Restarting the native process does not request execution or approval of historical tools')
    })
    const output = report.output as { path: string }
    const restored = parseRollout(readFileSync(output.path, 'utf8'))
    assert.equal(restored.failures.length, 0)
    assert.equal(restored.records.filter((record) => record.type === 'response_item' && record.payload.type === 'function_call_output').length, 1, 'Completed historical tools are not replayed or duplicated')
  })
})
