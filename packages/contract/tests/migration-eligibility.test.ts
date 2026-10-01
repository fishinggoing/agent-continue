import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { codexRecords, dshLog } from '../../cli/tests/fixtures.ts'
import { convertCodexToDsh } from '../src/codex-to-dsh.ts'
import { convertDshToCodex } from '../src/dsh-to-codex.ts'
import type { SessionHeader } from '../../dsh-adapter/src/format.ts'

const cwd = resolve('synthetic-migration-project')
const options = { cliVersion: '0.159.2', threadId: 'synthetic-target' }
const cases: { name: string; fields: Partial<SessionHeader>; reason: RegExp }[] = [
  { name: 'subagent', fields: { origin: 'subagent' }, reason: /subagent/ },
  { name: 'fork', fields: { parentSession: 'synthetic-parent' }, reason: /parentSession/ },
  { name: 'relative cwd', fields: { cwd: 'relative-project' }, reason: /source cwd/ },
  { name: 'missing cwd', fields: { cwd: undefined }, reason: /source cwd/ },
  { name: 'empty cwd', fields: { cwd: '' }, reason: /source cwd/ },
]

for (const scenario of cases) {
  test(`DSH converter rejects ${scenario.name} before flattening the source`, () => {
    const source = dshLog(cwd, 'none')
    const header = { ...source.header, ...scenario.fields }
    assert.throws(() => convertDshToCodex(header, source.events, options), scenario.reason)
    assert.deepEqual(header, { ...source.header, ...scenario.fields })
  })
}

for (const sourceCwd of ['relative-project', '', undefined]) {
  test(`Codex converter rejects ${sourceCwd === undefined ? 'missing' : sourceCwd === '' ? 'empty' : 'relative'} source cwd despite an absolute target`, () => {
    const records = codexRecords(cwd)
    records[0]!.payload.cwd = sourceCwd
    assert.throws(() => convertCodexToDsh(records, { sessionId: 'synthetic-target', cwd }), /source cwd/)
  })
}

test('Codex converter rejects a relative target cwd before generating an invisible DSH header', () => {
  assert.throws(() => convertCodexToDsh(codexRecords(cwd), { sessionId: 'synthetic-target', cwd: 'relative-target' }), /target cwd/)
})

test('top-level sources remain eligible, including seeded DSH sources without parentSession', () => {
  const source = dshLog(cwd, 'none')
  const converted = convertDshToCodex({ ...source.header, isSeeded: true, delegationDepth: 1 }, source.events, options)
  assert.ok(JSON.stringify(converted.drafts).includes('SYNTHETIC PRIVATE QUESTION'))
  const target = convertCodexToDsh(codexRecords(cwd), { sessionId: 'synthetic-target', cwd })
  assert.equal(target.header.cwd, cwd)
  assert.equal(target.header.origin, undefined)
  assert.equal(target.header.parentSession, undefined)
})
