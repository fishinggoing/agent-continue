import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LONG_CONTEXT_MEMO, longContextTurns } from './long-context.ts'

test('long-context fixture preserves task continuity while exercising two dialogue-only amendments', () => {
  const turns = longContextTurns()
  assert.equal(turns.length, 7)
  assert.ok(turns[0]!.includes('context-only-long-842'))
  assert.ok(turns[4]!.includes(LONG_CONTEXT_MEMO))
  assert.ok(turns[4]!.includes('overriding BOTH'))
  for (const index of [1, 2, 3, 5, 6]) {
    assert.equal(turns[index]!.split('\n').filter((line) => line.startsWith('ARCHIVE ')).length, 180)
    assert.ok(turns[index]!.includes('Stage two remains unfinished'))
  }
  assert.ok(turns.join('\n').length > 120_000)
})
