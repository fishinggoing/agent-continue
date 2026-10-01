import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

test('live handoff runner refuses real model calls without explicit opt-in', () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'live-handoff.ts')], {
    env: { ...process.env, AGENT_CONTINUE_LIVE: '' }, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes('Real model calls require AGENT_CONTINUE_LIVE=1'))
  assert.equal(result.stdout, '', 'No workspace or authentication preparation before opt-in')
})

test('verification-only mode refuses to prepare a new paid run', () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'live-handoff.ts')], {
    env: { ...process.env, AGENT_CONTINUE_LIVE: '1', AGENT_CONTINUE_LIVE_VERIFY_ONLY: '1', AGENT_CONTINUE_LIVE_RESUME: '',
      AGENT_CONTINUE_CODEX_CLI: process.execPath, AGENT_CONTINUE_DSH_CLI: process.execPath, AGENT_CONTINUE_PYTHON: process.execPath },
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes('Verification-only mode requires an existing isolated run'))
  assert.equal(result.stdout, '')
})
