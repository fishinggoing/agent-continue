import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { execute } from '../src/command.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { encodeArtifact } from '../../dsh-adapter/src/write.ts'
import { TARGET_ID, codexRecords, initializeRegistry, scratch, writeCodex, writeDsh } from './fixtures.ts'

function migrateArgs(root: string, from: 'codex' | 'dsh', input: string, home: string): string[] {
  return ['migrate', '--from', from, '--input', input, '--cwd', root, '--target-home', home, '--id', TARGET_ID]
}

function reverseArgs(root: string, input: string, home: string): string[] {
  return [...migrateArgs(root, 'dsh', input, home), '--cli-version', '0.155.0-alpha.16', '--model-provider', 'test-provider', '--model', 'test-model']
}

test('help and argument validation do not require a source or a user home', () => {
  assert.match(String(execute([]).usage), /inspect/)
  assert.throws(() => execute(['unknown']), /Unknown command/)
  assert.throws(() => execute(['inspect', '--from', 'codex', '--from', 'dsh']), /Duplicate option/)
  assert.throws(() => execute(['migrate', '--overwrite']), /Unknown option/)
  assert.throws(() => execute(['inspect', '--input']), /Missing value/)
})

test('inspect reports pending tool calls without leaking body or arguments', () => {
  const root = scratch()
  const input = writeCodex(root, 'pending')
  const report = execute(['inspect', '--from', 'codex', '--input', input])
  assert.deepEqual(report.pendingOperations, [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }])
  const output = JSON.stringify(report)
  assert.ok(!output.includes('PRIVATE QUESTION'))
  assert.ok(!output.includes('DO NOT PRINT ARGUMENTS'))
  assert.equal(report.toolsExecuted, 0)
})

test('completed tool outputs resolve pending calls in both formats', () => {
  const root = scratch()
  assert.deepEqual(execute(['inspect', '--from', 'codex', '--input', writeCodex(root, 'completed')]).pendingOperations, [])
  assert.deepEqual(execute(['inspect', '--from', 'dsh', '--input', writeDsh(root, 'completed')]).pendingOperations, [])
  assert.deepEqual(execute(['inspect', '--from', 'dsh', '--input', writeDsh(root, 'pending')]).pendingOperations, [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }])
})

