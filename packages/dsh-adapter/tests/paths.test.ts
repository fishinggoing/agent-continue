/**
 * Path derivation tests.
 *
 * The second test replays DSH's own `assertStoredIdentity` check against the
 * real session store: it re-derives each artifact's location from that
 * artifact's header and requires an exact match. A mismatch means a session we
 * write would be rejected as corrupt.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { artifactPath, encodeSegment, generationLogFilename, projectKey } from '../src/paths.ts'
import { readCorpus, sessionRoot } from './corpus.ts'

test('encodes path segments and project keys the way DSH does', () => {
  assert.equal(encodeSegment('session-0df832d7-a36a-47f4-b16f-38bbd8e4022d'),
    'session-0df832d7-a36a-47f4-b16f-38bbd8e4022d')
  assert.equal(encodeSegment('.'), '~002E', 'a lone dot cannot traverse')
  assert.equal(encodeSegment('..'), '~002E~002E', 'a double dot cannot traverse')
  assert.equal(encodeSegment('a~b'), 'a~007Eb', 'the escape character itself is escaped')
  assert.equal(encodeSegment('a/b'), 'a~002Fb', 'separators are escaped, not kept')
  assert.throws(() => encodeSegment(''), /empty path segment/)

  assert.equal(projectKey('F:\\agent-continue'), '--F-agent-continue--')
  assert.equal(projectKey('F:/a//b'), '--F-a-b--', 'separator runs collapse to one dash')
  assert.equal(projectKey('/home/u'), '--home-u--', 'leading separators are stripped')
  assert.equal(projectKey('///'), '--root--', 'an empty slug becomes root')
  assert.equal(projectKey('c:\\a b'), '--c-a~0020b--', 'spaces are escaped')
  assert.throws(() => projectKey(''), /empty project path/)

  const long = projectKey(`F:\\${'x'.repeat(400)}`)
  assert.equal(long.length, 2 + 251 + 2, 'the readable slug is truncated to 251')

  assert.equal(generationLogFilename(0, 'zstd'), 'session.jsonl.zstd', 'version 0 keeps the untagged name')
  assert.equal(generationLogFilename(4, 'zstd'), 'session.v4.jsonl.zstd')
  assert.equal(generationLogFilename(4, 'none'), 'session.v4.jsonl')
  assert.throws(() => generationLogFilename(-1, 'zstd'), /non-negative safe integer/)
})

test('re-derives the stored location of every real artifact from its header', (t) => {
  const artifacts = readCorpus()
  if (artifacts.length === 0) {
    t.skip(`no DSH session store at ${sessionRoot()}`)
    return
  }

  const root = sessionRoot()
  const mismatches: string[] = []
  const versions = new Map<number, number>()
  let withoutCwd = 0

  for (const { path, header } of artifacts) {
    const version = header.version as number
    const cwd = header.cwd as string | undefined
    versions.set(version, (versions.get(version) ?? 0) + 1)
    if (cwd === undefined) withoutCwd += 1

    const expected = artifactPath({ root, cwd, id: header.id as string, version })
    // Compare case-insensitively: Windows path identity is case-insensitive.
    if (expected.toLowerCase() !== path.toLowerCase()) {
      mismatches.push(`${path}\n      expected ${expected}`)
    }
  }

  t.diagnostic(`artifacts=${artifacts.length} versions=${[...versions].sort().map(([v, n]) => `v${v}=${n}`).join(' ')} without_cwd=${withoutCwd}`)
  assert.deepEqual(mismatches, [], 'derived path must equal the stored path for every artifact')
})
