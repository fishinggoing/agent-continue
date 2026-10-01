/**
 * End-to-end acceptance: a thread this package writes must be resumed by the
 * real Codex CLI.
 *
 * Skipped unless `CODEX_CLI` names a `codex` executable and `CODEX_PROBE_HOME`
 * names an isolated Codex home that has been initialized once (any `codex exec`
 * run creates the SQLite stores). Run it with:
 *
 *   $env:CODEX_CLI='C:\Users\...\codex.exe'
 *   $env:CODEX_PROBE_HOME='F:\agent-continue\.agent-continue\probe\codex-home'
 *   node --test tests/resume.test.ts
 *
 * The prompt costs one small model call on whatever the probe home's config
 * points at.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

import { registerThread, writeRollout, type RolloutDraft } from '../src/write.ts'

/** The provider and model the probe home is configured with. */
const PROBE_PROVIDER = 'example-provider'
const PROBE_MODEL = 'example-model'
/**
 * `session_meta.cli_version` is effectively required: a rollout that omits it
 * makes Codex fail to read the session metadata and report the misleading
 * "does not start with session metadata" instead.
 */
const PROBE_CLI_VERSION = process.env.CODEX_PROBE_CLI_VERSION ?? '0.155.0-alpha.16'

test('a hand-written thread is resumed by the Codex CLI', (t) => {
  const cli = process.env.CODEX_CLI
  const home = process.env.CODEX_PROBE_HOME
  if (!cli || !home) {
    t.skip('set CODEX_CLI and CODEX_PROBE_HOME to run the end-to-end acceptance test')
    return
  }

  const cwd = process.env.CODEX_PROBE_CWD ?? process.cwd()
  const id = randomUUID()
  const turnId = randomUUID()
  const when = new Date()
  const seconds = Math.floor(when.getTime() / 1000)
  const question = 'imported probe question'
  const answer = 'imported probe answer'

  const message = (role: string, text: string, kind: string): RolloutDraft => ({
    type: 'response_item',
    payload: {
      type: 'message',
      id: `msg_${randomUUID()}`,
      role,
      content: [{ type: kind, text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  })
  const completed = (itemType: string, text: string, kind: string): RolloutDraft => ({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: id,
      turn_id: turnId,
      item: { type: itemType, id: `item_${randomUUID()}`, client_id: null, content: [{ type: kind, text }] },
      started_at_ms: when.getTime(),
      completed_at_ms: when.getTime() + 1,
    },
  })

  const drafts: RolloutDraft[] = [
    {
      type: 'session_meta',
      payload: {
        session_id: id,
        id,
        timestamp: when.toISOString(),
        cwd,
        runtime_workspace_roots: [cwd],
        originator: 'codex_exec',
        cli_version: PROBE_CLI_VERSION,
        source: 'exec',
        thread_source: 'user',
        model_provider: PROBE_PROVIDER,
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, started_at: seconds } },
    message('user', question, 'input_text'),
    { type: 'turn_context', payload: { turn_id: turnId, root_turn_id: turnId, cwd, model: PROBE_MODEL, approval_policy: 'never', sandbox_policy: { type: 'disabled' } } },
    message('assistant', answer, 'output_text'),
    completed('UserMessage', question, 'input_text'),
    completed('AgentMessage', answer, 'output_text'),
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: answer, started_at: seconds, completed_at: seconds + 1, duration_ms: 1000 } },
  ]

  const written = writeRollout(home, id, when, drafts)
  registerThread(join(home, 'state_5.sqlite'), {
    id,
    rolloutPath: written.path,
    createdAt: seconds,
    updatedAt: seconds,
    source: 'exec',
    modelProvider: PROBE_PROVIDER,
    cwd,
    title: question,
    model: PROBE_MODEL,
    reasoningEffort: 'xhigh',
    firstUserMessage: question,
    originator: 'codex_exec',
  })
  t.diagnostic(`wrote ${written.path} (${written.bytes} bytes, ${written.records} records) and registered the thread`)

  const before = statSync(written.path).size
  const result = spawnSync(cli, ['exec', 'resume', id, 'reply with: ok'], {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8',
    timeout: 900_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

  assert.equal(result.status, 0, `codex exec resume failed: ${output.slice(-800)}`)
  assert.ok(output.includes(id), 'Codex reports the session id we registered')

  // The decisive check: Codex appended its new turn to OUR rollout rather than
  // starting a fresh file, which is only possible if it loaded our history.
  const after = statSync(written.path).size
  t.diagnostic(`rollout grew ${before} -> ${after} bytes`)
  assert.ok(after > before, 'Codex appended to the imported rollout')
})
