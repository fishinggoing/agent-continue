/**
 * Converter unit tests.
 *
 * The real-data migrations live in `migrate-*.test.ts`; these pin the mapping
 * rules themselves, including the rules that were learned the hard way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import type { RolloutRecord } from '../../codex-adapter/src/rollout.ts'
import { parseSessionLog, serializeSessionLog, type SessionEvent, type SessionHeader } from '../../dsh-adapter/src/format.ts'
import { convertCodexToDsh } from '../src/codex-to-dsh.ts'
import { convertDshToCodex } from '../src/dsh-to-codex.ts'

const dshHeader: SessionHeader = {
  type: 'session', version: 4, id: 'dsh-source', createdAt: 1_780_000_000_000,
  cwd: 'F:\\proj', isSeeded: false, delegationDepth: 0,
}

test('maps Codex records onto DSH events', () => {
  const records = parseRollout([
    { timestamp: '2026-06-01T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'c1', cwd: 'F:\\proj', model_provider: 'example-provider' } },
    { timestamp: '2026-06-01T00:00:01.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 1_780_000_000 } },
    { timestamp: '2026-06-01T00:00:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'q' }] } },
    { timestamp: '2026-06-01T00:00:02.500Z', ordinal: 3, type: 'turn_context', payload: { turn_id: 't1', model: 'example-model' } },
    { timestamp: '2026-06-01T00:00:03.000Z', ordinal: 4, type: 'response_item', payload: { type: 'function_call', id: 'f1', call_id: 'c-1', name: 'shell', arguments: '{"cmd":"ls"}' } },
    { timestamp: '2026-06-01T00:00:04.000Z', ordinal: 5, type: 'response_item', payload: { type: 'function_call_output', id: 'f2', call_id: 'c-1', output: 'ok' } },
    { timestamp: '2026-06-01T00:00:05.000Z', ordinal: 6, type: 'response_item', payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] } },
    { timestamp: '2026-06-01T00:00:06.000Z', ordinal: 7, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', started_at: 1_780_000_000, completed_at: 1_780_000_006 } },
  ].map((record) => JSON.stringify(record)).join('\n')).records as RolloutRecord[]

  const conversion = convertCodexToDsh(records, { sessionId: 'migrated', cwd: 'F:\\proj' })
  const kinds = conversion.events.map((event) => event.type)

  assert.deepEqual(kinds, [
    'turn/start',
    'step/start',
    'user/message',
    // v4 requires a tool call to be advertised by an assistant message before its
    // `tool/call`, so the converter inserts one (D3).
    'assistant/message',
    'tool/call',
    'tool/result',
    'assistant/message',
    'step/end',
    'turn/end',
  ])
  // The producer is recorded verbatim rather than rewritten to a DSH provider.
  const assistant = conversion.events.filter((event) => event.type === 'assistant/message').at(-1)!
  const source = (assistant.data as { message: { source: { provider: string; model: string } } }).message.source
  assert.equal(source.provider, 'example-provider')
  assert.equal(source.model, 'example-model')

  // The advertisement must match the call exactly: id, name, and arguments are
  // compared with `!==` by DSH's validator.
  const advertisement = conversion.events.find((event) => event.type === 'assistant/message')!
  const blocks = (advertisement.data as { message: { content: { type: string; id: string; name: string; arguments: string }[] } }).message.content
  assert.deepEqual(blocks, [{ type: 'tool-call', id: 'c-1', name: 'shell', arguments: '{"cmd":"ls"}' }])
  const call = conversion.events.find((event) => event.type === 'tool/call')!
  assert.equal((call.data as { callId: string }).callId, blocks[0]!.id)
  assert.equal((call.data as { arguments: string }).arguments, blocks[0]!.arguments)

  // The produced log satisfies the rules DSH enforces on load.
  assert.doesNotThrow(() => parseSessionLog(serializeSessionLog(conversion.header, conversion.events), 4))
})

test('drops Codex reasoning, developer context and aborted turns with a reason', () => {
  const text = [
    { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { id: 'c1', cwd: 'F:\\proj' } },
    { timestamp: 't', ordinal: 1, type: 'response_item', payload: { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'xxx' } },
    { timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'd1', role: 'developer', content: [{ type: 'input_text', text: 'env' }] } },
    { timestamp: 't', ordinal: 3, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage' } } },
  ].map((record) => JSON.stringify(record)).join('\n')

  const conversion = convertCodexToDsh(parseRollout(text).records, { sessionId: 'x', cwd: 'F:\\proj' })
  assert.equal(conversion.tallies['response_item/reasoning']?.dropped, 1)
  assert.equal(conversion.tallies['response_item/message']?.dropped, 1)
  assert.equal(conversion.tallies['event_msg/item_completed']?.dropped, 1)
  assert.equal(conversion.losses.length, 3)
  assert.match(conversion.losses.join('\n'), /encrypted/)
})

test('maps DSH events onto Codex records and keys session_meta by thread id', () => {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1_780_000_000_000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1_780_000_000_001, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1_780_000_000_002, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 3, time: 1_780_000_000_003, data: { turn: 1, step: 1, callId: 'c-1', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', seq: 4, time: 1_780_000_000_004, data: { turn: 1, step: 1, message: { id: 't1', role: 'tool', source: { kind: 'tool', callId: 'c-1' }, content: [{ type: 'text', text: 'ok' }] } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 5, time: 1_780_000_000_005, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'a' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } }, stream: [] }, surfaceOp: 'append' },
    { type: 'step/end', seq: 6, time: 1_780_000_000_006, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: 1_780_000_000_007, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  const conversion = convertDshToCodex(dshHeader, events, { cliVersion: '9.9.9', threadId: 'thread-uuid' })
  const meta = conversion.drafts[0]!
  assert.equal(meta.type, 'session_meta')
  assert.equal((meta.payload as { id: string }).id, 'thread-uuid', 'session_meta.id must be the registered thread id')
  assert.equal((meta.payload as { cli_version: string }).cli_version, '9.9.9')
  assert.equal((meta.payload as { model_provider: string }).model_provider, 'deepseek-official')

  const kinds = conversion.drafts.slice(1).map((draft) => `${draft.type}/${String((draft.payload as { type?: string }).type ?? '')}`)
  assert.deepEqual(kinds, [
    'event_msg/task_started',
    'turn_context/',
    'response_item/message',
    'event_msg/item_completed',
    'response_item/function_call',
    'response_item/function_call_output',
    'response_item/message',
    'event_msg/item_completed',
    'event_msg/task_complete',
  ])
  // Steps have no Codex counterpart and are reported, not silently dropped.
  assert.equal(conversion.tallies['step/start']?.dropped, 1)
  assert.equal(conversion.tallies['step/end']?.dropped, 1)
})

test('reports DSH-private events as losses instead of inventing records', () => {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1_780_000_000_000, data: { turn: 1 } },
    { type: 'request/header', seq: 1, time: 1_780_000_000_001, data: { header: { config: { provider: 'x', model: 'y' } } } },
    { type: 'agent/inbox/spliced', seq: 2, time: 1_780_000_000_002, data: {} },
    { type: 'turn/end', seq: 3, time: 1_780_000_000_003, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const conversion = convertDshToCodex(dshHeader, events, { cliVersion: '1.0.0' })
  assert.equal(conversion.tallies['request/header']?.dropped, 1)
  assert.equal(conversion.tallies['agent/inbox/spliced']?.dropped, 1)
  assert.ok(conversion.losses.some((line) => line.includes('request/header')))
})

/**
 * Regression for Codex's P1 report: Codex user text was silently lost on a full
 * round trip. `codex-to-dsh` passed `input_text` through verbatim, so the DSH
 * log carried a foreign block type that `dsh-to-codex` then refused to read back.
 * Real DSH accepted and resumed that artifact, so nothing complained.
 */
