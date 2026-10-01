import type { JsonObject, RolloutRecord } from '../../codex-adapter/src/rollout.ts'

interface UsageCase {
  name: string
  source: JsonObject
  expected?: Record<string, number>
  loss?: RegExp
}

export const USAGE_CASES: UsageCase[] = [
  { name: 'missing optional counters', source: { input_tokens: 12, output_tokens: 4 }, expected: { inputTokens: 12, outputTokens: 4 } },
  {
    name: 'all recorded counters',
    source: { input_tokens: 12, output_tokens: 4, cached_input_tokens: 2, cache_write_input_tokens: 1, total_tokens: 16, reasoning_output_tokens: 2 },
    expected: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 16, reasoningTokens: 2 },
  },
  {
    name: 'explicit zero counters',
    source: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, total_tokens: 0, reasoning_output_tokens: 0 },
    expected: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, reasoningTokens: 0 },
  },
  { name: 'missing input', source: { output_tokens: 4, total_tokens: 4 }, loss: /input_tokens and output_tokens/ },
  { name: 'missing output', source: { input_tokens: 12, total_tokens: 12 }, loss: /input_tokens and output_tokens/ },
  { name: 'invalid required count', source: { input_tokens: -1, output_tokens: 4 }, loss: /input_tokens and output_tokens/ },
  { name: 'inconsistent total', source: { input_tokens: 12, output_tokens: 4, total_tokens: 99 }, expected: { inputTokens: 12, outputTokens: 4 }, loss: /totalTokens omitted/ },
  { name: 'invalid total', source: { input_tokens: 12, output_tokens: 4, total_tokens: null }, expected: { inputTokens: 12, outputTokens: 4 }, loss: /totalTokens omitted/ },
  { name: 'excessive cache', source: { input_tokens: 12, output_tokens: 4, cached_input_tokens: 13 }, loss: /cache counters exceed/ },
  { name: 'invalid cache', source: { input_tokens: 12, output_tokens: 4, cached_input_tokens: -1 }, loss: /uncached input cannot be determined/ },
  { name: 'invalid reasoning', source: { input_tokens: 12, output_tokens: 4, reasoning_output_tokens: 5 }, expected: { inputTokens: 12, outputTokens: 4 }, loss: /reasoningTokens omitted/ },
]

export function usageRecords(cwd: string, usage: JsonObject, field = 'turn_token_usage'): RolloutRecord[] {
  const timestamp = '2026-10-01T02:00:00.000Z'
  return [
    { timestamp, type: 'session_meta', payload: { id: 'synthetic-usage-source', cwd, model_provider: 'test-provider' } },
    { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'synthetic-usage-turn' } },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SYNTHETIC USAGE QUESTION' }] } },
    { timestamp, type: 'token_usage_record', payload: { turn_id: 'synthetic-usage-turn', [field]: usage } },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC USAGE ANSWER' }] } },
    { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'synthetic-usage-turn' } },
  ]
}