test('machine-marked context notices survive inspection and migration without archived tool results', () => {
  const root = scratch()
  const operations = [{ callId: 'archived-call', name: 'read', state: 'unknown' }]
  const records = codexRecords(root)
  const user = records.find(record => record.payload.role === 'user')!
  user.payload.recovery = 'TOOL_OUTCOME_UNKNOWN'
  user.payload.pending_operations = operations
  const input = join(root, 'source-marker.jsonl')
  writeFileSync(input, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  assert.deepEqual(execute(['inspect', '--from', 'codex', '--input', input]).pendingOperations, operations)
  const migrated = execute(migrateArgs(root, 'codex', input, join(root, 'dsh-home')))
  const output = (migrated.output as { path: string }).path
  assert.deepEqual(execute(['inspect', '--from', 'dsh', '--input', output]).pendingOperations, operations)
  assert.deepEqual(execute([...reverseArgs(root, output, join(root, 'codex-home')), '--dry-run']).pendingOperations, operations)
  assert.ok(!JSON.stringify(migrated).includes('SYNTHETIC PRIVATE QUESTION'))
})

test('an unknown marker without machine operations refuses migration rather than matching body keywords', () => {
  const root = scratch()
  const records = codexRecords(root)
  const user = records.find(record => record.payload.role === 'user')!
  user.payload.recovery = 'TOOL_OUTCOME_UNKNOWN'
  const input = join(root, 'malformed-marker.jsonl')
  writeFileSync(input, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  assert.throws(() => execute(migrateArgs(root, 'codex', input, join(root, 'target'))), /machine-readable pending/i)
  assert.equal(existsSync(join(root, 'target')), false)
})

for (const custom of [false, true]) {
  test(`Codex inspect preserves explicit unknown recovery markers for ${custom ? 'custom' : 'function'} tool results`, () => {
    const root = scratch()
    const records = codexRecords(root, 'completed')
    const call = records.find((record) => record.payload.type === 'function_call')!
    const result = records.find((record) => record.payload.type === 'function_call_output')!
    if (custom) {
      call.payload.type = 'custom_tool_call'
      call.payload.input = '{}'
      delete call.payload.arguments
      result.payload.type = 'custom_tool_call_output'
      result.payload.output = [{ type: 'text', text: 'SYNTHETIC PRIVATE RESULT' }]
    }
    const input = join(root, 'recovery-rollout.jsonl')
    const inspect = () => {
      writeFileSync(input, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
      return execute(['inspect', '--from', 'codex', '--input', input]).pendingOperations
    }
    result.payload.isError = true
    result.payload.recovery = 'TOOL_OUTCOME_UNKNOWN'
    const pending = [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }]
    assert.deepEqual(inspect(), pending)
    result.payload.isError = false
    assert.deepEqual(inspect(), pending, 'An explicit unknown marker stays conservative even when isError disagrees')
    result.payload.isError = true
    delete result.payload.recovery
    assert.deepEqual(inspect(), [], 'A known failure is not an unknown outcome')
    result.payload.recovery = 'TOOL_NOT_STARTED'
    assert.deepEqual(inspect(), [], 'A known unstarted operation is not an unknown execution outcome')
  })
}

test('native unknown-outcome repairs remain pending during inspect and migration', () => {
  const root = scratch()
  const input = writeDsh(root, 'completed')
  const source = parseSessionLog(readFrames(readFileSync(input)).text, 4)
  const result = source.events.find((event) => event.type === 'tool/result')!
  const data = result.data as { error?: { code: string }; message: { isError: boolean } }
  data.error = { code: 'TOOL_OUTCOME_UNKNOWN' }
  data.message.isError = true
  writeFileSync(input, encodeArtifact(source.header, source.events))
  const pending = [{ callId: 'synthetic-call', name: 'synthetic_tool', state: 'unknown' }]
  assert.deepEqual(execute(['inspect', '--from', 'dsh', '--input', input]).pendingOperations, pending)
  assert.deepEqual(execute([...reverseArgs(root, input, join(root, 'uncreated-home')), '--dry-run']).pendingOperations, pending)
  const home = join(root, 'codex-home')
  mkdirSync(home)
  initializeRegistry(home)
  const migrated = execute(reverseArgs(root, input, home))
  assert.deepEqual(migrated.pendingOperations, pending)
  const output = migrated.output as { path: string }
  assert.deepEqual(execute(['inspect', '--from', 'codex', '--input', output.path]).pendingOperations, pending, 'Migration must not turn an unknown tool outcome into a resolved call')
})

test('dry-run plans Codex to DSH without creating the target', () => {
  const root = scratch()
  const input = writeCodex(root)
  const home = join(root, 'uncreated-home')
  const report = execute([...migrateArgs(root, 'codex', input, home), '--dry-run'])
  assert.equal(report.status, 'planned')
  assert.equal(report.nativeValidation, 'not-run')
  assert.ok(Array.isArray(report.losses))
  assert.ok(!existsSync(home))
})

test('Codex to DSH writes a new artifact and keeps messages', () => {
  const root = scratch()
  const report = execute(migrateArgs(root, 'codex', writeCodex(root), join(root, 'target-home')))
  const output = report.output as { path: string }
  const parsed = parseSessionLog(readFrames(readFileSync(output.path)).text, 4)
  assert.equal(parsed.header.id, TARGET_ID)
  assert.ok(JSON.stringify(parsed.events).includes('SYNTHETIC PRIVATE QUESTION'))
  assert.ok(JSON.stringify(parsed.events).includes('SYNTHETIC PRIVATE ANSWER'))
  assert.equal(report.status, 'written')
  assert.equal(report.modelRequests, 0)
})

test('a duplicate DSH target is rejected without changing existing bytes', () => {
  const root = scratch()
  const args = migrateArgs(root, 'codex', writeCodex(root), join(root, 'target-home'))
  const output = execute(args).output as { path: string }
  const before = readFileSync(output.path)
  assert.throws(() => execute(args), /overwrite/)
  assert.deepEqual(readFileSync(output.path), before)
})

test('reverse migration requires explicit target configuration and dry-run stays read-only', () => {
  const root = scratch()
  const input = writeDsh(root)
  const home = join(root, 'uncreated-home')
  assert.throws(() => execute([...migrateArgs(root, 'dsh', input, home), '--dry-run']), /cli-version/)
  const report = execute([...reverseArgs(root, input, home), '--dry-run'])
  assert.equal(report.status, 'planned')
  assert.ok(!existsSync(home))
})

test('missing and incompatible Codex registries fail before writing a rollout', () => {
  const root = scratch()
  const input = writeDsh(root)
  const absent = join(root, 'absent-home')
  assert.throws(() => execute(reverseArgs(root, input, absent)), /initialized/)
  assert.ok(!existsSync(absent))
  const home = join(root, 'invalid-home')
  mkdirSync(home)
  const database = new DatabaseSync(join(home, 'state_5.sqlite'))
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)')
  database.close()
  assert.throws(() => execute(reverseArgs(root, input, home)), /incompatible/)
  assert.ok(!existsSync(join(home, 'sessions')))
})

test('DSH to Codex writes history and registers a restricted native thread', () => {
  const root = scratch()
  const input = writeDsh(root)
  const home = join(root, 'codex-home')
  mkdirSync(home)
  initializeRegistry(home)
  const report = execute(reverseArgs(root, input, home))
  const output = report.output as { path: string }
  const text = readFileSync(output.path, 'utf8')
  assert.ok(text.includes('SYNTHETIC PRIVATE QUESTION'))
  assert.ok(text.includes('SYNTHETIC PRIVATE ANSWER'))
  const database = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true })
  try {
    const thread = database.prepare('SELECT * FROM threads WHERE id = ?').get(TARGET_ID)!
    assert.equal(thread.rollout_path, output.path)
    assert.equal(thread.model_provider, 'test-provider')
    assert.equal(thread.cli_version, '0.155.0-alpha.16')
    assert.equal(thread.sandbox_policy, '{"type":"read-only"}')
    assert.equal(thread.approval_mode, 'on-request')
    assert.equal(thread.first_user_message, 'SYNTHETIC PRIVATE QUESTION')
    assert.equal(thread.preview, 'SYNTHETIC PRIVATE QUESTION')
  } finally {
    database.close()
  }
  assert.equal(report.nativeValidation, 'not-run')
})

