/**
 * Line codec and admission-rule tests.
 *
 * The corpus test is the load-bearing one: it runs our validator over every
 * record DSH itself wrote. If our rules were stricter than DSH's, real logs
 * would be rejected; if looser, we would happily write logs DSH refuses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  KNOWN_SESSION_EVENT_TYPES,
  SURFACE_EVENT_TYPES,
  SessionLogError,
  parseEvent,
  parseHeader,
  parseSessionLog,
  serializeSessionLog,
  type SessionEvent,
  type SessionHeader,
} from '../src/format.ts'
import { readFrames } from '../src/zstd.ts'
import { findArtifacts, sessionRoot } from './corpus.ts'

const header: SessionHeader = {
  type: 'session',
  version: 4,
  id: 'imported-0001',
  createdAt: 1_783_860_679_475,
  cwd: 'F:\\proj',
  isSeeded: false,
  delegationDepth: 0,
}

test('accepts a well-formed header and rejects malformed ones', () => {
  assert.deepEqual(parseHeader(header), header)
  assert.equal(parseHeader({ ...header, agentPreset: 'standard' }).agentPreset, 'standard')

  assert.throws(() => parseHeader({ ...header, type: 'not-session' }), /type must be "session"/)
  assert.throws(() => parseHeader({ ...header, version: 4.5 }), /version must be a non-negative safe integer/)
  assert.throws(() => parseHeader({ ...header, version: -1 }), /version must be a non-negative safe integer/)
  assert.throws(() => parseHeader({ ...header, delegationDepth: undefined }), /missing required key "delegationDepth"/)
  assert.throws(() => parseHeader({ ...header, unexpected: 1 }), /unknown key "unexpected"/)
  assert.throws(() => parseHeader({ ...header, isSeeded: 'no' }), /isSeeded must be a boolean/)
  assert.throws(() => parseHeader({ ...header, origin: 'other' }), /origin must be "subagent"/)
  assert.throws(() => parseHeader(header, 3), /does not match the artifact filename version 3/)
})

test('enforces the event admission rules DSH applies when it opens a log', () => {
  const append = (over: Partial<SessionEvent>): SessionEvent =>
    ({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 }, ...over }) as SessionEvent

  assert.equal(parseEvent(append({}), 0).seq, 0)

  // seq must be the dense zero-based index.
  assert.throws(() => parseEvent(append({ seq: 5 }), 0), /dense zero-based index 0/)
  assert.throws(() => parseEvent(append({ seq: 0.5 }), 0), /seq must be a non-negative safe integer/)
  // time and data are mandatory.
  assert.throws(() => parseEvent(append({ time: undefined as never }), 0), /time must be a non-negative safe integer/)
  assert.throws(() => parseEvent({ type: 'turn/start', seq: 0, time: 1 }, 0), /missing "data"/)
  // The envelope is closed.
  assert.throws(() => parseEvent({ ...append({}), extra: 1 }, 0), /unknown envelope key "extra"/)
  // A surface type without a marker would reconstruct the wrong conversation.
  assert.throws(
    () => parseEvent({ type: 'user/message', seq: 0, time: 1, data: {} }, 0),
    /surface-eligible and requires a surfaceOp marker/,
  )
  // A log-only type with a marker is equally wrong.
  assert.throws(() => parseEvent(append({ surfaceOp: 'append' }), 0), /log-only and must not carry a surfaceOp/)
  // Replace markers are checked.
  assert.throws(
    () => parseEvent({ type: 'user/message', seq: 0, time: 1, data: {}, surfaceOp: { op: 'append' } }, 0),
    /surfaceOp.op must be "replace"/,
  )
  assert.equal(
    parseEvent({ type: 'user/message', seq: 0, time: 1, data: {}, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }, 0).type,
    'user/message',
  )
  // Unknown types are only loadable when explicitly marked ignorable.
  assert.throws(() => parseEvent(append({ type: 'brand/new-event' }), 0), /unknown type "brand\/new-event"/)
  assert.equal(parseEvent(append({ type: 'brand/new-event', ignorable: true }), 0).ignorable, true)
  assert.throws(() => parseEvent(append({ ignorable: false as never }), 0), /ignorable must be exactly true/)
  // A known type does not need the escape hatch.
  assert.equal(parseEvent(append({ ignorable: true }), 0).ignorable, true)
})

test('round-trips a log through serialize and parse', () => {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 3, data: { id: 'm1' }, surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: 4, data: { turn: 1, step: 1 } },
  ]
  const text = serializeSessionLog(header, events)
  assert.equal(text.split('\n').filter(Boolean).length, 4, 'header plus three events, one per line')
  assert.ok(text.endsWith('\n'), 'lines are newline-terminated')

  const parsed = parseSessionLog(text, 4)
  assert.deepEqual(parsed.header, header)
  assert.deepEqual(parsed.events, events)
})

test('accepts every record DSH itself wrote', (t) => {
  let paths: string[]
  try {
    paths = findArtifacts(sessionRoot())
  } catch {
    t.skip(`no DSH session store at ${sessionRoot()}`)
    return
  }
  if (paths.length === 0) {
    t.skip(`no session.vN.jsonl.zstd under ${sessionRoot()}`)
    return
  }

  const failures: string[] = []
  const unknownTypes = new Set<string>()
  let records = 0
  let surfaceMarkers = 0
  let markersOnLogOnly = 0
  const surfaceMarkerTypes = new Set<string>()

  for (const path of paths) {
    const version = Number(/^session\.v(\d+)\.jsonl\.zstd$/.exec(path.split(/[\\/]/).pop()!)![1])
    const label = path.split(/[\\/]/).slice(-3).join('/')
    let parsed
    try {
      parsed = parseSessionLog(readFrames(readFileSync(path)).text, version)
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`)
      continue
    }

    for (const event of parsed.events) {
      records += 1
      if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) unknownTypes.add(event.type)
      if (event.surfaceOp !== undefined) {
        surfaceMarkers += 1
        surfaceMarkerTypes.add(event.type)
        if (!SURFACE_EVENT_TYPES.has(event.type)) markersOnLogOnly += 1
      }
    }
  }

  t.diagnostic(`artifacts=${paths.length} event_records=${records} surface_markers=${surfaceMarkers}`)
  t.diagnostic(`types carrying surfaceOp: ${[...surfaceMarkerTypes].sort().join(', ')}`)
  t.diagnostic(`observed types outside our known set: ${[...unknownTypes].sort().join(', ') || '(none)'}`)

  assert.deepEqual(failures, [], 'our rules must admit every real record')
  assert.deepEqual([...unknownTypes], [], 'our known-type list must cover everything the real store contains')
  assert.equal(markersOnLogOnly, 0, 'surfaceOp appears only on surface types in real logs')
  assert.ok(records > 0, 'the store contains events')
})

test('rejects a log whose seq skips a value', () => {
  const text = [
    JSON.stringify(header),
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: {} }),
    JSON.stringify({ type: 'step/start', seq: 2, time: 2, data: {} }),
  ].join('\n')
  assert.throws(() => parseSessionLog(text, 4), SessionLogError)
  assert.throws(() => parseSessionLog(text, 4), /dense zero-based index 1, got 2/)
})
