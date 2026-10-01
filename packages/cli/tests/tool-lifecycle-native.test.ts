import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execute } from '../src/command.ts'
import type { RolloutRecord } from '../../codex-adapter/src/rollout.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { writeArtifact } from '../../dsh-adapter/src/write.ts'
import { CONVERSATION_TEXTS, codexConversation, codexRecords, dshLog } from './fixtures.ts'
import { withRpcServer } from './native.ts'

const scenarios = ['parallel-completed', 'parallel-partial-followup', 'parallel-assistant-interleaved', 'assistant-before-result', 'native-assistant-before-result-control'] as const

for (const scenario of scenarios) {
  test(`DSH native tool lifecycle boundary: ${scenario}`, { timeout: 90_000 }, async (context) => {
    const binary = process.env.AGENT_CONTINUE_DSH_CLI
    const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
    if (!binary || !probeRoot || process.platform !== 'win32') {
      context.skip('Set AGENT_CONTINUE_DSH_CLI and AGENT_CONTINUE_NATIVE_ROOT for Windows isolated DSH verification')
      return
    }
    assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
    const root = mkdtempSync(join(probeRoot, 'cli-tool-lifecycle-'))
    const home = join(root, 'dsh-home')
    const appdata = join(home, 'appdata')
    const localappdata = join(home, 'localappdata')
    mkdirSync(appdata, { recursive: true })
    mkdirSync(localappdata)
    const profile = 'codex-tool-lifecycle-test'
    const env = {
      DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile),
      USERPROFILE: home, HOME: home, APPDATA: appdata, LOCALAPPDATA: localappdata,
      SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
    }
    const configured = spawnSync('cmd.exe', ['/d', '/c', binary, profile, '--from-default-profile', 'acp', '--dump-config'], {
      cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(configured.status, 0, 'Isolated ACP profile initialization succeeds without user credentials')

    const parallel = scenario.startsWith('parallel-')
    const interrupted = scenario === 'parallel-partial-followup'
    const nativeControl = scenario === 'native-assistant-before-result-control'
    const id = randomUUID()
    const pending = interrupted ? [{ callId: 'synthetic-second-call', name: 'synthetic_second_tool', state: 'unknown' }] : []
    let outputPath: string
    if (nativeControl) {
      const source = dshLog(root, 'completed')
      const resultIndex = source.events.findIndex((event) => event.type === 'tool/result')
      const assistant = source.events.find((event) => event.type === 'assistant/message')!
      source.events.splice(resultIndex, 0, {
        type: 'assistant/message', seq: resultIndex, time: assistant.time,
        surfaceOp: 'append', data: {
          turn: 1, step: 1, stream: [], message: {
            id: 'synthetic-interleaved-assistant', role: 'assistant',
            source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
            content: [{ type: 'text', text: 'SYNTHETIC INTERLEAVED COMMENT' }],
          },
        },
      })
      source.events.forEach((event, seq) => { event.seq = seq })
      outputPath = writeArtifact(join(home, 'sessions'), { ...source.header, id }, source.events).path
    } else {
      const records = parallel ? codexConversation(root) : codexRecords(root, 'completed')
      const callIndex = records.findIndex((record) => record.payload.type === 'function_call')
      const timestamp = records[callIndex]!.timestamp
      if (parallel) {
        records.splice(callIndex + 1, 0, {
          timestamp, type: 'response_item', payload: {
            type: 'function_call', call_id: 'synthetic-second-call', name: 'synthetic_second_tool', arguments: '{"synthetic":true}',
          },
        })
        if (scenario === 'parallel-assistant-interleaved') {
          records.splice(callIndex + 1, 0, {
            timestamp, type: 'response_item', payload: {
              type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC INTERLEAVED COMMENT' }],
            },
          })
        }
        if (!interrupted) {
          const resultIndex = records.findIndex((record) => record.payload.type === 'function_call_output')
          records.splice(resultIndex, 0, {
            timestamp, type: 'response_item', payload: {
              type: 'function_call_output', call_id: 'synthetic-second-call', output: 'SYNTHETIC SECOND TOOL RESULT',
            },
          })
        }
      } else {
        const comment: RolloutRecord = {
          timestamp, type: 'response_item', payload: {
            type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC INTERLEAVED COMMENT' }],
          },
        }
        records.splice(callIndex + 1, 0, comment)
      }
      const input = join(root, 'source-rollout.jsonl')
      writeFileSync(input, `${records.map((record, ordinal) => JSON.stringify({ ...record, ordinal })).join('\n')}\n`)
      const report = execute(['migrate', '--from', 'codex', '--input', input, '--cwd', root, '--target-home', home, '--id', id])
      assert.deepEqual(report.pendingOperations, pending)
      assert.equal(report.toolsExecuted, 0)
      assert.equal(report.modelRequests, 0)
      outputPath = (report.output as { path: string }).path
    }

    const before = parseSessionLog(readFrames(readFileSync(outputPath)).text, 4)
    const calls = before.events.filter((event) => event.type === 'tool/call')
    assert.equal(calls.length, parallel ? 2 : 1)
    const resultIds = before.events.filter((event) => event.type === 'tool/result').map((event) => {
      const data = event.data as { message: { toolCallId: string } }
      return data.message.toolCallId
    }).sort()
    assert.deepEqual(resultIds, parallel ? ['synthetic-call', 'synthetic-second-call'] : ['synthetic-call'])
    if (interrupted) {
      const unknown = before.events.find((event) => {
        const data = event.data as { error?: { code: string } }
        return event.type === 'tool/result' && data.error?.code === 'TOOL_OUTCOME_UNKNOWN'
      })!
      const secondCall = calls.find((event) => event.data.callId === 'synthetic-second-call')!
      assert.deepEqual(unknown.sourceEventSeqs, [secondCall.seq])
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await withRpcServer('cmd.exe', ['/d', '/c', binary, profile], env, root, async (call, notifications) => {
        const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent_continue_tool_lifecycle_test', version: '0.0.1' } })
        assert.equal(initialized.error, undefined)
        context.diagnostic(`Native DSH agent: ${JSON.stringify(initialized.result?.agentInfo ?? null)}`)
        const listed = await call('session/list', { cwd: root })
        assert.equal(listed.error, undefined)
        assert.ok((listed.result?.sessions as { sessionId: string }[]).some((session) => session.sessionId === id))
        const resumed = await call('session/resume', { cwd: root, sessionId: id })
        assert.equal(resumed.error, undefined, `Native DSH rejected converted history: ${JSON.stringify(resumed.error)}`)
        assert.ok(!notifications.some((notification) => notification.id !== undefined), 'No historical tool execution or approval request is issued')
      })
      const after = parseSessionLog(readFrames(readFileSync(outputPath)).text, 4)
      assert.equal(after.events.filter((event) => event.type === 'turn/start').length, parallel ? 2 : 1)
      const history = JSON.stringify(after.events)
      for (const text of parallel ? CONVERSATION_TEXTS : ['SYNTHETIC PRIVATE QUESTION', 'SYNTHETIC PRIVATE ANSWER', 'SYNTHETIC INTERLEAVED COMMENT']) {
        assert.ok(history.includes(text), `History preserves ${text}`)
      }
      const results = after.events.filter((event) => event.type === 'tool/result')
      assert.equal(results.length, parallel ? 2 : 1)
      const known = results.find((event) => (event.data as { message: { toolCallId: string } }).message.toolCallId === 'synthetic-call')!
      assert.ok(JSON.stringify(known.data).includes('SYNTHETIC PRIVATE RESULT'))
      if (parallel && !interrupted) assert.ok(history.includes('SYNTHETIC SECOND TOOL RESULT'))
      if (scenario === 'parallel-assistant-interleaved') assert.ok(history.includes('SYNTHETIC INTERLEAVED COMMENT'))
      if (!parallel) assert.ok(JSON.stringify(after.events).includes('SYNTHETIC INTERLEAVED COMMENT'))
      if (interrupted) {
        const unknown = results.find((event) => (event.data as { message: { toolCallId: string } }).message.toolCallId === 'synthetic-second-call')!
        const data = unknown.data as { error: { code: string }; message: { isError: boolean } }
        assert.equal(data.error.code, 'TOOL_OUTCOME_UNKNOWN')
        assert.equal(data.message.isError, true)
      }
      assert.deepEqual(execute(['inspect', '--from', 'dsh', '--input', outputPath]).pendingOperations, pending)
    }
  })
}
