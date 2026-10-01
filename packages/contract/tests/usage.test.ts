import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertCodexToDsh } from '../src/codex-to-dsh.ts'
import { USAGE_CASES, usageRecords } from './usage-fixtures.ts'

for (const scenario of USAGE_CASES) {
  test(`usage mapping: ${scenario.name}`, () => {
    const conversion = convertCodexToDsh(usageRecords('F:\\synthetic', scenario.source), { sessionId: 'synthetic-usage', cwd: 'F:\\synthetic' })
    const assistant = conversion.events.find((event) => event.type === 'assistant/message')!
    assert.deepEqual(assistant.data.usage, scenario.expected)
    assert.equal(Object.hasOwn(assistant.data, 'usage'), scenario.expected !== undefined)
    if (scenario.loss) assert.match(conversion.losses.join('\n'), scenario.loss)
    else assert.deepEqual(conversion.losses, [])
    assert.equal(conversion.tallies.token_usage_record?.mapped ?? 0, scenario.expected === undefined ? 0 : 1)
  })
}

test('usage mapping accepts the alternative usage payload without inventing optional fields', () => {
  const conversion = convertCodexToDsh(usageRecords('F:\\synthetic', { input_tokens: 12, output_tokens: 4 }, 'usage'), { sessionId: 'synthetic-usage', cwd: 'F:\\synthetic' })
  assert.deepEqual(conversion.events.find((event) => event.type === 'assistant/message')!.data.usage, { inputTokens: 12, outputTokens: 4 })
})