test('preserves user and assistant text across a full round trip', () => {
  const codexRecords = parseRollout([
    { timestamp: '2026-06-01T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'rt', cwd: 'F:\\proj', model_provider: 'example-provider' } },
    { timestamp: '2026-06-01T00:00:01.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 1_780_000_000 } },
    { timestamp: '2026-06-01T00:00:02.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'ROUND TRIP QUESTION' }] } },
    { timestamp: '2026-06-01T00:00:03.000Z', ordinal: 3, type: 'turn_context', payload: { turn_id: 't1', model: 'example-model' } },
    { timestamp: '2026-06-01T00:00:04.000Z', ordinal: 4, type: 'response_item', payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'ROUND TRIP ANSWER' }] } },
    { timestamp: '2026-06-01T00:00:05.000Z', ordinal: 5, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', started_at: 1_780_000_000, completed_at: 1_780_000_005 } },
  ].map((record) => JSON.stringify(record)).join('\n')).records

  const there = convertCodexToDsh(codexRecords, { sessionId: 'round-trip', cwd: 'F:\\proj' })

  // Codex's `input_text` must be normalized to the block type DSH actually uses.
  const userEvent = there.events.find((event) => event.type === 'user/message')!
  assert.deepEqual((userEvent.data as { content: unknown }).content, [{ type: 'text', text: 'ROUND TRIP QUESTION' }])
  const assistantEvent = there.events.find((event) => event.type === 'assistant/message')!
  const assistantMessage = (assistantEvent.data as { message: { content: unknown } }).message
  assert.deepEqual(assistantMessage.content, [{ type: 'text', text: 'ROUND TRIP ANSWER' }])

  const back = convertDshToCodex(there.header, there.events, { cliVersion: '1.0.0', threadId: 'rt-uuid' })
  const serialized = back.drafts.map((draft) => JSON.stringify(draft)).join('\n')
  assert.ok(serialized.includes('ROUND TRIP QUESTION'), 'user text survives the round trip')
  assert.ok(serialized.includes('ROUND TRIP ANSWER'), 'assistant text survives the round trip')
  assert.equal(serialized.includes('input_text'), true, 'user blocks are emitted as input_text')
  assert.equal(serialized.includes('output_text'), true, 'assistant blocks are emitted as output_text')

  // Neither leg may claim a clean mapping while dropping blocks.
  assert.equal(there.tallies['message.content-blocks']?.dropped ?? 0, 0)
  assert.equal(back.tallies['message.content-blocks']?.dropped ?? 0, 0)
  assert.deepEqual(there.losses.filter((line) => line.includes('content-blocks')), [])
  assert.deepEqual(back.losses.filter((line) => line.includes('content-blocks')), [])
})

test('reports dropped content blocks instead of claiming a clean mapping', () => {
  const codexRecords = parseRollout([
    { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { id: 'x', cwd: 'F:\\proj' } },
    { timestamp: 't', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'kept' }, { type: 'input_image', image_url: 'data:...' }] } },
  ].map((record) => JSON.stringify(record)).join('\n')).records

  const conversion = convertCodexToDsh(codexRecords, { sessionId: 'blocks', cwd: 'F:\\proj' })
  assert.equal(conversion.tallies['message.content-blocks']?.dropped, 1, 'the image block is counted as lost')
  assert.ok(conversion.losses.some((line) => line.includes('content-blocks')), 'the loss is reported to the caller')

  // And the DSH side still receives the text block it can read.
  const userEvent = conversion.events.find((event) => event.type === 'user/message')!
  assert.deepEqual((userEvent.data as { content: unknown }).content, [{ type: 'text', text: 'kept' }])
})

