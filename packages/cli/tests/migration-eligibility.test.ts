import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { execute } from '../src/command.ts'
import { encodeArtifact } from '../../dsh-adapter/src/write.ts'
import type { SessionHeader } from '../../dsh-adapter/src/format.ts'
import { TARGET_ID, codexRecords, dshLog, initializeRegistry, scratch } from './fixtures.ts'

const cases: { name: string; fields: Partial<SessionHeader>; reason: RegExp }[] = [
  { name: 'subagent', fields: { origin: 'subagent' }, reason: /subagent/ },
  { name: 'fork', fields: { parentSession: 'synthetic-parent' }, reason: /parentSession/ },
  { name: 'relative cwd', fields: { cwd: 'relative-project' }, reason: /source cwd/ },
  { name: 'missing cwd', fields: { cwd: undefined }, reason: /source cwd/ },
  { name: 'empty cwd', fields: { cwd: '' }, reason: /source cwd/ },
]

for (const scenario of cases) {
  test(`CLI rejects DSH ${scenario.name} before cwd remapping or target writes`, () => {
    const root = scratch()
    const source = dshLog(root, 'none')
    const input = join(root, 'session.v4.jsonl.zstd')
    writeFileSync(input, encodeArtifact({ ...source.header, ...scenario.fields }, source.events))
    const before = readFileSync(input)
    const home = join(root, 'uncreated-home')
    const args = ['migrate', '--from', 'dsh', '--input', input, '--cwd', root, '--target-home', home,
      '--id', TARGET_ID, '--cli-version', '0.159.2', '--model-provider', 'test-provider']
    for (const extra of [[], ['--dry-run']]) {
      assert.throws(() => execute([...args, ...extra]), scenario.reason)
      assert.ok(!existsSync(home))
    }
    mkdirSync(home)
    initializeRegistry(home)
    const registry = join(home, 'state_5.sqlite')
    const originalRegistry = readFileSync(registry)
    assert.throws(() => execute(args), scenario.reason)
    assert.deepEqual(readFileSync(registry), originalRegistry)
    assert.ok(!existsSync(join(home, 'sessions')))
    assert.deepEqual(readFileSync(input), before)
    const inspected = execute(['inspect', '--from', 'dsh', '--input', input])
    assert.equal(inspected.command, 'inspect', 'Read-only inspection remains available for rejected sources')
    assert.ok(!JSON.stringify(inspected).includes('SYNTHETIC PRIVATE QUESTION'))
  })
}

for (const sourceCwd of ['relative-project', '', undefined]) {
  test(`CLI rejects Codex ${sourceCwd === undefined ? 'missing' : sourceCwd === '' ? 'empty' : 'relative'} cwd even with an absolute --cwd`, () => {
    const root = scratch()
    const records = codexRecords(root)
    records[0]!.payload.cwd = sourceCwd
    const input = join(root, 'rollout.jsonl')
    writeFileSync(input, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    const home = join(root, 'uncreated-home')
    const args = ['migrate', '--from', 'codex', '--input', input, '--cwd', root, '--target-home', home]
    assert.throws(() => execute(args), /source cwd/)
    assert.throws(() => execute([...args, '--dry-run']), /source cwd/)
    assert.ok(!existsSync(home))
  })
}

test('CLI entry returns a nonzero structured refusal without exposing source messages', () => {
  const root = scratch()
  const source = dshLog(root, 'none')
  const input = join(root, 'session.v4.jsonl.zstd')
  writeFileSync(input, encodeArtifact({ ...source.header, origin: 'subagent' }, source.events))
  const home = join(root, 'uncreated-home')
  const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url))
  const result = spawnSync(process.execPath, [entry, 'migrate', '--from', 'dsh', '--input', input,
    '--cwd', root, '--target-home', home, '--cli-version', '0.159.2', '--model-provider', 'test-provider'], {
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  const failure = JSON.parse(result.stderr.trim().split('\n').at(-1)!)
  assert.equal(failure.status, 'failed')
  assert.match(failure.error, /subagent/)
  assert.match(failure.error, /ACP/)
  assert.ok(!result.stderr.includes('SYNTHETIC PRIVATE QUESTION'))
  assert.ok(!existsSync(home))
})
