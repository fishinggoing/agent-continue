/**
 * Frame-container tests.
 *
 * The second test decodes artifacts that DSH itself wrote, which is the only
 * way to know our reading of the container matches the writer. It never prints
 * record content — only structural counts and type names.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { compressFrame, readFrames, scanFrames } from '../src/zstd.ts'
import { findArtifacts, readArtifact, sessionRoot } from './corpus.ts'

test('round-trips concatenated frames and reports a torn tail', () => {
  const batches = ['{"n":0}\n', '{"n":1}\n{"n":2}\n', '{"n":3}\n']
  const file = Buffer.concat(batches.map(compressFrame))

  const scan = scanFrames(file)
  assert.equal(scan.frames.length, 3, 'one frame per batch')
  assert.equal(scan.tornStart, undefined)
  assert.equal(scan.frames[0]!.start, 0)
  assert.equal(scan.frames.at(-1)!.end, file.length, 'frames cover the file exactly')

  assert.equal(readFrames(file).text, batches.join(''))

  // A truncated final frame must be reported, not silently accepted or thrown on.
  const torn = file.subarray(0, file.length - 5)
  const tornScan = scanFrames(torn)
  assert.equal(tornScan.frames.length, 2)
  assert.equal(tornScan.tornStart, scan.frames[2]!.start)
  assert.equal(readFrames(torn).text, batches.slice(0, 2).join(''))
})

test('rejects a stream that does not start with a frame', () => {
  assert.throws(() => scanFrames(Buffer.from('not a zstd file, just text')), /not a zstd frame/)
})

test('decodes artifacts written by DSH', (t) => {
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

  let torn = 0
  let records = 0
  let headers = 0
  const versions = new Map<number, number>()
  const kinds = new Map<string, number>()
  const seqGaps: string[] = []

  for (const path of paths) {
    // Frames must cover the file exactly; a torn tail is legal only while a
    // writer is appending, and is reported rather than thrown on.
    const scan = scanFrames(readFileSync(path))
    const version = Number(/^session\.v(\d+)\.jsonl\.zstd$/.exec(path.split(/[\\/]/).pop()!)![1])
    versions.set(version, (versions.get(version) ?? 0) + 1)
    if (scan.tornStart !== undefined) torn += 1

    const { header, records: events } = readArtifact(path)
    headers += 1
    assert.equal(header.type, 'session', `${path}: first record is the session header`)
    assert.equal(header.version, version, `${path}: header version matches the filename`)

    for (const [index, record] of events.entries()) {
      assert.equal(typeof record.type, 'string', `${path}: record ${index} has no type`)
      assert.equal(typeof record.seq, 'number', `${path}: record ${index} has no seq`)
      assert.equal(typeof record.time, 'number', `${path}: record ${index} has no time`)
      assert.ok('data' in record, `${path}: record ${index} has no data`)
      kinds.set(record.type as string, (kinds.get(record.type as string) ?? 0) + 1)
      if (record.seq !== index) seqGaps.push(`${path.split(/[\\/]/).slice(-3).join('/')}#${index}`)
    }
    records += events.length
  }

  t.diagnostic(`artifacts=${paths.length} headers=${headers} event_records=${records} torn_tail=${torn}`)
  t.diagnostic(`format versions: ${[...versions].sort().map(([v, n]) => `v${v}=${n}`).join(' ')}`)
  t.diagnostic(`event types: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`)
  t.diagnostic(`seq != 0-based index: ${seqGaps.length} occurrence(s)${seqGaps.length ? ' -> ' + seqGaps.slice(0, 5).join(', ') : ''}`)

  assert.equal(headers, paths.length, 'every artifact starts with a header record')
  assert.ok(records > 0, 'real artifacts contain conversation records')
})
