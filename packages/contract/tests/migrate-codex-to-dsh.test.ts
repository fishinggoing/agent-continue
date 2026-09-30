/**
 * Real migration: a Codex rollout becomes a DSH session that DSH itself accepts.
 *
 * The conversion half runs anywhere. The acceptance half writes into an isolated
 * DSH home and drives the real harness over ACP, so it is skipped unless
 * `DSH_CLI` and `DSH_PROBE_HOME` are set.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findRollouts, sessionsRoot, codexHome } from '../../codex-adapter/src/paths.ts'
import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import { parseSessionLog, serializeSessionLog } from '../../dsh-adapter/src/format.ts'
import { writeArtifact } from '../../dsh-adapter/src/write.ts'
import { withAcp } from '../../dsh-adapter/tests/acp.ts'
import { convertCodexToDsh } from '../src/codex-to-dsh.ts'

/** Store to migrate from. */
function storeRoot(): string {
  return process.env.CODEX_SESSIONS_ROOT ?? sessionsRoot(process.env.CODEX_HOME ?? codexHome())
}

test('converts a real Codex rollout into a session DSH accepts', async (t) => {
  let rollouts: ReturnType<typeof findRollouts>
  try {
    rollouts = findRollouts(storeRoot(), { limit: 60, byteBudget: 64 * 1024 * 1024 })
  } catch {
    t.skip(`no Codex session store at ${storeRoot()}`)
    return
  }
  if (rollouts.length === 0) {
    t.skip(`no rollouts under ${storeRoot()}`)
    return
  }
  // Smallest rollout that actually holds a conversation: some sessions are just
  // a `session_meta` line, and converting those proves nothing about mapping.
  let source: (typeof rollouts)[number] | undefined
  let parsed: ReturnType<typeof parseRollout> | undefined
  for (const file of [...rollouts].sort((a, b) => a.bytes - b.bytes).slice(0, 25)) {
    const candidate = parseRollout(readFileSync(file.path, 'utf8'))
    if (candidate.failures.length > 0) continue
    const hasConversation = candidate.records.some((record) =>
      record.type === 'response_item' && record.payload.type === 'message')
    if (!hasConversation) continue
    source = file
    parsed = candidate
    break
  }
  assert.ok(source !== undefined && parsed !== undefined, 'the store holds at least one rollout with messages')

  const meta = parsed.records.find((record) => record.type === 'session_meta')?.payload
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : 'F:\\agent-continue'
  const sessionId = `codex-${source.sessionId}`

  const conversion = convertCodexToDsh(parsed.records, { sessionId, cwd })
  t.diagnostic(`source: ${source.path}`)
  t.diagnostic(`source records=${parsed.records.length} -> dsh events=${conversion.events.length}`)
  t.diagnostic(`mapped: ${Object.entries(conversion.tallies)
    .map(([kind, entry]) => `${kind}=${entry.mapped}${entry.dropped > 0 ? `(+${entry.dropped} dropped)` : ''}`)
    .join(' ')}`)
  for (const loss of conversion.losses) t.diagnostic(`loss: ${loss}`)

  // The produced log has to satisfy the same rules DSH enforces on load.
  const text = serializeSessionLog(conversion.header, conversion.events)
  const reparsed = parseSessionLog(text, 4)
  assert.equal(reparsed.header.id, sessionId)
  assert.equal(reparsed.events.length, conversion.events.length)
  assert.ok(conversion.events.length > 0, 'the conversion produced conversation events')
  assert.ok(
    conversion.events.some((event) => event.type === 'user/message'),
    'the converted session carries at least one user message',
  )

  const cli = process.env.DSH_CLI
  const home = process.env.DSH_PROBE_HOME
  if (!cli || !home) {
    t.diagnostic('skipping harness acceptance: set DSH_CLI and DSH_PROBE_HOME')
    return
  }

  const written = writeArtifact(join(home, 'sessions'), conversion.header, conversion.events)
  t.diagnostic(`wrote ${written.path} (${written.bytes} bytes, ${written.frames} frames)`)

  await withAcp({ cli, home, profile: process.env.DSH_PROBE_PROFILE ?? 'probe-acp', timeoutMs: 120_000 }, async (call) => {
    const listed = await call('session/list', { cwd })
    assert.equal(listed.error, undefined, `session/list failed: ${JSON.stringify(listed.error)}`)
    const sessions = (listed.result?.sessions ?? []) as { sessionId: string }[]
    t.diagnostic(`session/list (cwd=${cwd}) returned ${sessions.length} session(s)`)
    assert.ok(sessions.some((session) => session.sessionId === sessionId), 'DSH lists the migrated session')

    const resumed = await call('session/resume', { sessionId, cwd })
    assert.equal(resumed.error, undefined, `session/resume failed: ${JSON.stringify(resumed.error)}`)
  })
})
