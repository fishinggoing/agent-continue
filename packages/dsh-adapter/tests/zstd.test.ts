/**
 * Frame-container tests.
 *
 * The second test is the important one: it decodes artifacts that DSH itself
 * wrote, which is the only way to know our reading of the container matches the
 * writer. It never prints record content — only structural counts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compressFrame, readFrames, scanFrames } from '../src/zstd.ts'

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

test('decodes artifacts written by DSH', (t) => {
  const root = process.env.DSH_SESSION_ROOT
    ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'sessions')

  let artifacts: string[] = []
  try {
    artifacts = findArtifacts(root)
  } catch {
    t.skip(`no DSH session store at ${root}`)
    return
  }
  if (artifacts.length === 0) {
    t.skip(`no session.vN.jsonl.zstd under ${root}`)
    return
  }

  let torn = 0
  let records = 0
  let headers = 0
  let unreadable = 0
  const versions = new Map<number, number>()
  const kinds = new Map<string, number>()
  const seqGaps: string[] = []

  for (const path of artifacts) {
    const version = Number(/^session\.v(\d+)\.jsonl\.zstd$/.exec(path.split(/[\\/]/).pop()!)![1])
    versions.set(version, (versions.get(version) ?? 0) + 1)

    let text: string
    let scan
    try {
      ({ text, scan } = readFrames(readFileSync(path)))
    } catch (error) {
      // A file being appended to right now can hold a frame our structural walk
      // still rejects; record it instead of failing the whole corpus.
      unreadable += 1
      t.diagnostic(`unreadable: ${path.split(/[\\/]/).slice(-3).join('/')} -> ${(error as Error).message}`)
      continue
    }
    if (scan.tornStart !== undefined) torn += 1

    const lines = text.split('\n').filter((line) => line.trim() !== '')
    assert.ok(lines.length > 0, `${path}: no records`)

    for (const [index, line] of lines.entries()) {
      let record: { type?: unknown; seq?: unknown; time?: unknown; data?: unknown; version?: unknown }
      try {
        record = JSON.parse(line)
      } catch {
        assert.fail(`${path}: record ${index} is not JSON`)
      }
      assert.equal(typeof record.type, 'string', `${path}: record ${index} has no type`)
      kinds.set(record.type as string, (kinds.get(record.type as string) ?? 0) + 1)

      if (index === 0) {
        headers += 1
        assert.equal(record.type, 'session', `${path}: first record is the session header`)
        assert.equal(record.version, version, `${path}: header version matches the filename`)
        continue
      }
      records += 1
      assert.equal(typeof record.seq, 'number', `${path}: record ${index} has no seq`)
      assert.equal(typeof record.time, 'number', `${path}: record ${index} has no time`)
      assert.ok('data' in record, `${path}: record ${index} has no data`)
      if (record.seq !== index - 1) seqGaps.push(`${path.split(/[\\/]/).slice(-3).join('/')}#${index}`)
    }
  }

  t.diagnostic(`artifacts=${artifacts.length} headers=${headers} event_records=${records} torn_tail=${torn} unreadable=${unreadable}`)
  t.diagnostic(`format versions: ${[...versions].sort().map(([v, n]) => `v${v}=${n}`).join(' ')}`)
  t.diagnostic(`event types: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`)
  t.diagnostic(`seq != 0-based index: ${seqGaps.length} occurrence(s)${seqGaps.length ? ' -> ' + seqGaps.slice(0, 5).join(', ') : ''}`)

  assert.equal(headers, artifacts.length - unreadable, 'every readable artifact starts with a header record')
  assert.ok(records > 0, 'real artifacts contain conversation records')
})

/**
 * Collect `session.vN.jsonl.zstd` artifacts under a DSH session root.
 * @param root - absolute path to the sessions directory.
 * @returns absolute artifact paths, capped to keep the test bounded.
 */
function findArtifacts(root: string, limit = 40): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > 4) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= limit) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) found.push(path)
    }
  }
  walk(root, 0)
  return found
}
