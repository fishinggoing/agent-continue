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
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { findArtifacts, readArtifact, sessionRoot } from '../../dsh-adapter/tests/corpus.ts'
import { registerThread, writeRollout } from '../../codex-adapter/src/write.ts'
import { writeArtifact } from '../../dsh-adapter/src/write.ts'
import { dshLog } from '../../cli/tests/fixtures.ts'
import { convertDshToCodex } from '../src/dsh-to-codex.ts'

function usableDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || !isAbsolute(value)) return false
  try { return statSync(value).isDirectory() } catch { return false }
}

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
  let unavailableDirectories = 0
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
    if (!artifact.records.some((record) => record.type === 'user/message')) continue
    if (!artifact.records.some((record) => record.type === 'assistant/message')) continue
    if (!usableDirectory(cwd)) {
      unavailableDirectories += 1
      continue
    }
    source = { path, artifact }
    break
  }
  if (source === undefined) {
    t.skip(unavailableDirectories > 0
      ? `no usable source working directory (${unavailableDirectories} missing, non-directory or non-absolute cwd)`
      : 'no suitable DSH session in the store (version 4, top-level, existing cwd, has messages)')
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
  if (!usableDirectory(cwd)) {
    t.skip('source working directory became unavailable before native acceptance')
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
  t.diagnostic(`wrote ${written.path} (${written.bytes} bytes, ${written.records} records) and registered ${threadId}`)

  const before = statSync(written.path).size
  if (!usableDirectory(cwd)) {
    t.skip('source working directory became unavailable before spawning Codex')
    return
  }
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

  // File growth only proves the thread was resumed. Paginated history must be
  // materialized too, or Codex opens the thread to an empty conversation.
  // Codex's P1 report caught exactly that: registration and resume both reported
  // success while `thread/list` omitted the thread and `items/list` failed with
  // "source rollout is not paginated".
  const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'), { readOnly: true })
  try {
    const items = history.prepare('SELECT item_json FROM thread_items WHERE thread_id = ?').all(threadId) as { item_json: string }[]
    const turns = history.prepare('SELECT COUNT(*) AS c FROM thread_turns WHERE thread_id = ?').get(threadId) as { c: number }
    // The projected item type is camelCase (`userMessage`), while the accepted
    // `item_completed.item.type` is PascalCase (`UserMessage`) and its content
    // block types are `text` / `Text`. Three casings for the same concepts;
    // compare case-insensitively rather than pin a fourth assumption.
    const kinds = items.map((row) => ((JSON.parse(row.item_json) as { type?: string }).type ?? '?').toLowerCase())
    t.diagnostic(`projected items=${items.length} types=[${kinds.join(', ')}] turns=${turns.c}`)
    assert.ok(items.length >= 2, 'Codex projected the imported user and assistant items')
    assert.ok(kinds.includes('usermessage'), 'the user item is projected')
    assert.ok(kinds.includes('agentmessage'), 'the assistant item is projected')
    assert.ok(turns.c >= 1, 'Codex projected at least one turn')
  } finally {
    history.close()
  }
})

for (const scenario of ['missing', 'non-directory'] as const) {
  test(`native acceptance preflight skips ${scenario} source cwd before any binary launch`, () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-continue-cwd-'))
    const cwd = join(root, 'unavailable-source-workspace')
    if (scenario === 'non-directory') writeFileSync(cwd, 'synthetic regular file, not a workspace')
    const sessions = join(root, 'source-sessions')
    const codexHome = join(root, 'codex-home')
    const dshHome = join(root, 'dsh-home')
    mkdirSync(codexHome)
    mkdirSync(dshHome)
    const source = dshLog(cwd, 'none')
    writeArtifact(sessions, { ...source.header, id: randomUUID() }, source.events)
    const result = spawnSync(process.execPath, [
      '--test', '--test-reporter=tap',
      '--test-name-pattern=^converts a real DSH session into a thread Codex resumes$',
      fileURLToPath(import.meta.url),
    ], {
      cwd: root,
      env: {
        SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root,
        CODEX_HOME: codexHome, DSH_HOME: dshHome, DSH_SESSION_ROOT: sessions,
        CODEX_CLI: join(root, 'must-not-spawn.exe'), CODEX_PROBE_HOME: codexHome,
      },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /# SKIP no usable source working directory/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /ENOENT|codex exec resume failed/)
  })
}
