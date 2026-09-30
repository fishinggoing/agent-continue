/**
 * Writer unit tests.
 *
 * These pin the two hazards Codex raised during its independent review: reusing
 * a target id must not silently destroy an existing artifact, and malformed
 * batch parameters must fail before anything reaches disk.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encodeArtifact, writeArtifact } from '../src/write.ts'
import { parseSessionLog, type SessionEvent, type SessionHeader } from '../src/format.ts'
import { readFrames } from '../src/zstd.ts'

const header: SessionHeader = {
  type: 'session', version: 4, id: 'writer-unit', createdAt: 1, cwd: 'F:\\proj', isSeeded: false, delegationDepth: 0,
}
const events: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 3, data: { id: 'm1', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' },
  { type: 'turn/end', seq: 2, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
]

test('splits events across the requested batches', () => {
  const bytes = encodeArtifact(header, events, [1, 2])
  // First frame holds only the header, then one frame per batch.
  const text = readFrames(bytes).text
  assert.equal(parseSessionLog(text, 4).events.length, 3)
  assert.equal(readFrames(bytes).scan.frames.length, 3)
})

test('rejects malformed batch parameters before writing anything', () => {
  assert.throws(() => encodeArtifact(header, events, [1]), /batch sizes sum to 1 but there are 3 events/)
  assert.throws(() => encodeArtifact(header, events, [4]), /batch sizes sum to 4 but there are 3 events/)
  assert.throws(() => encodeArtifact(header, events, [-1, 4]), /batch 0 size must be a non-negative safe integer/)
  assert.throws(() => encodeArtifact(header, events, [1.5, 1.5]), /batch 0 size must be a non-negative safe integer/)
})

test('refuses to clobber an existing artifact unless asked to', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'dsh-write-')), 'sessions')

  const first = writeArtifact(root, header, events)
  assert.equal(first.replaced, false)
  assert.ok(readFileSync(first.path).length > 0)

  assert.throws(() => writeArtifact(root, header, events), /refusing to overwrite an existing session artifact/)

  const again = writeArtifact(root, header, events, { overwrite: true })
  assert.equal(again.replaced, true)
  assert.equal(again.path, first.path)
})
