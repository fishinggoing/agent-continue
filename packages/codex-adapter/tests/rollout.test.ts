/**
 * Rollout reader tests.
 *
 * The corpus test runs the reader over the real Codex session store and
 * cross-checks the filename against the `session_meta` inside the file: the id
 * in the name must equal the id the writer recorded, and the local timestamp in
 * the name must resolve back to the file's own path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { codexHome, parseRolloutFilename, rolloutPath, sessionsRoot, rolloutFilename } from '../src/paths.ts'
import { parseRollout, select, sessionMeta, summarizeKinds, toolOutputText, turnWindows } from '../src/rollout.ts'
import { readRollouts, storeRoot } from './corpus.ts'

test('encodes and decodes rollout filenames', () => {
  const when = new Date(2026, 8, 30, 15, 25, 52)
  const id = '01a0f134-9c18-74f2-b50d-51db5e12d5cf'
  const name = rolloutFilename(when, id)
  assert.equal(name, `rollout-2026-09-30T15-25-52-${id}.jsonl`)

  const parts = parseRolloutFilename(name)
  assert.equal(parts?.sessionId, id)
  assert.equal(parts?.startedAt.getTime(), when.getTime())

  assert.equal(parseRolloutFilename('rollout-2026-09-30T15-25-52-nope'), undefined, 'missing suffix')
  assert.equal(parseRolloutFilename('session.jsonl'), undefined)

  const path = rolloutPath('C:\\home', when, id)
  assert.ok(path.endsWith(`2026\\09\\30\\${name}`), `unexpected path ${path}`)
})

test('parses the envelope and keeps unknown record types', () => {
  const text = [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'x' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', ordinal: 1, type: 'brand_new_kind', payload: { anything: 1 } }),
  ].join('\n')
  const { records, failures } = parseRollout(text)
  assert.equal(failures.length, 0)
  assert.equal(records.length, 2)
  assert.equal(records[1]!.type, 'brand_new_kind', 'an unknown type is preserved, not rejected')

  // A malformed line is reported and skipped rather than throwing.
  const damaged = parseRollout(`${text}\n{"timestamp":"x","ordinal":2,"type":"broken"`)
  assert.equal(damaged.records.length, 2)
  assert.equal(damaged.failures.length, 1)
  assert.match(damaged.failures[0]!.reason, /JSON|Unexpected|Unterminated/i)

  // Envelope fields are mandatory.
  const noPayload = parseRollout(JSON.stringify({ timestamp: 'x', ordinal: 0, type: 'session_meta' }))
  assert.equal(noPayload.records.length, 0)
  assert.match(noPayload.failures[0]!.reason, /missing envelope key "payload"/)

  // `ordinal` is optional: Codex omits it when appending to a rollout it did not
  // create, so a file can mix both forms.
  const mixed = parseRollout([
    JSON.stringify({ timestamp: 't', ordinal: 0, type: 'session_meta', payload: {} }),
    JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n'))
  assert.equal(mixed.failures.length, 0)
  assert.equal(mixed.records[0]!.ordinal, 0)
  assert.equal(mixed.records[1]!.ordinal, undefined, 'an omitted ordinal is not a defect')

  // A present but malformed ordinal is still rejected.
  const badOrdinal = parseRollout(JSON.stringify({ timestamp: 't', ordinal: 1.5, type: 'session_meta', payload: {} }))
  assert.match(badOrdinal.failures[0]!.reason, /ordinal is present but not an integer/)
})

test('normalizes both tool-output encodings', () => {
  assert.equal(toolOutputText({ output: 'plain string' }), 'plain string')
  assert.equal(
    toolOutputText({ output: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'ab',
  )
  assert.equal(toolOutputText({}), '')
})

test('reads every rollout in the real Codex store', (t) => {
  const corpus = readRollouts()
  if (corpus.length === 0) {
    t.skip(`no Codex session store at ${storeRoot()}`)
    return
  }

  const allKinds = new Map<string, number>()
  const ordinalGaps: string[] = []
  const idMismatches: string[] = []
  const pathMismatches: string[] = []
  let records = 0
  let failures = 0
  let badFirstRecord = 0
  let missingOrdinal = 0
  const home = process.env.CODEX_HOME ?? codexHome()

  for (const { file, parsed } of corpus) {
    failures += parsed.failures.length
    records += parsed.records.length
    for (const [kind, count] of summarizeKinds(parsed.records)) {
      allKinds.set(kind, (allKinds.get(kind) ?? 0) + count)
    }

    if (parsed.records[0]?.type !== 'session_meta') badFirstRecord += 1

    // Where a writer recorded an ordinal it must equal the line index. Not every
    // writer does: Codex omits it when appending to a rollout it did not create.
    for (const [index, record] of parsed.records.entries()) {
      if (record.ordinal === undefined) {
        missingOrdinal += 1
        continue
      }
      if (record.ordinal !== index) ordinalGaps.push(`${file.sessionId}#${index}->${record.ordinal}`)
    }

    // The filename is a claim about the file; check it against the contents.
    const meta = sessionMeta(parsed.records)
    if (meta?.id !== undefined && meta.id !== file.sessionId) {
      idMismatches.push(`${file.path}: filename says ${file.sessionId}, session_meta says ${String(meta.id)}`)
    }
    const rebuilt = rolloutPath(home, file.startedAt, file.sessionId)
    if (rebuilt.toLowerCase() !== file.path.toLowerCase()) {
      pathMismatches.push(`${file.path}\n      expected ${rebuilt}`)
    }
  }

  t.diagnostic(`rollouts=${corpus.length} records=${records} parse_failures=${failures} first_record_not_meta=${badFirstRecord}`)
  t.diagnostic(`top kinds: ${[...allKinds].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([k, n]) => `${k}=${n}`).join(' ')}`)
  t.diagnostic(`ordinal gaps: ${ordinalGaps.length}${ordinalGaps.length ? ' -> ' + ordinalGaps.slice(0, 4).join(', ') : ''}`)
  t.diagnostic(`records without ordinal: ${missingOrdinal} of ${records}`)
  t.diagnostic(`filename vs session_meta id mismatches: ${idMismatches.length}`)
  t.diagnostic(`filename-decoded path mismatches: ${pathMismatches.length}`)

  assert.deepEqual(ordinalGaps, [], 'a recorded ordinal must equal its line index')
  assert.deepEqual(idMismatches, [], 'the id in the filename must equal session_meta.id')
  assert.deepEqual(pathMismatches, [], 'a decoded filename must resolve to the file it came from')
  assert.equal(badFirstRecord, 0, 'every rollout starts with session_meta')
  assert.ok(records > 0, 'the store contains records')
})

test('extracts turn windows and message roles from a synthetic rollout', () => {
  const line = (ordinal: number, type: string, payload: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', ordinal, type, payload })

  const { records } = parseRollout([
    line(0, 'session_meta', { id: 's1', cwd: 'C:\\w' }),
    line(1, 'event_msg', { type: 'task_started', turn_id: 't1', started_at: 100 }),
    line(2, 'response_item', { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
    line(3, 'response_item', { type: 'function_call', id: 'f1', call_id: 'c1', name: 'shell', arguments: '{}' }),
    line(4, 'response_item', { type: 'function_call_output', id: 'f2', call_id: 'c1', output: 'ok' }),
    line(5, 'event_msg', { type: 'task_complete', turn_id: 't1', started_at: 100, completed_at: 250, duration_ms: 150 }),
  ].join('\n'))

  assert.equal(sessionMeta(records)?.cwd, 'C:\\w')
  assert.equal(select(records, 'response_item', 'message').length, 1)
  assert.equal(select(records, 'response_item', 'function_call')[0]!.payload.name, 'shell')
  assert.deepEqual(turnWindows(records), [{ turnId: 't1', startedAt: 100, completedAt: 250, durationMs: 150 }])
})
