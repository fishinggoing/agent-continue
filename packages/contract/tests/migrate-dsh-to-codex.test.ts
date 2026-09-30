/**
 * Real migration: a DSH session becomes a Codex thread that Codex itself resumes.
 *
 * The conversion half runs anywhere. The acceptance half writes into an isolated
 * Codex home and runs the real CLI, so it is skipped unless `CODEX_CLI` and
 * `CODEX_PROBE_HOME` are set.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { findArtifacts, readArtifact, sessionRoot } from '../../dsh-adapter/tests/corpus.ts'
import { registerThread, seedProjectionCursor, writeRollout } from '../../codex-adapter/src/write.ts'
import { convertDshToCodex } from '../src/dsh-to-codex.ts'

test('converts a real DSH session into a thread Codex resumes', async (t) => {
  let paths: string[]
  try {
    paths = findArtifacts(sessionRoot(), 80)
  } catch {
    t.skip(`no DSH session store at ${sessionRoot()}`)
    return
  }

  // A session whose own cwd exists: Codex runs the resumed turn in that directory.
  let source: { path: string; artifact: ReturnType<typeof readArtifact> } | undefined
  for (const path of paths) {
    let artifact: ReturnType<typeof readArtifact>
    try {
      artifact = readArtifact(path)
    } catch {
      continue
    }
    const cwd = artifact.header.cwd
    if (artifact.header.version !== 4) continue
    if (artifact.header.parentSession !== undefined || artifact.header.origin !== undefined) continue
    if (typeof cwd !== 'string' || !existsSync(cwd)) continue
    if (!artifact.records.some((record) => record.type === 'user/message')) continue
    if (!artifact.records.some((record) => record.type === 'assistant/message')) continue
    source = { path, artifact }
    break
  }
  if (source === undefined) {
    t.skip('no suitable DSH session in the store (version 4, top-level, existing cwd, has messages)')
    return
  }

  const { header } = source.artifact
  const events = source.artifact.records as never[]
  const cwd = header.cwd as string
  const cliVersion = process.env.CODEX_PROBE_CLI_VERSION ?? '0.155.0-alpha.16'

  // Codex resolves `resume` by UUID first, and `session_meta.id` must match the
  // registered thread id, so the migrated thread gets its own UUID.
  const threadId = randomUUID()
  const conversion = convertDshToCodex(header, events, { cliVersion, threadId })
  t.diagnostic(`source: ${source.path}`)
  t.diagnostic(`source events=${events.length} -> codex records=${conversion.drafts.length}`)
  for (const loss of conversion.losses) t.diagnostic(`loss: ${loss}`)

  assert.equal(conversion.drafts[0]?.type, 'session_meta', 'the rollout starts with session metadata')
  assert.ok(conversion.drafts.length > 1, 'the conversion produced conversation records')

  const cli = process.env.CODEX_CLI
  const home = process.env.CODEX_PROBE_HOME
  if (!cli || !home) {
    t.diagnostic('skipping harness acceptance: set CODEX_CLI and CODEX_PROBE_HOME')
    return
  }

  // A fresh UUID: Codex resolves `resume` by UUID first, and reusing the DSH id
  // would collide with whatever already registered it.
  const when = new Date(header.createdAt)
  const seconds = Math.floor(when.getTime() / 1000)
  const written = writeRollout(home, threadId, when, conversion.drafts, { overwrite: true })
  registerThread(join(home, 'state_5.sqlite'), {
    id: threadId,
    rolloutPath: written.path,
    createdAt: seconds,
    updatedAt: seconds,
    source: 'exec',
    modelProvider: 'example-provider',
    cwd,
    title: `imported from DSH ${header.id}`,
    model: 'example-model',
    reasoningEffort: 'xhigh',
    firstUserMessage: `imported from DSH ${header.id}`,
    originator: 'codex_exec',
    cliVersion,
  }, { overwrite: true })
  seedProjectionCursor(join(home, 'thread_history_1.sqlite'), threadId)
  t.diagnostic(`wrote ${written.path} (${written.bytes} bytes, ${written.records} records) and registered ${threadId}`)

  const before = statSync(written.path).size
  const result = spawnSync(cli, ['exec', 'resume', threadId, 'reply with: ok'], {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8',
    timeout: 900_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

  assert.equal(result.status, 0, `codex exec resume failed: ${output.slice(-900)}`)
  const after = statSync(written.path).size
  t.diagnostic(`rollout grew ${before} -> ${after} bytes`)
  assert.ok(after > before, 'Codex appended to the migrated rollout')
})
