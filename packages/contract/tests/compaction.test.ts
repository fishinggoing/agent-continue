import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertCodexToDsh } from '../src/codex-to-dsh.ts'
import { compactedSource, activeEvents } from './compaction-fixture.ts'

test('compaction keeps native replacement messages active and original history archived', () => {
  const conversion = convertCodexToDsh(compactedSource('F:\\compaction-fixture'), { sessionId: 'target', cwd: 'F:\\compaction-fixture' })
  const active = activeEvents(conversion.events)
  const text = JSON.stringify(active)
  assert.ok(text.includes('COMPACTED STATE'))
  assert.ok(text.includes('CONTINUE AFTER COMPACTION'))
  assert.ok(text.includes('POST-COMPACTION WORK'))
  assert.ok(!text.includes('OBSOLETE PARTIAL PLAN') && !text.includes('ARCHIVED TOOL RESULT'))
  assert.equal(active.filter((event) => JSON.stringify(event.data).includes('ORIGINAL REQUIREMENTS')).length, 1)
  assert.ok(!text.includes('UNUSED SUMMARY FALLBACK'))
  assert.ok(JSON.stringify(conversion.events).includes('OBSOLETE PARTIAL PLAN'))
  assert.ok(JSON.stringify(conversion.events).includes('ARCHIVED TOOL RESULT'))
  assert.equal(conversion.events.filter((event) => event.type === 'tool/result').length, 1)
  assert.equal(conversion.tallies.compacted?.mapped, 1)
})

test('successive compactions replace the current surface, not stale numeric ranges', () => {
  const message = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
  const source = compactedSource('F:\\compaction-fixture', [[message('SUMMARY ONE')], [message('SUMMARY TWO')]])
  const conversion = convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\compaction-fixture' })
  const text = JSON.stringify(activeEvents(conversion.events))
  assert.ok(text.includes('SUMMARY TWO') && !text.includes('SUMMARY ONE'))
  assert.ok(JSON.stringify(conversion.events).includes('SUMMARY ONE'))
  assert.equal(conversion.tallies.compacted?.mapped, 2)
})

test('legacy plaintext-only compaction is a replacement checkpoint, not an extra summary duplicate', () => {
  const source = compactedSource('F:\\compaction-fixture')
  source.find((record) => record.type === 'compacted')!.payload = { message: 'LEGACY SUMMARY' }
  const conversion = convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\compaction-fixture' })
  const active = activeEvents(conversion.events)
  assert.equal(active.filter((event) => JSON.stringify(event.data).includes('LEGACY SUMMARY')).length, 1)
  assert.ok(!JSON.stringify(active).includes('OBSOLETE PARTIAL PLAN'))
})

test('compaction retains complete tool call/result pairs without executing them', () => {
  const source = compactedSource('F:\\compaction-fixture')
  source.find((record) => record.type === 'compacted')!.payload.replacement_history = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'RETAINED QUESTION' }] },
    { type: 'function_call', name: 'read', call_id: 'archived-call', arguments: '{}' },
    { type: 'function_call_output', call_id: 'archived-call', output: 'ARCHIVED TOOL RESULT' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'COMPACTED ANSWER' }] },
  ]
  const conversion = convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\compaction-fixture' })
  const active = activeEvents(conversion.events)
  assert.equal(active.filter((event) => event.type === 'tool/result').length, 1)
  assert.ok(JSON.stringify(active).includes('COMPACTED ANSWER'))
  assert.ok(!JSON.stringify(active).includes('OBSOLETE PARTIAL PLAN'))
})

