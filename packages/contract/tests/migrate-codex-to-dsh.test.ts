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

  // The target id is derived from the source, so re-running replaces the artifact
  // deliberately; the writer refuses to do that unless asked.
  const written = writeArtifact(join(home, 'sessions'), conversion.header, conversion.events, { overwrite: true })
  t.diagnostic(`wrote ${written.path} (${written.bytes} bytes, ${written.frames} frames)${written.replaced ? ' [replaced]' : ''}`)

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

/**
 * The open-tail shape must be loadable, not merely well-formed.
 *
 * A source turn with an unresolved tool call can be imported only as a log whose
 * tail is left open for DSH's recovery, and the import then has to stop: DSH
 * rejects `turn/start` while a turn is open. This asserts the real harness
 * accepts that truncated artifact — the unit test only proves we emit it.
 */
test('DSH accepts an import truncated at an open tail', async (t) => {
  const cli = process.env.DSH_CLI
  const home = process.env.DSH_PROBE_HOME
  if (!cli || !home) {
    t.skip('set DSH_CLI and DSH_PROBE_HOME to run the harness acceptance test')
    return
  }
  const cwd = process.env.DSH_PROBE_CWD ?? process.cwd()
  const sessionId = `open-tail-${Date.now().toString(36)}`
  const t0 = Date.now()

  const records = [
    { timestamp: new Date(t0).toISOString(), ordinal: 0, type: 'session_meta', payload: { id: sessionId, cwd, model_provider: 'example-provider' } },
    { timestamp: new Date(t0).toISOString(), ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: Math.floor(t0 / 1000) } },
    { timestamp: new Date(t0).toISOString(), ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'run the tool' }] } },
    { timestamp: new Date(t0).toISOString(), ordinal: 3, type: 'turn_context', payload: { turn_id: 't1', cwd, model: 'example-model' } },
    // Started, never finished: the import must leave the tail open.
    { timestamp: new Date(t0).toISOString(), ordinal: 4, type: 'response_item', payload: { type: 'function_call', id: 'f1', call_id: 'c-1', name: 'shell', arguments: '{"cmd":"ls"}' } },
    { timestamp: new Date(t0).toISOString(), ordinal: 5, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', started_at: Math.floor(t0 / 1000), completed_at: Math.floor(t0 / 1000) } },
  ].map((record) => JSON.stringify(record)).join('\n')

  const conversion = convertCodexToDsh(parseRollout(records).records, { sessionId, cwd })
  assert.equal(conversion.events.filter((event) => event.type === 'turn/end').length, 0, 'the tail is open')

  const written = writeArtifact(join(home, 'sessions'), conversion.header, conversion.events, { overwrite: true })
  t.diagnostic(`wrote ${written.path} (${written.bytes} bytes)`)
  t.diagnostic(`losses: ${conversion.losses.join(' | ') || '(none)'}`)

  await withAcp({ cli, home, profile: process.env.DSH_PROBE_PROFILE ?? 'probe-acp', timeoutMs: 120_000 }, async (call) => {
    const listed = await call('session/list', { cwd })
    assert.equal(listed.error, undefined, `session/list failed: ${JSON.stringify(listed.error)}`)
    const sessions = (listed.result?.sessions ?? []) as { sessionId: string }[]
    assert.ok(sessions.some((session) => session.sessionId === sessionId), 'DSH lists the truncated session')

    const resumed = await call('session/resume', { sessionId, cwd })
    assert.equal(resumed.error, undefined,
      `DSH rejected the open-tail import (its recovery is supposed to balance it): ${JSON.stringify(resumed.error)}`)
  })
})