/** Build a Codex rollout fixture from raw record objects. */
function rolloutOf(records: Record<string, unknown>[]): RolloutRecord[] {
  return parseRollout(records.map((record) => JSON.stringify(record)).join('\n')).records as RolloutRecord[]
}

/**
 * D4: a started call with no result must leave the step and turn open.
 *
 * DSH rejects a closer that spans an unresolved started call, and its own
 * recovery is what supplies the honest `TOOL_OUTCOME_UNKNOWN` result. Closing
 * the turn here would either be refused or force us to invent an outcome.
 */
test('leaves the tail open when a tool call never finished', () => {
  const records = rolloutOf([
    { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { id: 'open', cwd: 'F:\\proj' } },
    { timestamp: 't', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'function_call', id: 'f1', call_id: 'c-1', name: 'shell', arguments: '{}' } },
    // No `function_call_output` follows: the process died mid-call.
  ])

  const conversion = convertCodexToDsh(records, { sessionId: 'open', cwd: 'F:\\proj' })
  const kinds = conversion.events.map((event) => event.type)
  assert.ok(kinds.includes('tool/call'), 'the call is recorded')
  assert.ok(!kinds.includes('step/end'), 'the step stays open for DSH recovery to close')
  assert.ok(!kinds.includes('turn/end'), 'the turn stays open for DSH recovery to close')
})

test('leaves the tail open when only one of two parallel calls finished', () => {
  const records = rolloutOf([
    { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { id: 'partial', cwd: 'F:\\proj' } },
    { timestamp: 't', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'function_call', id: 'f1', call_id: 'c-1', name: 'a', arguments: '{}' } },
    { timestamp: 't', ordinal: 3, type: 'response_item', payload: { type: 'function_call', id: 'f2', call_id: 'c-2', name: 'b', arguments: '{}' } },
    { timestamp: 't', ordinal: 4, type: 'response_item', payload: { type: 'function_call_output', id: 'o1', call_id: 'c-1', output: 'done' } },
  ])

  const conversion = convertCodexToDsh(records, { sessionId: 'partial', cwd: 'F:\\proj' })
  const kinds = conversion.events.map((event) => event.type)
  assert.equal(kinds.filter((kind) => kind === 'tool/call').length, 2, 'both calls are recorded')
  assert.ok(!kinds.includes('turn/end'), 'the unfinished call keeps the turn open')

  // Both parallel calls are advertised by one assistant message, or DSH would
  // reject the second with "has no advertised tool lifecycle".
  const advertisements = conversion.events.filter((event) => event.type === 'assistant/message')
  assert.equal(advertisements.length, 1, 'one advertisement covers the parallel run')
  const blocks = (advertisements[0]!.data as { message: { content: { id: string }[] } }).message.content
  assert.deepEqual(blocks.map((block) => block.id), ['c-1', 'c-2'])
})