test('duplicate registered ids are checked before a differently named rollout is created', () => {
  const root = scratch()
  const input = writeDsh(root)
  const home = join(root, 'codex-home')
  mkdirSync(home)
  initializeRegistry(home)
  const first = execute(reverseArgs(root, input, home)).output as { path: string }
  const original = readFileSync(first.path)
  writeDsh(root, 'none', 1790733600000)
  assert.throws(() => execute(reverseArgs(root, input, home)), /registered thread/)
  assert.deepEqual(readFileSync(first.path), original)
})

test('damaged and incomplete sources are rejected without printing source content', () => {
  const root = scratch()
  const bad = join(root, 'bad.jsonl')
  writeFileSync(bad, 'SECRET INVALID SOURCE BODY')
  assert.throws(() => execute(['inspect', '--from', 'codex', '--input', bad]), (error: unknown) => error instanceof Error && !error.message.includes('SECRET') && error.message.includes('Damaged'))
  const input = writeDsh(root)
  const bytes = readFileSync(input)
  writeFileSync(input, bytes.subarray(0, bytes.length - 1))
  assert.throws(() => execute(['inspect', '--from', 'dsh', '--input', input]), /incomplete/)
})

test('CLI entry produces parseable JSON and exits nonzero on invalid commands', () => {
  const root = scratch()
  const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url))
  const stdout = execFileSync(process.execPath, [entry, 'inspect', '--from', 'codex', '--input', writeCodex(root)], { encoding: 'utf8', windowsHide: true })
  assert.equal(JSON.parse(stdout).command, 'inspect')
  const failure = spawnSync(process.execPath, [entry, 'not-a-command'], { encoding: 'utf8', windowsHide: true })
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /Unknown command/)
})
