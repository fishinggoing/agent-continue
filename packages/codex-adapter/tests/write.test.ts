/**
 * Writer tests.
 *
 * The registry insert is exercised against a scratch SQLite file holding the
 * same `threads` DDL the real store uses, so the column list and NOT NULL set
 * are checked without touching any real Codex home.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { extendedLengthPath, encodeRollout, registerThread, seedProjectionCursor, writeRollout } from '../src/write.ts'
import { parseRollout } from '../src/rollout.ts'
import { rolloutPath } from '../src/paths.ts'

/** `threads` DDL copied from a real store, trimmed to the columns that matter here. */
const THREADS_DDL = `CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL,
  cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL,
  approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
  has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER, git_sha TEXT, git_branch TEXT, git_origin_url TEXT,
  cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '',
  agent_nickname TEXT, agent_role TEXT, memory_mode TEXT NOT NULL DEFAULT 'enabled',
  model TEXT, reasoning_effort TEXT, agent_path TEXT, created_at_ms INTEGER,
  updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '',
  recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0,
  history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0,
  thread_section_id TEXT, section_position INTEGER, section_entered_at_ms INTEGER,
  project_id TEXT, originator TEXT, daybreak_enabled BOOLEAN)`

const PROJECTION_DDL = `CREATE TABLE thread_history_projection_state (
  thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL,
  next_rollout_ordinal INTEGER NOT NULL)`

test('assigns ordinals by position and stamps every record', () => {
  const text = encodeRollout([
    { type: 'session_meta', payload: { id: 'x' } },
    { type: 'event_msg', payload: { type: 'task_started' }, timestamp: '2026-01-01T00:00:00.000Z' },
  ], '2026-01-01T00:00:00.000Z')

  const { records, failures } = parseRollout(text)
  assert.equal(failures.length, 0)
  assert.deepEqual(records.map((record) => record.ordinal), [0, 1])
  assert.ok(text.endsWith('\n'), 'records are newline-terminated')
})

test('normalizes a working directory to the form Codex stores', () => {
  const normalized = extendedLengthPath('F:\\agent-continue')
  assert.equal(normalized, '\\\\?\\F:\\agent-continue')
  assert.equal(extendedLengthPath(normalized), normalized, 'already-normalized paths are left alone')
})

test('writes a rollout where Codex looks for it', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-writer-'))
  const when = new Date(2026, 8, 30, 16, 20, 5)
  const id = 'thread-writer-test'
  const written = writeRollout(home, id, when, [
    { type: 'session_meta', payload: { id, cwd: 'F:\\agent-continue' } },
  ])

  assert.equal(written.path, rolloutPath(home, when, id))
  assert.ok(written.path.endsWith(join('2026', '09', '30', `rollout-2026-09-30T16-20-05-${id}.jsonl`)), written.path)
  assert.equal(readFileSync(written.path, 'utf8').trim().split('\n').length, 1)
})

test('registers a thread the way the real schema requires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-registry-'))
  const statePath = join(dir, 'state_5.sqlite')
  const db = new DatabaseSync(statePath)
  db.exec(THREADS_DDL)
  db.close()

  const id = '01a0f161-4421-7503-9744-a5b6e90452f1'
  registerThread(statePath, {
    id,
    rolloutPath: 'F:\\home\\sessions\\2026\\09\\30\\rollout-x.jsonl',
    createdAt: 1_790_756_078,
    updatedAt: 1_790_756_083,
    source: 'exec',
    modelProvider: 'example-provider',
    cwd: 'F:\\agent-continue',
    title: 'imported thread',
    model: 'example-model',
    reasoningEffort: 'xhigh',
    firstUserMessage: 'imported thread',
    originator: 'codex_exec',
  })

  const check = new DatabaseSync(statePath, { readOnly: true })
  const row = check.prepare('select * from threads where id = ?').get(id) as Record<string, unknown>
  check.close()

  assert.equal(row.cwd, '\\\\?\\F:\\agent-continue', 'cwd is stored in extended-length form')
  assert.equal(row.history_mode, 'paginated', 'current stores use paginated history')
  assert.equal(row.memory_mode, 'enabled')
  assert.equal(row.approval_mode, 'never')
  assert.equal(row.model_provider, 'example-provider')
  assert.equal(row.created_at_ms, 1_790_756_078_000, 'millisecond columns mirror the second columns')
  assert.equal(row.tokens_used, 0)
  assert.equal(row.archived, 0)
  assert.equal(row.sandbox_policy, '{"type":"disabled"}')
})

test('seeds and resets the projection cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-projection-'))
  const historyPath = join(dir, 'thread_history_1.sqlite')
  const db = new DatabaseSync(historyPath)
  db.exec(PROJECTION_DDL)
  db.close()

  seedProjectionCursor(historyPath, 'thread-a')
  seedProjectionCursor(historyPath, 'thread-a')
  seedProjectionCursor(historyPath, 'thread-b')

  const check = new DatabaseSync(historyPath, { readOnly: true })
  const rows = check.prepare('select * from thread_history_projection_state order by thread_id').all() as Record<string, unknown>[]
  check.close()

  assert.equal(rows.length, 2, 'seeding twice does not duplicate the row')
  assert.deepEqual(rows.map((row) => [row.thread_id, row.next_rollout_byte_offset, row.next_rollout_ordinal]),
    [['thread-a', 0, 0], ['thread-b', 0, 0]])
})
