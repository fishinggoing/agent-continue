import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { auditCombinedHandoff } from './live-handoff-audit.ts'

const repository = resolve(import.meta.dirname, '../../..')

test('completion audit refuses user directories before opening conversation files', async () => {
  for (const root of [repository, join(repository, '.agent-continue'), resolve(repository, '..')]) {
    await assert.rejects(auditCombinedHandoff(repository, root), /fresh live-handoff directory/)
  }
})

for (const evidence of [{ status: 'failed' }, { status: 'passed', longContext: {}, quotaRefusal: undefined }]) {
  test(`completion audit does not merge separate or incomplete proofs: ${evidence.status}`, async () => {
    const runtime = join(repository, '.agent-continue')
    mkdirSync(runtime, { recursive: true })
    const root = mkdtempSync(join(runtime, 'live-handoff-audit-'))
    writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence))
    try {
      await assert.rejects(auditCombinedHandoff(repository, root), /Incomplete or failed|same source execution/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
