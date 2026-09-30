/**
 * End-to-end acceptance: a session this package writes must be listed and
 * resumed by the real harness.
 *
 * Skipped unless `DSH_CLI` names a `dsh.cmd` launcher and `DSH_PROBE_HOME` names
 * an isolated harness home, because it boots a real DSH process and writes into
 * that home. Run it with:
 *
 *   $env:DSH_CLI='F:\dsh\app\resources\runtime\cli\bin\dsh.cmd'
 *   $env:DSH_PROBE_HOME='F:\agent-continue\.agent-continue\probe\dsh-home'
 *   $env:DSH_PROBE_PROFILE='probe-acp'
 *   node --test tests/resume.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseSessionLog, type SessionEvent, type SessionHeader } from '../src/format.ts'
import { readFrames } from '../src/zstd.ts'
import { writeArtifact } from '../src/write.ts'
import { withAcp } from './acp.ts'

/** Provider and model the probe home's ACP profile is configured with. */
const PROBE_PROVIDER = 'deepseek-official'
const PROBE_MODEL = 'deepseek-flash'

test('a hand-written session is listed and resumed by DSH', async (t) => {
  const cli = process.env.DSH_CLI
  const home = process.env.DSH_PROBE_HOME
  if (!cli || !home) {
    t.skip('set DSH_CLI and DSH_PROBE_HOME to run the end-to-end acceptance test')
    return
  }
  const profile = process.env.DSH_PROBE_PROFILE ?? 'probe-acp'
  const cwd = process.env.DSH_PROBE_CWD ?? process.cwd()
  const id = `import-probe-${Date.now().toString(36)}`
  const t0 = Date.now()

  const header: SessionHeader = {
    type: 'session', version: 4, id, createdAt: t0, cwd, isSeeded: false, delegationDepth: 0,
  }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: t0, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: t0 + 1,
      data: { id: `${id}-u1`, role: 'user', content: [{ type: 'text', text: 'imported probe question' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    { type: 'step/start', seq: 2, time: t0 + 2, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: t0 + 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `${id}-a1`,
          role: 'assistant',
          content: [{ type: 'text', text: 'imported probe answer' }],
          source: { kind: 'model', provider: PROBE_PROVIDER, model: PROBE_MODEL },
        },
        stream: [],
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 4, time: t0 + 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: t0 + 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  const written = writeArtifact(join(home, 'sessions'), header, events)
  t.diagnostic(`wrote ${written.path} (${written.bytes} bytes, ${written.frames} frames)`)

  // The bytes we produce must decode through our own reader before DSH sees them.
  const readBack = parseSessionLog(readFrames(readFileSync(written.path)).text, 4)
  assert.equal(readBack.header.id, id)
  assert.equal(readBack.events.length, events.length)

  await withAcp({ cli, home, profile }, async (call) => {
    const listed = await call('session/list', { cwd })
    assert.equal(listed.error, undefined, `session/list failed: ${JSON.stringify(listed.error)}`)
    const sessions = (listed.result?.sessions ?? []) as { sessionId: string }[]
    t.diagnostic(`session/list returned ${sessions.length} session(s)`)
    assert.ok(sessions.some((session) => session.sessionId === id), 'DSH lists the imported session')

    const resumed = await call('session/resume', { sessionId: id, cwd })
    assert.equal(resumed.error, undefined, `session/resume failed: ${JSON.stringify(resumed.error)}`)
    assert.ok(resumed.result?.configOptions !== undefined, 'resume returns config options')
  })
})
