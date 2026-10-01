import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execute } from '../src/command.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { compactedSource, activeEvents } from '../../contract/tests/compaction-fixture.ts'
import { withRpcServer } from './native.ts'
import { MESSAGES_REPLY, withMessagesFixture } from './messages.ts'

for (const scenario of ['uncompressed', 'plaintext', 'repeated', 'retained-tool', 'unknown-outcome', 'workspace-remap']) {
  test(`native DSH compaction projection and restart: ${scenario}`, { timeout: 90_000 }, async (context) => {
    const binary = process.env.AGENT_CONTINUE_DSH_CLI
    const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
    if (!binary || !probeRoot || process.platform !== 'win32') {
      context.skip('Set AGENT_CONTINUE_DSH_CLI and AGENT_CONTINUE_NATIVE_ROOT for isolated Windows DSH verification')
      return
    }
    assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
    const root = mkdtempSync(join(probeRoot, `cli-compaction-${scenario}-`))
    assert.equal(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status, 0)
    writeFileSync(join(root, 'AGENTS.md'), 'Only use this isolated workspace. Do not read parent directories or use subagents.\n')
    const home = join(root, 'dsh-home')
    for (const directory of ['appdata', 'localappdata', 'temp']) mkdirSync(join(home, directory), { recursive: true })
    const profile = 'compaction-projection'
    await withMessagesFixture(async (fixture) => {
      const env = {
        DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile),
        USERPROFILE: home, HOME: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
        TEMP: join(home, 'temp'), TMP: join(home, 'temp'), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        DEEPSEEK_API_KEY: 'isolated-fake-key', DEEPSEEK_BASE_URL: fixture.baseUrl, DSH_TELEMETRY_DISABLED: '1',
      }
      const configured = spawnSync('cmd.exe', ['/d', '/c', binary, profile, '--from-default-profile', 'acp', '--dump-config'], {
        cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      })
      assert.equal(configured.status, 0)
      writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), [
        '- id: acp', '  config:', '    provider: deepseek-official', '    model: deepseek-flash',
        '- id: llm-deepseek', '  config:', `    baseURL: ${JSON.stringify(fixture.baseUrl)}`,
        ...['llm-deepseek-account', 'session-telemetry-otel', 'tool-subagent', 'tool-subagent-fork', 'tool-web', 'tool-skill'].flatMap((id) => [`- id: ${id}`, '  disabled: true']), '',
      ].join('\n'))
      const source = compactedSource(root)
      if (scenario === 'workspace-remap') source[0]!.payload.cwd = join(root, 'previous-workspace')
      const compacted = source.find((record) => record.type === 'compacted')!
      if (scenario === 'uncompressed') source.splice(source.indexOf(compacted), 1)
      if (scenario === 'repeated') {
        source.splice(source.indexOf(compacted), 0, { ...compacted, payload: {
          replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'OBSOLETE INTERMEDIATE SUMMARY' }] }],
        } })
      }
      if (scenario === 'retained-tool') {
        (compacted.payload.replacement_history as any[]).push(
          { type: 'function_call', call_id: 'retained-call', name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: 'retained-call', output: 'RETAINED TOOL OUTPUT' },
        )
      }
      if (scenario === 'unknown-outcome') {
        const result = source.find((record) => record.payload.type === 'function_call_output')!
        result.payload.recovery = 'TOOL_OUTCOME_UNKNOWN'
        result.payload.isError = true
      }
      const input = join(root, 'source.jsonl')
      writeFileSync(input, source.map((record, ordinal) => JSON.stringify({ ...record, ordinal })).join('\n') + '\n')
      const id = randomUUID()
      const report = execute(['migrate', '--from', 'codex', '--input', input, '--cwd', root, '--target-home', home, '--id', id])
      assert.equal(report.modelRequests, 0)
      assert.equal(report.toolsExecuted, 0)
      const output = (report.output as { path: string }).path
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await withRpcServer('cmd.exe', ['/d', '/c', binary, profile], env, root, async (call, notifications) => {
          const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent_continue_compaction_test', version: '0.0.1' } })
          assert.equal(initialized.error, undefined)
          context.diagnostic(`Native DSH: ${JSON.stringify(initialized.result?.agentInfo)}`)
          const listed = await call('session/list', { cwd: root })
          assert.equal(listed.error, undefined)
          assert.ok((listed.result?.sessions as { sessionId: string }[]).some((session) => session.sessionId === id))
          const resumed = await call('session/resume', { sessionId: id, cwd: root, mcpServers: [] })
          assert.equal(resumed.error, undefined, JSON.stringify(resumed.error))
          assert.equal(fixture.requests.length, attempt)
          const response = await call('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: '\u7ee7\u7eed' }] })
          assert.equal(response.error, undefined, JSON.stringify(response.error))
          assert.equal(fixture.requests.length, attempt + 1)
          const projection = JSON.stringify(fixture.requests.at(-1)!.messages)
          const activeTexts = ['ORIGINAL REQUIREMENTS', scenario === 'uncompressed' ? 'OBSOLETE PARTIAL PLAN' : 'COMPACTED STATE', 'CONTINUE AFTER COMPACTION', 'POST-COMPACTION WORK', '\u7ee7\u7eed']
          for (const text of activeTexts) assert.ok(projection.includes(text), text)
          for (const text of [
            ...(scenario === 'uncompressed' ? [] : ['OBSOLETE PARTIAL PLAN']),
            ...(['uncompressed', 'unknown-outcome'].includes(scenario) ? [] : ['ARCHIVED TOOL RESULT']),
            'UNUSED SUMMARY FALLBACK', 'OBSOLETE INTERMEDIATE SUMMARY',
          ]) assert.ok(!projection.includes(text), text)
          const ordered = activeTexts.map((text) => projection.indexOf(text))
          assert.ok(ordered.every((position, index) => index === 0 || position > ordered[index - 1]!))
          if (scenario === 'retained-tool') assert.ok(projection.includes('retained-call') && projection.includes('RETAINED TOOL OUTPUT'))
          if (scenario === 'unknown-outcome') {
            assert.ok(projection.includes('TOOL_OUTCOME_UNKNOWN') && projection.includes('archived-call'))
            const blocks = (fixture.requests.at(-1)!.messages as any[]).flatMap(message => message.content)
            const calls = blocks.filter(block => block.type === 'tool_use' && block.id === 'archived-call')
            const results = blocks.filter(block => block.type === 'tool_result' && block.tool_use_id === 'archived-call')
            assert.equal(calls.length, 1)
            assert.equal(results.length, 1)
            assert.equal(results[0].is_error, true)
            assert.deepEqual(results[0].content, [{ type: 'text', text: 'ARCHIVED TOOL RESULT' }])
            const restored = parseSessionLog(readFrames(readFileSync(output)).text, 4)
            const active = activeEvents(restored.events).filter(event => event.type === 'tool/result')
            assert.equal(active.length, 1)
            assert.equal((active[0]!.data as any).error.code, 'TOOL_OUTCOME_UNKNOWN')
            assert.equal((active[0]!.data as any).message.toolCallId, 'archived-call')
          }
          if (scenario === 'workspace-remap') assert.ok(projection.includes('agent-continue') && projection.includes('Previous workspace') && projection.includes('Continue only in the current workspace'))
          assert.equal(fixture.unexpectedCredential, false)
          assert.ok(!notifications.some((notification) => notification.id !== undefined), 'Archived tools must not execute or request approval')
          const closed = await call('session/close', { sessionId: id })
          assert.equal(closed.error, undefined)
          const restored = parseSessionLog(readFrames(readFileSync(output)).text, 4)
          assert.ok(JSON.stringify(restored.events).includes('OBSOLETE PARTIAL PLAN'), 'Audit history remains intact')
          assert.equal(JSON.stringify(activeEvents(restored.events)).includes('OBSOLETE PARTIAL PLAN'), scenario === 'uncompressed')
          assert.ok(JSON.stringify(restored.events).includes(MESSAGES_REPLY))
        })
      }
      writeFileSync(join(root, 'projection.json'), JSON.stringify(fixture.requests, null, 2))
    })
  })
}
