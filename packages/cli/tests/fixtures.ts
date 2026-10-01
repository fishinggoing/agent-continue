import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JsonObject, RolloutRecord } from '../../codex-adapter/src/rollout.ts'
import type { SessionEvent, SessionHeader } from '../../dsh-adapter/src/format.ts'
import { encodeArtifact } from '../../dsh-adapter/src/write.ts'

export const TARGET_ID = '11111111-2222-4333-8444-555555555555'

export function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'agent-continue-cli-'))
}

export function codexRecords(cwd: string, tool: 'none' | 'pending' | 'completed' = 'none'): RolloutRecord[] {
  const timestamp = '2026-09-30T01:00:00.000Z'
  const drafts: { type: string; payload: JsonObject }[] = [
    { type: 'session_meta', payload: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd, cli_version: '0.155.0-alpha.16', model_provider: 'test-provider' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'synthetic-turn' } },
    { type: 'turn_context', payload: { turn_id: 'synthetic-turn', cwd, model: 'test-model' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SYNTHETIC PRIVATE QUESTION' }] } },
  ]
  if (tool !== 'none') {
    drafts.push({ type: 'response_item', payload: { type: 'function_call', call_id: 'synthetic-call', name: 'synthetic_tool', arguments: '{"private":"DO NOT PRINT ARGUMENTS"}' } })
  }
  if (tool === 'completed') {
    drafts.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'synthetic-call', output: 'SYNTHETIC PRIVATE RESULT' } })
  }
  drafts.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC PRIVATE ANSWER' }] } })
  drafts.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'synthetic-turn' } })
  return drafts.map((draft, ordinal) => ({ ...draft, ordinal, timestamp }))
}

export function writeCodex(root: string, tool: 'none' | 'pending' | 'completed' = 'none'): string {
  const path = join(root, 'source-rollout.jsonl')
  writeFileSync(path, `${codexRecords(root, tool).map((record) => JSON.stringify(record)).join('\n')}\n`)
  return path
}

export function writeDsh(root: string, tool: 'none' | 'pending' | 'completed' = 'none', createdAt = 1790730000000): string {
  const source = dshLog(root, tool, createdAt)
  const path = join(root, 'session.v4.jsonl.zstd')
  writeFileSync(path, encodeArtifact(source.header, source.events))
  return path
}

export const CONVERSATION_TEXTS = ['SYNTHETIC FIRST QUESTION', 'SYNTHETIC FIRST ANSWER', '第二轮合成问题 UTF-8', 'SYNTHETIC SECOND ANSWER']

export function codexConversation(root: string): RolloutRecord[] {
  const first = codexRecords(root, 'completed')
  const second = codexRecords(root).slice(1)
  for (const [turnIndex, records] of [first, second].entries()) {
    for (const record of records) {
      if (record.payload.turn_id !== undefined) record.payload.turn_id = `synthetic-turn-${turnIndex + 1}`
      if (record.payload.type === 'message') {
        const textIndex = turnIndex * 2 + (record.payload.role === 'assistant' ? 1 : 0)
        record.payload.content = [{ type: record.payload.role === 'assistant' ? 'output_text' : 'input_text', text: CONVERSATION_TEXTS[textIndex] }]
      }
    }
  }
  return [...first, ...second].map((record, ordinal) => ({ ...record, ordinal }))
}

export function writeDshConversation(root: string): string {
  const source = dshLog(root, 'completed', 1790730000000, CONVERSATION_TEXTS)
  const path = join(root, 'conversation.session.v4.jsonl.zstd')
  writeFileSync(path, encodeArtifact(source.header, source.events))
  return path
}

export function dshLog(
  cwd: string,
  tool: 'none' | 'pending' | 'completed',
  createdAt = 1790730000000,
  texts: readonly string[] = ['SYNTHETIC PRIVATE QUESTION', 'SYNTHETIC PRIVATE ANSWER'],
): { header: SessionHeader; events: SessionEvent[] } {
  const header: SessionHeader = {
    type: 'session', version: 4, id: 'synthetic-source-session', cwd,
    createdAt, isSeeded: false, delegationDepth: 0,
  }
  const events: SessionEvent[] = []
  const push = (type: string, data: JsonObject, surfaceOp?: 'append') => {
    const event: SessionEvent = { type, seq: events.length, time: createdAt + events.length, data }
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    events.push(event)
  }
  for (let textIndex = 0; textIndex < texts.length; textIndex += 2) {
    const turn = textIndex / 2 + 1
    push('turn/start', { turn })
    push('user/message', {
      id: `synthetic-user-${turn}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: texts[textIndex] }],
    }, 'append')
    push('step/start', { turn, step: 1 })
    const content: JsonObject[] = [{ type: 'text', text: texts[textIndex + 1] }]
    if (turn === 1 && tool !== 'none') {
      content.push({ type: 'tool-call', id: 'synthetic-call', name: 'synthetic_tool', arguments: '{"private":"DO NOT PRINT ARGUMENTS"}' })
    }
    push('assistant/message', {
      turn, step: 1, stream: [], message: {
        id: `synthetic-assistant-${turn}`, role: 'assistant', content,
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
    }, 'append')
    if (turn === 1 && tool !== 'none') {
      push('tool/call', { turn, step: 1, callId: 'synthetic-call', name: 'synthetic_tool', arguments: '{"private":"DO NOT PRINT ARGUMENTS"}' })
      if (tool === 'pending') break
      push('tool/result', {
        turn, step: 1, message: {
          id: 'synthetic-result', role: 'tool', toolCallId: 'synthetic-call', isError: false,
          source: { kind: 'tool', callId: 'synthetic-call' },
          content: [{ type: 'text', text: 'SYNTHETIC PRIVATE RESULT' }],
        },
      }, 'append')
    }
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { header, events }
}

export function initializeRegistry(home: string): void {
  const database = new DatabaseSync(join(home, 'state_5.sqlite'))
  try {
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '',
      memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT,
      preview TEXT NOT NULL DEFAULT '', recency_at INTEGER NOT NULL DEFAULT 0,
      recency_at_ms INTEGER NOT NULL DEFAULT 0, history_mode TEXT NOT NULL DEFAULT 'legacy',
      is_pinned INTEGER NOT NULL DEFAULT 0, originator TEXT)`)
  } finally {
    database.close()
  }
}