test('summary cannot erase a recorded unknown tool outcome', () => {
  const source = compactedSource('F:\\compaction-fixture')
  const result = source.find((record) => record.payload.type === 'function_call_output')!
  result.payload.recovery = 'TOOL_OUTCOME_UNKNOWN'
  result.payload.isError = true
  const conversion = convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\compaction-fixture' })
  const active = JSON.stringify(activeEvents(conversion.events))
  assert.ok(active.includes('TOOL_OUTCOME_UNKNOWN') && active.includes('archived-call'))
  const notice = conversion.events.find((event) => (event.data as any).source?.kind === 'agent-continue-unknown-outcomes')!
  assert.ok(notice.sourceEventSeqs!.every((seq) => conversion.events[seq]!.type === 'tool/result'))
})

test('compaction reserves an empty protected system head without adding foreign instructions', () => {
  const conversion = convertCodexToDsh(compactedSource('F:\\compaction-fixture'), { sessionId: 'target', cwd: 'F:\\compaction-fixture' })
  const head = activeEvents(conversion.events)[0]!
  assert.equal(head.type, 'system/message')
  assert.deepEqual((head.data as any).message.content, [])
  assert.equal(conversion.events.filter((event) => event.type === 'system/message').length, 1)
  for (const replacement of conversion.events.filter((event) => typeof event.surfaceOp === 'object')) {
    assert.ok(!replacement.sourceEventSeqs!.includes(head.seq))
  }
})

test('compaction can be the first conversational context', () => {
  const source = compactedSource('F:\\compaction-fixture').filter((record) => record.type === 'session_meta' || record.type === 'compacted')
  const conversion = convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\compaction-fixture' })
  const active = activeEvents(conversion.events)
  assert.equal(active[0]!.type, 'system/message')
  assert.ok(JSON.stringify(active).includes('COMPACTED STATE'))
})

test('compaction refuses unresolved original source tools instead of guessing from the summary', () => {
  const source = compactedSource('F:\\compaction-fixture').filter((record) => record.payload.type !== 'function_call_output' && record.payload.type !== 'task_complete')
  assert.throws(() => convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\compaction-fixture' }), /compaction.*unresolved/i)
})

test('workspace remapping adds explicit current location without rewriting historical paths', () => {
  const source = compactedSource('F:\\previous-workspace')
  const conversion = convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\current-workspace' })
  const notice = activeEvents(conversion.events).at(-1)!
  assert.equal((notice.data as any).source.kind, 'agent-continue-workspace-remap')
  assert.equal((notice.data as any).source.fromCwd, 'F:\\previous-workspace')
  assert.equal((notice.data as any).source.toCwd, 'F:\\current-workspace')
  assert.ok(JSON.stringify(notice.data).includes('Continue only in the current workspace'))
})

test('compaction after a closed task with an unresolved tail is refused, not skipped', () => {
  const source = compactedSource('F:\\compaction-fixture')
  const compactedAt = source.findIndex((record) => record.type === 'compacted')
  const tail = source.slice(0, compactedAt + 1).filter((record) => record.payload.type !== 'function_call_output')
  assert.throws(() => convertCodexToDsh(tail, { sessionId: 'target', cwd: 'F:\\compaction-fixture' }), /compaction.*unresolved/i)
})

test('remapping a metadata-only source still reserves a protected system head', () => {
  const source = compactedSource('F:\\previous-workspace').filter((record) => record.type === 'session_meta')
  const conversion = convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\current-workspace' })
  assert.equal(activeEvents(conversion.events)[0]!.type, 'system/message')
})

for (const history of [[], 'bad', [{ type: 'compaction', encrypted_content: 'opaque' }], [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'opaque' }] }], [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'QUESTION' }] },
  { type: 'function_call', call_id: 'missing-result', name: 'read', arguments: '{}' },
]]) {
  test(`unreadable compaction refuses partial context: ${JSON.stringify(history)}`, () => {
    const source = compactedSource('F:\\compaction-fixture')
    source.find((record) => record.type === 'compacted')!.payload.replacement_history = history
    assert.throws(() => convertCodexToDsh(source, { sessionId: 'target', cwd: 'F:\\compaction-fixture' }), /compaction/i)
  })
}
