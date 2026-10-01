import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JsonObject } from '../../codex-adapter/src/rollout.ts'
import type { SessionEvent, SessionHeader, SurfaceOp } from '../../dsh-adapter/src/format.ts'
import { convertDshToCodex } from '../src/dsh-to-codex.ts'
import { convertCodexToDsh } from '../src/codex-to-dsh.ts'
import { TOOL_OUTCOME_UNKNOWN } from '../src/conventions.ts'
import { compactedSource } from './compaction-fixture.ts'
import { currentSurface } from '../../dsh-adapter/src/surface.ts'

function sourceLog() {
  const header: SessionHeader = { type: 'session', version: 4, id: 'surface-source', cwd: 'F:\\synthetic-workspace',
    createdAt: 1790800000000, isSeeded: false, delegationDepth: 0 }
  const events: SessionEvent[] = []
  const push = (type: string, data: JsonObject, operation?: SurfaceOp, sources?: number[]) => {
    const event: SessionEvent = { type, data, seq: events.length, time: header.createdAt + events.length,
      ...(operation === undefined ? {} : { surfaceOp: operation }), ...(sources === undefined ? {} : { sourceEventSeqs: sources }) }
    events.push(event)
    return event.seq
  }
  const user = (id: string, text: string, operation: SurfaceOp = 'append', sources?: number[]) =>
    push('user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'synthetic-context' } }, operation, sources)
  const open = (turn: number) => {
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
  }
  const close = (turn: number) => {
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { header, events, push, user, open, close }
}

const options = { cliVersion: '0.159.2', modelProvider: 'synthetic-target' }
const messageTexts = (drafts: ReturnType<typeof convertDshToCodex>['drafts']) => drafts.filter(record =>
  record.type === 'response_item' && record.payload.type === 'message').map(record =>
    (record.payload.content as JsonObject[]).map(block => block.text).join(''))

test('DSH surface export control keeps ordinary append order', () => {
  const source = sourceLog()
  source.open(1)
  source.user('first', 'FIRST')
  source.user('second', 'SECOND')
  source.close(1)
  assert.deepEqual(messageTexts(convertDshToCodex(source.header, source.events, options).drafts), ['FIRST', 'SECOND'])
})

test('DSH export does not revive shadowed messages or archived tool pairs', () => {
  const source = sourceLog()
  source.open(1)
  source.push('system/message', { turn: 1, step: 1, message: { id: 'head', role: 'system', content: [], source: { kind: 'system-prompt' } } }, 'append')
  const first = source.user('original', 'ARCHIVED QUESTION')
  const assistant = source.push('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'old-answer', role: 'assistant',
    source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' },
    content: [{ type: 'text', text: 'ARCHIVED ANSWER' }, { type: 'tool-call', id: 'archived-call', name: 'read', arguments: '{}' }] } }, 'append')
  source.push('tool/call', { turn: 1, step: 1, callId: 'archived-call', name: 'read', arguments: '{}' })
  const result = source.push('tool/result', { turn: 1, step: 1, message: { id: 'old-result', role: 'tool', toolCallId: 'archived-call',
    source: { kind: 'tool', callId: 'archived-call' }, content: [{ type: 'text', text: 'ARCHIVED RESULT' }] } }, 'append')
  source.close(1)
  source.open(2)
  source.user('summary', 'ACTIVE SUMMARY', { op: 'replace', startSeq: first, endSeq: result }, [first, assistant, result])
  source.user('next', 'CONTINUE AFTER SUMMARY')
  source.close(2)
  const converted = convertDshToCodex(source.header, source.events, options)
  assert.deepEqual(messageTexts(converted.drafts), ['ACTIVE SUMMARY', 'CONTINUE AFTER SUMMARY'])
  assert.equal(JSON.stringify(converted.drafts).includes('archived-call'), false)
  assert.equal(source.events.filter(event => ['tool/call', 'tool/result'].includes(event.type)).length, 2, 'Source audit pair remains intact')
})

test('DSH late and consecutive replacements use surface position, not event order', () => {
  const source = sourceLog()
  source.open(1)
  const first = source.user('old', 'OLD')
  source.user('kept', 'KEPT AFTER REPLACED SLOT')
  const intermediate = source.user('intermediate', 'INTERMEDIATE', { op: 'replace', startSeq: first, endSeq: first }, [first])
  source.user('final', 'FINAL', { op: 'replace', startSeq: intermediate, endSeq: intermediate }, [intermediate])
  source.close(1)
  assert.deepEqual(messageTexts(convertDshToCodex(source.header, source.events, options).drafts), ['FINAL', 'KEPT AFTER REPLACED SLOT'])
})

