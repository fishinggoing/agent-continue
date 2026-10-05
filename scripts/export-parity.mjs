#!/usr/bin/env node

/**
 * Export deterministic synthetic migration cases from the TypeScript oracle.
 *
 * This is deliberately a development-only script.  The committed JSON files
 * are consumed by the Go parity tests; the Go package never invokes Node.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { convertCodexToDsh } from '../packages/contract/src/codex-to-dsh.ts'
import { convertDshToCodex } from '../packages/contract/src/dsh-to-codex.ts'
import { TOOL_OUTCOME_UNKNOWN } from '../packages/contract/src/conventions.ts'
import { USAGE_CASES, usageRecords } from '../packages/contract/tests/usage-fixtures.ts'
import { compactedSource } from '../packages/contract/tests/compaction-fixture.ts'

const OUT = join(import.meta.dirname, '..', 'internal', 'migrate', 'testdata')
const TIME = '2026-10-01T02:00:00.000Z'
const CREATED = Date.parse(TIME)
const CWD = 'F:\\synthetic-workspace'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi

function record(type, payload, ordinal, timestamp = TIME) {
  return { timestamp, ordinal, type, payload }
}

function rollout(payloads) {
  return payloads.map((entry, ordinal) => record(entry.type, entry.payload, ordinal, entry.timestamp ?? TIME))
}

function dshHeader(id = 'synthetic-dsh', cwd = CWD, extra = {}) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: CREATED,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    ...extra,
  }
}

function event(type, seq, data, surfaceOp, sourceEventSeqs, time = CREATED + seq) {
  return {
    type,
    seq,
    time,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

function dshLog(builder) {
  const events = []
  const push = (type, data, surfaceOp, sourceEventSeqs) => {
    const seq = events.length
    events.push(event(type, seq, data, surfaceOp, sourceEventSeqs))
    return seq
  }
  builder({ events, push })
  return { header: dshHeader(), events }
}

function message(type, role, id, text, source = { kind: role === 'user' ? 'user' : 'model' }) {
  return {
    type,
    id,
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    source,
  }
}

function codexBasic() {
  return rollout([
    { type: 'session_meta', payload: { id: 'codex-basic', cwd: CWD, model_provider: 'synthetic-provider' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-basic', started_at: Math.floor(CREATED / 1000) } },
    { type: 'turn_context', payload: { turn_id: 'turn-basic', model: 'synthetic-model' } },
    { type: 'response_item', payload: { type: 'message', id: 'u-basic', role: 'user', content: [{ type: 'input_text', text: '你好，世界 🌍' }] } },
    { type: 'response_item', payload: { type: 'function_call', id: 'fc-read', call_id: 'call-read', name: 'read_file', arguments: '{"path":"目录/файл.txt","emoji":"🧪"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', id: 'fco-read', call_id: 'call-read', output: '内容：雪 ☃️', isError: false } },
    { type: 'response_item', payload: { type: 'message', id: 'a-basic', role: 'assistant', content: [{ type: 'output_text', text: '完成了 ✅' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-basic' } },
  ])
}

function codexParallelLater() {
  return rollout([
    { type: 'session_meta', payload: { id: 'codex-parallel', cwd: CWD, model_provider: 'synthetic-provider' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-one', started_at: Math.floor(CREATED / 1000) } },
    { type: 'response_item', payload: { type: 'message', id: 'u-one', role: 'user', content: [{ type: 'input_text', text: '先并行检查两个文件' }] } },
    { type: 'response_item', payload: { type: 'function_call', id: 'fc-a', call_id: 'call-a', name: 'read_a', arguments: '{"path":"a.txt"}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'fc-b', call_id: 'call-b', name: 'custom_lookup', input: { query: 'βeta', limit: 2 } } },
    { type: 'response_item', payload: { type: 'function_call_output', id: 'fco-a', call_id: 'call-a', output: 'A 完成' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-one' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-two', started_at: Math.floor((CREATED + 10_000) / 1000) } },
    { type: 'response_item', payload: { type: 'message', id: 'u-two', role: 'user', content: [{ type: 'input_text', text: '继续处理后续步骤' }] } },
    { type: 'response_item', payload: { type: 'message', id: 'a-two', role: 'assistant', content: [{ type: 'output_text', text: '第二轮仍然保留。' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-two' } },
  ])
}

function codexPendingTail() {
  return rollout([
    { type: 'session_meta', payload: { id: 'codex-pending', cwd: CWD, model_provider: 'synthetic-provider' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-pending', started_at: Math.floor(CREATED / 1000) } },
    { type: 'response_item', payload: { type: 'function_call', id: 'fc-pending', call_id: 'call-pending', name: 'shell', arguments: '{"command":"echo 保留"}' } },
  ])
}

function codexUnknownCarrier() {
  return rollout([
    { type: 'session_meta', payload: { id: 'codex-unknown', cwd: CWD, model_provider: 'synthetic-provider' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-unknown', started_at: Math.floor(CREATED / 1000) } },
    { type: 'response_item', payload: { type: 'message', id: 'u-unknown', role: 'user', content: [{ type: 'input_text', text: '检查未知结果' }], recovery: TOOL_OUTCOME_UNKNOWN, pending_operations: [{ callId: 'call-unknown', name: 'write_file', state: 'unknown' }] } },
    { type: 'response_item', payload: { type: 'function_call', id: 'fc-unknown', call_id: 'call-unknown', name: 'write_file', arguments: '{"path":"结果.txt","text":"保留"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', id: 'fco-unknown', call_id: 'call-unknown', output: 'interrupted', isError: true, recovery: TOOL_OUTCOME_UNKNOWN } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-unknown' } },
  ])
}

function codexCompaction() {
  return compactedSource(CWD, [
    [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '压缩后的当前摘要：阶段二待处理。' }] }],
    [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '最终摘要：保留 Unicode ☕' }] }],
  ])
}

function codexSummaryCompaction() {
  return rollout([
    { type: 'session_meta', payload: { id: 'codex-summary-compaction', cwd: CWD, model_provider: 'synthetic-provider' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'summary-before', started_at: Math.floor(CREATED / 1000) } },
    { type: 'response_item', payload: { type: 'message', id: 'summary-question', role: 'user', content: [{ type: 'input_text', text: '压缩前的问题' }] } },
    { type: 'response_item', payload: { type: 'message', id: 'summary-answer', role: 'assistant', content: [{ type: 'output_text', text: '压缩前的答案' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'summary-before' } },
    { type: 'compacted', payload: { message: '只含纯文本的压缩摘要：继续工作 ☕' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'summary-after', started_at: Math.floor((CREATED + 10_000) / 1000) } },
    { type: 'response_item', payload: { type: 'message', id: 'summary-followup', role: 'user', content: [{ type: 'input_text', text: '摘要之后的问题' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'summary-after' } },
  ])
}

function dshCompletedParallel() {
  return dshLog(({ push }) => {
    push('turn/start', { turn: 1 })
    push('step/start', { turn: 1, step: 1 })
    push('user/message', { id: 'dsh-user-1', role: 'user', content: [{ type: 'text', text: '同时读取两个文件' }], source: { kind: 'user' } }, 'append')
    push('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: {
        id: 'dsh-assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' },
        content: [
          { type: 'text', text: '开始并行读取：' },
          { type: 'tool-call', id: 'call-a', name: 'read_a', arguments: '{"path":"甲.txt"}' },
          { type: 'tool-call', id: 'call-b', name: 'read_b', arguments: '{"path":"乙.txt","emoji":"🧭"}' },
        ],
      },
    }, 'append')
    push('tool/call', { turn: 1, step: 1, callId: 'call-a', name: 'read_a', arguments: '{"path":"甲.txt"}' })
    push('tool/call', { turn: 1, step: 1, callId: 'call-b', name: 'read_b', arguments: '{"path":"乙.txt","emoji":"🧭"}' })
    push('tool/result', {
      turn: 1,
      step: 1,
      message: { id: 'result-a', role: 'tool', toolCallId: 'call-a', source: { kind: 'tool', callId: 'call-a' }, content: [{ type: 'text', text: '甲：完成' }] },
    }, 'append')
    push('tool/result', {
      turn: 1,
      step: 1,
      message: { id: 'result-b', role: 'tool', toolCallId: 'call-b', source: { kind: 'tool', callId: 'call-b' }, content: [{ type: 'text', text: '乙：完成' }] },
    }, 'append')
    push('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: { id: 'dsh-assistant-final', role: 'assistant', source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }, content: [{ type: 'text', text: '两项都完成。' }] },
    }, 'append')
    push('step/end', { turn: 1, step: 1 })
    push('turn/end', { turn: 1, reason: { kind: 'completed' } })
    push('turn/start', { turn: 2 })
    push('step/start', { turn: 2, step: 1 })
    push('user/message', { id: 'dsh-user-2', role: 'user', content: [{ type: 'text', text: '后续问题' }], source: { kind: 'user' } }, 'append')
    push('assistant/message', {
      turn: 2,
      step: 1,
      stream: [],
      message: { id: 'dsh-assistant-2', role: 'assistant', source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }, content: [{ type: 'text', text: '后续回答。' }] },
    }, 'append')
    push('step/end', { turn: 2, step: 1 })
    push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  })
}

function dshSurfaceReplacement() {
  return dshLog(({ push }) => {
    push('turn/start', { turn: 1 })
    push('step/start', { turn: 1, step: 1 })
    push('system/message', { turn: 1, step: 1, message: { id: 'head', role: 'system', content: [], source: { kind: 'system-prompt' } } }, 'append')
    const original = push('user/message', { id: 'old-user', role: 'user', content: [{ type: 'text', text: '旧问题' }], source: { kind: 'user' } }, 'append')
    const oldAssistant = push('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'old-answer', role: 'assistant', source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }, content: [{ type: 'text', text: '旧答案' }] } }, 'append')
    const replacement = push('user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: 'ACTIVE SUMMARY：继续任务' }], source: { kind: 'synthetic-compaction' } }, { op: 'replace', startSeq: original, endSeq: oldAssistant }, [original, oldAssistant])
    push('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'active-answer', role: 'assistant', source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }, content: [{ type: 'text', text: 'ACTIVE ANSWER' }] } }, 'append')
    push('step/end', { turn: 1, step: 1 })
    push('turn/end', { turn: 1, reason: { kind: 'completed' } })
    void replacement
  })
}

function dshUnknown() {
  return dshLog(({ push }) => {
    push('turn/start', { turn: 1 })
    push('step/start', { turn: 1, step: 1 })
    push('user/message', {
      id: 'unknown-notice',
      role: 'user',
      content: [{ type: 'text', text: '已记录未知工具结果' }],
      source: {
        kind: 'agent-continue-unknown-outcomes',
        recovery: TOOL_OUTCOME_UNKNOWN,
        pendingOperations: [{ callId: 'call-unknown', name: 'write_file', state: 'unknown' }],
      },
    }, 'append')
    push('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: { id: 'unknown-advertisement', role: 'assistant', source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }, content: [{ type: 'tool-call', id: 'call-unknown', name: 'write_file', arguments: '{"path":"结果.txt","text":"保留"}' }] },
    }, 'append')
    push('tool/call', { turn: 1, step: 1, callId: 'call-unknown', name: 'write_file', arguments: '{"path":"结果.txt","text":"保留"}' })
    push('tool/result', {
      turn: 1,
      step: 1,
      message: { id: 'unknown-result', role: 'tool', toolCallId: 'call-unknown', source: { kind: 'tool', callId: 'call-unknown' }, content: [{ type: 'text', text: '结果未知' }], isError: true },
      error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
    }, 'append')
    push('step/end', { turn: 1, step: 1 })
    push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })
}

function dshKnownFailure() {
  return dshLog(({ push }) => {
    push('turn/start', { turn: 1 })
    push('step/start', { turn: 1, step: 1 })
    push('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'failure-advertisement', role: 'assistant', source: { kind: 'model', provider: 'synthetic-provider', model: 'synthetic-model' }, content: [{ type: 'tool-call', id: 'call-failure', name: 'read', arguments: '{}' }] } }, 'append')
    push('tool/call', { turn: 1, step: 1, callId: 'call-failure', name: 'read', arguments: '{}' })
    push('tool/result', { turn: 1, step: 1, message: { id: 'failure-result', role: 'tool', toolCallId: 'call-failure', source: { kind: 'tool', callId: 'call-failure' }, content: [{ type: 'text', text: 'known failure' }], isError: true } }, 'append')
    push('step/end', { turn: 1, step: 1 })
    push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })
}

function dshWithProjection(type, withSurface = true) {
  return dshLog(({ push }) => {
    push('turn/start', { turn: 1 })
    push('step/start', { turn: 1, step: 1 })
    push(type, { opaque: 'projection payload' }, withSurface ? 'append' : undefined)
  })
}

function cases() {
  const result = [
    {
      name: 'codex-basic-tools-unicode',
      direction: 'codex-to-dsh',
      input: { records: codexBasic(), options: { sessionId: 'dsh-basic', cwd: CWD, createdAt: CREATED } },
    },
    {
      name: 'codex-parallel-custom-later-turn',
      direction: 'codex-to-dsh',
      input: { records: codexParallelLater(), options: { sessionId: 'dsh-parallel', cwd: CWD, createdAt: CREATED } },
    },
    {
      name: 'codex-pending-tail',
      direction: 'codex-to-dsh',
      input: { records: codexPendingTail(), options: { sessionId: 'dsh-pending', cwd: CWD, createdAt: CREATED } },
    },
    {
      name: 'codex-machine-unknown',
      direction: 'codex-to-dsh',
      input: { records: codexUnknownCarrier(), options: { sessionId: 'dsh-unknown', cwd: CWD, createdAt: CREATED } },
    },
    {
      name: 'codex-compaction-snapshots-summary',
      direction: 'codex-to-dsh',
      input: { records: codexCompaction(), options: { sessionId: 'dsh-compaction', cwd: CWD, createdAt: CREATED } },
    },
    {
      name: 'codex-compaction-legacy-summary',
      direction: 'codex-to-dsh',
      input: { records: codexSummaryCompaction(), options: { sessionId: 'dsh-summary-compaction', cwd: CWD, createdAt: CREATED } },
    },
    {
      name: 'dsh-completed-parallel-later-turns',
      direction: 'dsh-to-codex',
      input: { ...dshCompletedParallel(), options: { cliVersion: 'synthetic-cli', threadId: 'codex-parallel', modelProvider: 'synthetic-provider', startedAt: TIME } },
    },
    {
      name: 'dsh-surface-replacement-summary',
      direction: 'dsh-to-codex',
      input: { ...dshSurfaceReplacement(), options: { cliVersion: 'synthetic-cli', threadId: 'codex-summary', modelProvider: 'synthetic-provider', startedAt: TIME } },
    },
    {
      name: 'dsh-machine-unknown',
      direction: 'dsh-to-codex',
      input: { ...dshUnknown(), options: { cliVersion: 'synthetic-cli', threadId: 'codex-unknown', modelProvider: 'synthetic-provider', startedAt: TIME } },
    },
    {
      name: 'dsh-known-failure',
      direction: 'dsh-to-codex',
      input: { ...dshKnownFailure(), options: { cliVersion: 'synthetic-cli', threadId: 'codex-failure', modelProvider: 'synthetic-provider', startedAt: TIME } },
    },
    {
      name: 'refuse-codex-relative-source-cwd',
      direction: 'codex-to-dsh',
      input: { records: codexBasic(), options: { sessionId: 'refuse-source', cwd: CWD, createdAt: CREATED } },
      mutate(input) { input.records[0].payload.cwd = 'relative/source' },
    },
    {
      name: 'refuse-codex-relative-target-cwd',
      direction: 'codex-to-dsh',
      input: { records: codexBasic(), options: { sessionId: 'refuse-target', cwd: 'relative/target', createdAt: CREATED } },
    },
    {
      name: 'refuse-dsh-image-projection',
      direction: 'dsh-to-codex',
      input: { ...dshWithProjection('image/offload'), options: { cliVersion: 'synthetic-cli', threadId: 'refuse-image', startedAt: TIME } },
    },
    {
      name: 'refuse-dsh-unsupported-projection',
      direction: 'dsh-to-codex',
      input: { ...dshWithProjection('synthetic-plugin/message-projection'), options: { cliVersion: 'synthetic-cli', threadId: 'refuse-projection', startedAt: TIME } },
    },
    {
      name: 'refuse-dsh-origin-subagent',
      direction: 'dsh-to-codex',
      input: { ...dshKnownFailure(), options: { cliVersion: 'synthetic-cli', threadId: 'refuse-origin', startedAt: TIME } },
      mutate(input) { input.header.origin = 'subagent' },
    },
    {
      name: 'refuse-dsh-parent-session',
      direction: 'dsh-to-codex',
      input: { ...dshKnownFailure(), options: { cliVersion: 'synthetic-cli', threadId: 'refuse-parent', startedAt: TIME } },
      mutate(input) { input.header.parentSession = 'parent-session' },
    },
  ]

  for (const scenario of USAGE_CASES) {
    result.push({
      name: `codex-usage-${scenario.name.replaceAll(' ', '-')}`,
      direction: 'codex-to-dsh',
      input: { records: usageRecords(CWD, scenario.source), options: { sessionId: 'dsh-usage', cwd: CWD, createdAt: CREATED } },
    })
  }
  result.push({
    name: 'codex-usage-alternative-field',
    direction: 'codex-to-dsh',
    input: { records: usageRecords(CWD, { input_tokens: 12, output_tokens: 4 }, 'usage'), options: { sessionId: 'dsh-usage-alt', cwd: CWD, createdAt: CREATED } },
  })
  return result
}

function run(scenario) {
  const input = structuredClone(scenario.input)
  scenario.mutate?.(input)
  try {
    const conversion = scenario.direction === 'codex-to-dsh'
      ? convertCodexToDsh(input.records, input.options)
      : convertDshToCodex(input.header, input.events, input.options)
    return { input, expected: conversion }
  } catch (error) {
    return { input, expectedError: String(error?.message ?? error) }
  }
}

function normalizeGeneratedUUIDs(value) {
  const ids = new Map()
  let next = 1
  const walk = (current) => {
    if (Array.isArray(current)) return current.map(walk)
    if (current !== null && typeof current === 'object') {
      return Object.fromEntries(Object.keys(current).sort().map((key) => [key, walk(current[key])]))
    }
    if (typeof current !== 'string') return current
    return current.replace(UUID, (id) => {
      if (!ids.has(id)) ids.set(id, `<uuid-${next++}>`)
      return ids.get(id)
    })
  }
  return walk(value)
}

await mkdir(OUT, { recursive: true })
for (const scenario of cases()) {
  const result = run(scenario)
  const output = {
    name: scenario.name,
    direction: scenario.direction,
    input: result.input,
    ...(result.expected === undefined ? { expectedError: result.expectedError } : { expected: normalizeGeneratedUUIDs(result.expected) }),
  }
  await writeFile(join(OUT, `${scenario.name}.json`), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
}
console.log(`exported ${cases().length} parity cases to ${OUT}`)
