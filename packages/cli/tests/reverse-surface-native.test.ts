import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { JsonObject } from '../../codex-adapter/src/rollout.ts'
import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { currentSurface } from '../../dsh-adapter/src/surface.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { writeArtifact } from '../../dsh-adapter/src/write.ts'
import { compactedSource } from '../../contract/tests/compaction-fixture.ts'
import { TOOL_OUTCOME_UNKNOWN } from '../../contract/src/conventions.ts'
import { execute } from '../src/command.ts'
import { configureHome, nativeCliVersion, waitForNotification, withRpcServer, withServer } from './native.ts'
import { withResponsesFixture } from './responses.ts'
import { withMessagesFixture } from './messages.ts'

for (const scenario of ['compacted', 'unknown-repeated', 'in-place', 'late-replacement']) {
  test(`native DSH to Codex surface, provider input and restart: ${scenario}`, { timeout: 120_000 }, async context => {
    const codex = process.env.AGENT_CONTINUE_CODEX_CLI
    const dsh = process.env.AGENT_CONTINUE_DSH_CLI
    const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
    if (!codex || !dsh || !probeRoot || process.platform !== 'win32') {
      context.skip('Set both native binaries and AGENT_CONTINUE_NATIVE_ROOT for isolated Windows verification')
      return
    }
    assert.ok(isAbsolute(codex) && isAbsolute(dsh) && isAbsolute(probeRoot))
    const root = mkdtempSync(join(probeRoot, `reverse-surface-${scenario}-`))
    assert.equal(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status, 0)
    writeFileSync(join(root, 'AGENTS.md'), 'Only use this isolated workspace. Do not read parent directories or use subagents.\n')
    const source = compactedSource(root)
    const unknown = scenario === 'unknown-repeated' || scenario === 'in-place'
    if (unknown) source.find(record => record.payload.type === 'function_call_output')!.payload.recovery = TOOL_OUTCOME_UNKNOWN
    const compacted = source.find(record => record.type === 'compacted')!
    if (scenario === 'in-place') source.splice(source.indexOf(compacted), 1)
    if (scenario === 'unknown-repeated') {
      source.splice(source.indexOf(compacted), 0, { ...compacted, payload: { replacement_history: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'INTERMEDIATE SUMMARY' }] },
      ] } })
    }
    const input = join(root, 'source.jsonl')
    writeFileSync(input, source.map((record, ordinal) => JSON.stringify({ ...record, ordinal })).join('\n') + '\n')
    const home = join(root, 'dsh-home')
    for (const directory of ['appdata', 'localappdata', 'temp']) mkdirSync(join(home, directory), { recursive: true })
    const profile = 'reverse-surface'
    await withMessagesFixture(async fixture => {
      const env = {
        DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile),
        USERPROFILE: home, HOME: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
        TEMP: join(home, 'temp'), TMP: join(home, 'temp'), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        DEEPSEEK_API_KEY: 'isolated-fake-key', DEEPSEEK_BASE_URL: fixture.baseUrl, DSH_TELEMETRY_DISABLED: '1',
      }
      assert.equal(spawnSync('cmd.exe', ['/d', '/c', dsh, profile, '--from-default-profile', 'acp', '--dump-config'], {
        cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      }).status, 0)
      writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), [
        '- id: acp', '  config:', '    provider: deepseek-official', '    model: deepseek-flash',
        '- id: llm-deepseek', '  config:', `    baseURL: ${JSON.stringify(fixture.baseUrl)}`,
        ...['llm-deepseek-account', 'session-telemetry-otel', 'tool-subagent', 'tool-subagent-fork', 'tool-web', 'tool-skill'].flatMap(id => [`- id: ${id}`, '  disabled: true']), '',
      ].join('\n'))
      const migrated = execute(['migrate', '--from', 'codex', '--input', input, '--cwd', root, '--target-home', home])
      let sourcePath = (migrated.output as { path: string }).path
      let id = (migrated.target as { sessionId: string }).sessionId
      if (scenario === 'in-place' || scenario === 'late-replacement') {
        const log = parseSessionLog(readFrames(readFileSync(sourcePath)).text, 4)
        const original = currentSurface(log.events).find(event => event.type === (scenario === 'in-place' ? 'tool/result' : 'user/message'))!
        const data = structuredClone(original.data) as JsonObject
        if (scenario === 'in-place') (data.message as JsonObject).content = [{ type: 'text', text: 'SHORT UNKNOWN RESULT' }]
        else data.content = [{ type: 'text', text: 'LATE FINAL REQUIREMENTS' }]
        const insertedAt = scenario === 'in-place' ? log.events.length - 1 : log.events.length
        log.events.splice(insertedAt, 0, { ...original, seq: insertedAt, data,
          surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
        for (const [seq, event] of log.events.entries()) event.seq = seq
        id = randomUUID()
        sourcePath = writeArtifact(join(home, 'sessions'), { ...log.header, id }, log.events).path
      }
      const pending = unknown ? [{ callId: 'archived-call', name: 'read', state: 'unknown' }] : []
      const restore = async (targetId: string): Promise<void> => {
        await withRpcServer('cmd.exe', ['/d', '/c', dsh, profile], env, root, async (call, notifications) => {
          const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'reverse_surface_test', version: '0.0.1' } })
          assert.equal(initialized.error, undefined)
          context.diagnostic(`DSH: ${JSON.stringify(initialized.result?.agentInfo)}`)
          assert.equal((await call('session/resume', { sessionId: targetId, cwd: root, mcpServers: [] })).error, undefined)
          assert.equal((await call('session/prompt', { sessionId: targetId, prompt: [{ type: 'text', text: '\u7ee7\u7eed' }] })).error, undefined)
          assert.ok(!notifications.some(notification => notification.id !== undefined))
          assert.equal((await call('session/close', { sessionId: targetId })).error, undefined)
        })
      }
      await restore(id)
      assert.equal(fixture.requests.length, 1)
      const dshWire = JSON.stringify(fixture.requests[0]!.messages)
      const expected = scenario === 'in-place'
        ? ['ORIGINAL REQUIREMENTS', 'OBSOLETE PARTIAL PLAN', 'SHORT UNKNOWN RESULT', 'CONTINUE AFTER COMPACTION', 'POST-COMPACTION WORK']
        : [scenario === 'late-replacement' ? 'LATE FINAL REQUIREMENTS' : 'ORIGINAL REQUIREMENTS', 'COMPACTED STATE: completed stage one; stage two remains.', 'CONTINUE AFTER COMPACTION', 'POST-COMPACTION WORK']
      const absent = scenario === 'in-place' ? ['ARCHIVED TOOL RESULT'] : ['OBSOLETE PARTIAL PLAN', 'INTERMEDIATE SUMMARY',
        ...(unknown ? [] : ['ARCHIVED TOOL RESULT', 'archived-call']), ...(scenario === 'late-replacement' ? ['ORIGINAL REQUIREMENTS'] : [])]
      for (const text of expected) assert.ok(dshWire.includes(text), text)
      for (const text of absent) assert.ok(!dshWire.includes(text), text)
      assert.equal(fixture.unexpectedCredential, false)
      const codexHome = join(root, 'codex-home')
      await withResponsesFixture(async responses => {
        configureHome(codexHome, responses.baseUrl)
        await withServer(codex, codexHome, root, async call => {
          assert.equal((await call('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' })).error, undefined)
        })
        const threadId = randomUUID()
        const report = execute(['migrate', '--from', 'dsh', '--input', sourcePath, '--cwd', root, '--target-home', codexHome,
          '--id', threadId, '--cli-version', nativeCliVersion(codex), '--model-provider', 'local-probe', '--model', 'offline-probe'])
        assert.deepEqual(report.pendingOperations, pending)
        const output = (report.output as { path: string }).path
        const parsed = parseRollout(readFileSync(output, 'utf8'))
        assert.equal(parsed.failures.length, 0)
        for (const text of absent) assert.ok(!JSON.stringify(parsed.records).includes(text), text)
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await withServer(codex, codexHome, root, async (call, notifications) => {
            assert.equal((await call('thread/resume', { threadId, cwd: root, model: 'offline-probe', modelProvider: 'local-probe', approvalPolicy: 'on-request', sandbox: 'read-only' })).error, undefined)
            const started = await call('turn/start', { threadId, input: [{ type: 'text', text: `CONTINUE ${attempt}` }], model: 'offline-probe',
              approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } })
            assert.equal(started.error, undefined)
            const turnId = (started.result?.turn as { id: string }).id
            const completed = await waitForNotification(notifications, notification => notification.method === 'turn/completed'
              && (notification.params?.turn as { id?: string })?.id === turnId)
            assert.equal((completed.params?.turn as { status: string }).status, 'completed')
            assert.ok(!notifications.some(notification => notification.id !== undefined))
          })
          const wire = responses.requests[attempt]!.input as JsonObject[]
          const serialized = JSON.stringify(wire)
          const positions = expected.map(text => {
            const matches = wire.flatMap((message, position) => (Array.isArray(message.content)
              ? (message.content as JsonObject[]).some(block => block.text === text)
              : message.output === text) ? [{ message, position }] : [])
            assert.equal(matches.length, 1, `Current surface content appears once: ${text}`)
            const role = text === 'SHORT UNKNOWN RESULT' ? undefined
              : ['OBSOLETE PARTIAL PLAN', 'POST-COMPACTION WORK'].includes(text) ? 'assistant' : 'user'
            if (role !== undefined) assert.equal(matches[0]!.message.role, role, text)
            return matches[0]!.position
          })
          assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)))
          for (const text of absent) assert.ok(!serialized.includes(text), text)
          const calls = wire.filter(message => message.type === 'function_call' && message.call_id === 'archived-call')
          const results = wire.filter(message => message.type === 'function_call_output' && message.call_id === 'archived-call')
          assert.equal(calls.length, unknown ? 1 : 0)
          assert.equal(results.length, unknown ? 1 : 0)
          assert.equal(responses.credentialHeaderPresent, false)
          assert.deepEqual(execute(['inspect', '--from', 'codex', '--input', output]).pendingOperations, pending)
        }
        const returned = execute(['migrate', '--from', 'codex', '--input', output, '--cwd', root, '--target-home', home])
        assert.deepEqual(returned.pendingOperations, pending)
        const returnedPath = (returned.output as { path: string }).path
        const returnedId = (returned.target as { sessionId: string }).sessionId
        await restore(returnedId)
        await restore(returnedId)
        assert.equal(fixture.requests.length, 3)
        const returnedLog = parseSessionLog(readFrames(readFileSync(returnedPath)).text, 4)
        const result = currentSurface(returnedLog.events).filter(event => event.type === 'tool/result')
        assert.equal(result.length, unknown ? 1 : 0)
        if (unknown) assert.equal((result[0]!.data as any).error.code, TOOL_OUTCOME_UNKNOWN)
        assert.deepEqual(execute(['inspect', '--from', 'dsh', '--input', returnedPath]).pendingOperations, pending)
        writeFileSync(join(root, 'codex-projection.json'), JSON.stringify(responses.requests, null, 2))
      })
      writeFileSync(join(root, 'dsh-projection.json'), JSON.stringify(fixture.requests, null, 2))
    })
  })
}