test('DSH export refuses an active projection it cannot interpret', () => {
  const source = sourceLog()
  source.open(1)
  source.user('before', 'BEFORE UNKNOWN PROJECTION')
  source.push('synthetic-plugin/message-projection', { plugin: 'not-installed', opaque: true }, 'append')
  source.close(1)
  assert.throws(() => convertDshToCodex(source.header, source.events, options), /projection|surface|interpret/i)
})

test('DSH export does not treat an unmarked message as a surface member', () => {
  const source = sourceLog()
  source.open(1)
  source.push('user/message', { id: 'audit-only', role: 'user', content: [{ type: 'text', text: 'AUDIT ONLY' }], source: { kind: 'synthetic-context' } })
  source.user('visible', 'VISIBLE')
  source.close(1)
  assert.deepEqual(messageTexts(convertDshToCodex(source.header, source.events, options).drafts), ['VISIBLE'])
})

test('compaction unknown notice carries machine state on the surviving surface node', () => {
  const source = compactedSource('F:\\synthetic-workspace')
  const result = source.find(record => record.payload.type === 'function_call_output')!
  result.payload.recovery = TOOL_OUTCOME_UNKNOWN
  result.payload.isError = true
  const converted = convertCodexToDsh(source, { sessionId: 'unknown-notice', cwd: 'F:\\synthetic-workspace' })
  const notice = converted.events.find(event => event.type === 'user/message' && (event.data as any).source.kind === 'agent-continue-unknown-outcomes')!
  const metadata = (notice.data as any).source
  assert.equal(metadata.recovery, TOOL_OUTCOME_UNKNOWN)
  assert.deepEqual(metadata.pendingOperations, [{ callId: 'archived-call', name: 'read', state: 'unknown' }])
})

test('known native message projections without surfaceOp cannot silently restore original content', () => {
  const source = sourceLog()
  source.user('image', 'ORIGINAL BODY')
  source.push('image/offload', { opaque: 'projection payload' })
  assert.throws(() => convertDshToCodex(source.header, source.events, options), /image\/offload.*projection/i)
})

