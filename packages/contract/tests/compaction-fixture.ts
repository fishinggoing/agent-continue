import assert from 'node:assert/strict'
import type { JsonObject, RolloutRecord } from '../../codex-adapter/src/rollout.ts'
import type { SessionEvent } from '../../dsh-adapter/src/format.ts'

export function compactedSource(cwd: string, snapshots?: JsonObject[][]): RolloutRecord[] {
  const message = (role: string, text: string): JsonObject => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
  const drafts = [
    { type: 'session_meta', payload: { id: 'compaction-source', cwd, model_provider: 'source-provider' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'turn_context', payload: { turn_id: 'first', model: 'source-model' } },
    { type: 'response_item', payload: message('user', 'ORIGINAL REQUIREMENTS') },
    { type: 'response_item', payload: message('assistant', 'OBSOLETE PARTIAL PLAN') },
    { type: 'response_item', payload: { type: 'function_call', name: 'read', call_id: 'archived-call', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'archived-call', output: 'ARCHIVED TOOL RESULT' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first' } },
    ...(snapshots ?? [[message('user', 'ORIGINAL REQUIREMENTS'), message('user', 'COMPACTED STATE: completed stage one; stage two remains.')]])
      .map((history, index) => ({ type: 'compacted', payload: { message: `UNUSED SUMMARY FALLBACK ${index}`, replacement_history: history, window_id: `window-${index}` } })),
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'followup' } },
    { type: 'response_item', payload: message('user', 'CONTINUE AFTER COMPACTION') },
    { type: 'response_item', payload: message('assistant', 'POST-COMPACTION WORK') },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'followup' } },
  ]
  return drafts.map((draft, ordinal) => ({ ...draft, payload: draft.payload as JsonObject, ordinal, timestamp: '2026-10-01T00:00:00.000Z' }))
}

export function activeEvents(events: SessionEvent[]): SessionEvent[] {
  const surface: SessionEvent[] = []
  for (const event of events) {
    const operation = event.surfaceOp
    if (operation === 'append') surface.push(event)
    else if (operation !== undefined) {
      const first = surface.findIndex((node) => node.seq === operation.startSeq)
      const last = surface.findIndex((node) => node.seq === operation.endSeq)
      assert.ok(first >= 0 && last >= first)
      assert.ok(surface.slice(first, last + 1).every((node) => event.sourceEventSeqs?.includes(node.seq)))
      surface.splice(first, last - first + 1, event)
    }
  }
  return surface
}