/**
 * D5: the unknown-outcome marker has to survive a full round trip.
 *
 * DSH's recovery writes `error.code = TOOL_OUTCOME_UNKNOWN`; without an explicit
 * marker the Codex side reads the call as settled. A plain known failure and a
 * `TOOL_NOT_STARTED` repair are both *not* unknown and must not be marked.
 */
test('carries the unknown tool outcome across both directions', () => {
  const time = 1_780_000_000_000
  const toolResult = (errorCode: string | undefined, isError: boolean): SessionEvent[] => [
    { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 2, time,
      data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'c-1', name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] },
      surfaceOp: 'append',
    },
    { type: 'tool/call', seq: 3, time, data: { turn: 1, step: 1, callId: 'c-1', name: 'bash', arguments: '{}' } },
    {
      type: 'tool/result', seq: 4, time,
      data: {
        turn: 1, step: 1,
        message: { id: 't1', role: 'tool', toolCallId: 'c-1', source: { kind: 'tool', callId: 'c-1' }, content: [{ type: 'text', text: 'interrupted' }], isError },
        ...(errorCode === undefined ? {} : { error: { name: 'ToolOutcomeUnknownError', code: errorCode } }),
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 5, time, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  const outputPayload = (events: SessionEvent[]): Record<string, unknown> => {
    const conversion = convertDshToCodex(dshHeader, events, { cliVersion: '1.0.0', threadId: 'rt' })
    const record = conversion.drafts.find((draft) => draft.type === 'response_item'
      && (draft.payload as { type?: string }).type === 'function_call_output')
    assert.ok(record !== undefined, 'a function_call_output was produced')
    return record.payload as Record<string, unknown>
  }

  const unknown = outputPayload(toolResult('TOOL_OUTCOME_UNKNOWN', true))
  assert.equal(unknown.isError, true)
  assert.equal(unknown.recovery, 'TOOL_OUTCOME_UNKNOWN', 'the unknown marker is explicit')
  assert.equal(unknown.call_id, 'c-1', 'the call id is preserved alongside the marker')

  // A known failure is an error but not an unknown outcome.
  const failed = outputPayload(toolResult(undefined, true))
  assert.equal(failed.isError, true)
  assert.equal(failed.recovery, undefined, 'a known failure carries no recovery marker')

  // A not-started repair means the call never ran; that is not "unknown outcome" either.
  const notStarted = outputPayload(toolResult('TOOL_NOT_STARTED', true))
  assert.equal(notStarted.recovery, undefined, 'TOOL_NOT_STARTED is not an unknown outcome')

  // Reverse: the marker must come back as DSH's unknown error, not as a success.
  const backRecords = rolloutOf([
    { timestamp: 't', ordinal: 0, type: 'session_meta', payload: { id: 'b', cwd: 'F:\\proj' } },
    { timestamp: 't', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: 't', ordinal: 2, type: 'response_item', payload: { type: 'function_call', id: 'f1', call_id: 'c-1', name: 'bash', arguments: '{}' } },
    { timestamp: 't', ordinal: 3, type: 'response_item', payload: { type: 'function_call_output', id: 'o1', call_id: 'c-1', output: 'interrupted', isError: true, recovery: 'TOOL_OUTCOME_UNKNOWN' } },
  ])
  const back = convertCodexToDsh(backRecords, { sessionId: 'back', cwd: 'F:\\proj' })
  const result = back.events.find((event) => event.type === 'tool/result')!
  const resultData = result.data as { message: { isError?: boolean }; error?: { code?: string } }
  assert.equal(resultData.message.isError, true, 'the reverse keeps it an error')
  assert.equal(resultData.error?.code, 'TOOL_OUTCOME_UNKNOWN', 'the reverse restores the unknown code')
  assert.doesNotThrow(() => parseSessionLog(serializeSessionLog(back.header, back.events), 4))
})