test('native in-place tool-result rewrites retain identity, error and surface slot', () => {
  const source = compactedSource('F:\\synthetic-workspace')
  source.splice(source.findIndex(record => record.type === 'compacted'), 1)
  source.find(record => record.payload.type === 'function_call_output')!.payload.recovery = TOOL_OUTCOME_UNKNOWN
  const converted = convertCodexToDsh(source, { sessionId: 'in-place', cwd: 'F:\\synthetic-workspace' })
  const original = converted.events.find(event => event.type === 'tool/result')!
  const data = structuredClone(original.data) as JsonObject
  ;(data.message as JsonObject).content = [{ type: 'text', text: 'SHORT UNKNOWN RESULT' }]
  converted.events.push({ ...original, seq: converted.events.length, data,
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
  const back = convertDshToCodex(converted.header, converted.events, options)
  const results = back.drafts.filter(record => record.payload.type === 'function_call_output')
  assert.equal(results.length, 1)
  assert.equal(results[0]!.payload.output, 'SHORT UNKNOWN RESULT')
  assert.equal(results[0]!.payload.recovery, TOOL_OUTCOME_UNKNOWN)
  assert.equal(results[0]!.payload.call_id, 'archived-call')
  assert.ok(!JSON.stringify(back.drafts).includes('ARCHIVED TOOL RESULT'))
  ;(data.message as JsonObject).toolCallId = 'invented-id'
  assert.throws(() => convertDshToCodex(converted.header, converted.events, options), /change only content/i)
})

test('repeated compaction and both return directions keep one active unknown pair and machine notice', () => {
  const source = compactedSource('F:\\synthetic-workspace', ['FIRST SUMMARY', 'FINAL SUMMARY'].map(text => [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  ]))
  source.find(record => record.payload.type === 'function_call_output')!.payload.recovery = TOOL_OUTCOME_UNKNOWN
  const there = convertCodexToDsh(source, { sessionId: 'repeated', cwd: 'F:\\synthetic-workspace' })
  const active = currentSurface(there.events)
  const results = active.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal((results[0]!.data as any).error.code, TOOL_OUTCOME_UNKNOWN)
  assert.equal((results[0]!.data as any).message.toolCallId, 'archived-call')
  const back = convertDshToCodex(there.header, there.events, options)
  assert.deepEqual(messageTexts(back.drafts).slice(0, 1), ['FINAL SUMMARY'])
  assert.equal(back.drafts.filter(record => record.payload.type === 'function_call').length, 1)
  assert.equal(back.drafts.filter(record => record.payload.type === 'function_call_output').length, 1)
  assert.ok(!JSON.stringify(back.drafts).includes('FIRST SUMMARY'))
  const returned = convertCodexToDsh(back.drafts.map((record, ordinal) => ({ ...record, ordinal,
    timestamp: record.timestamp ?? '2026-10-01T00:00:00.000Z' })), { sessionId: 'returned', cwd: 'F:\\synthetic-workspace' })
  const notice = currentSurface(returned.events).find(event => (event.data as any).source?.recovery === TOOL_OUTCOME_UNKNOWN)!
  assert.deepEqual((notice.data as any).source.pendingOperations, [{ callId: 'archived-call', name: 'read', state: 'unknown' }])
})

test('a late system-head replacement stays before user nodes without importing foreign instructions', () => {
  const source = sourceLog()
  const head = source.push('system/message', { message: { content: [], source: { kind: 'system-prompt' } } }, 'append')
  source.user('first', 'USER ONE')
  source.user('second', 'USER TWO')
  source.push('system/message', { message: { content: [{ type: 'text', text: 'FOREIGN SYSTEM' }], source: { kind: 'system-prompt' } } },
    { op: 'replace', startSeq: head, endSeq: head }, [head])
  assert.equal(currentSurface(source.events)[0]!.seq, 3)
  const back = convertDshToCodex(source.header, source.events, options)
  assert.deepEqual(messageTexts(back.drafts), ['USER ONE', 'USER TWO'])
  assert.ok(!JSON.stringify(back.drafts).includes('FOREIGN SYSTEM'))
})

test('malformed replacement provenance refuses migration instead of retaining archived bodies', () => {
  const source = sourceLog()
  const first = source.user('old', 'OLD')
  source.user('new', 'NEW', { op: 'replace', startSeq: first, endSeq: first }, [])
  assert.throws(() => convertDshToCodex(source.header, source.events, options), /provenance/i)
})

test('a legacy unknown notice with only a keyword cannot silently lose its machine state', () => {
  const source = sourceLog()
  source.push('user/message', { role: 'user', id: 'legacy-unknown', content: [{ type: 'text', text: TOOL_OUTCOME_UNKNOWN }],
    source: { kind: 'agent-continue-unknown-outcomes' } }, 'append')
  assert.throws(() => convertDshToCodex(source.header, source.events, options), /machine-readable recovery marker/i)
})

test('active assistant text and tool advertisements keep their content-block order', () => {
  const source = sourceLog()
  source.open(1)
  source.user('question', 'QUESTION')
  source.push('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'mixed', role: 'assistant',
    source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }, content: [
      { type: 'text', text: 'BEFORE CALL' }, { type: 'tool-call', id: 'mixed-call', name: 'read', arguments: '{}' },
      { type: 'text', text: 'AFTER CALL' },
    ] } }, 'append')
  source.push('tool/call', { turn: 1, step: 1, callId: 'mixed-call', name: 'read', arguments: '{}' })
  source.push('tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'tool', toolCallId: 'mixed-call',
    source: { kind: 'tool', callId: 'mixed-call' }, content: [{ type: 'text', text: 'RESULT' }] } }, 'append')
  source.close(1)
  const back = convertDshToCodex(source.header, source.events, options)
  assert.deepEqual(back.drafts.filter(record => record.type === 'response_item').map(record => record.payload.type === 'message'
    ? (record.payload.content as JsonObject[]).map(block => block.text).join('') : record.payload.type),
  ['QUESTION', 'BEFORE CALL', 'function_call', 'AFTER CALL', 'function_call_output'])
  assert.equal(back.tallies['message.content-blocks']?.dropped ?? 0, 0)
})

test('archived unknown errors cannot substitute for a missing active machine carrier', () => {
  const source = compactedSource('F:\\synthetic-workspace')
  source.find(record => record.payload.type === 'function_call_output')!.payload.recovery = TOOL_OUTCOME_UNKNOWN
  const there = convertCodexToDsh(source, { sessionId: 'missing-carrier', cwd: 'F:\\synthetic-workspace' })
  const active = currentSurface(there.events).filter(event => event.type !== 'system/message')
  there.events.push({ type: 'user/message', seq: there.events.length, time: there.header.createdAt,
    data: { id: 'text-only-summary', role: 'user', content: [{ type: 'text', text: 'UNKNOWN TEXT IS NOT MACHINE STATE' }],
      source: { kind: 'synthetic-summary' } },
    surfaceOp: { op: 'replace', startSeq: active[0]!.seq, endSeq: active.at(-1)!.seq }, sourceEventSeqs: active.map(event => event.seq) })
  assert.throws(() => convertDshToCodex(there.header, there.events, options), /machine-readable carrier.*current DSH surface/i)
})
