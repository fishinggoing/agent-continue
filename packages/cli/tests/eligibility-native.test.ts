import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { execute } from '../src/command.ts'
import { parseSessionLog, type SessionHeader } from '../../dsh-adapter/src/format.ts'
import { writeArtifact } from '../../dsh-adapter/src/write.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { codexRecords, dshLog } from './fixtures.ts'
import { withRpcServer } from './native.ts'

test('D16 eligibility matches real DSH ACP visibility without flattening rejected sources', { timeout: 120_000 }, async context => {
  const binary = process.env.AGENT_CONTINUE_DSH_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!binary || !probeRoot || process.platform !== 'win32') {
    context.skip('Set AGENT_CONTINUE_DSH_CLI and AGENT_CONTINUE_NATIVE_ROOT for Windows isolated DSH verification')
    return
  }
  assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
  const root = mkdtempSync(join(probeRoot, 'cli-eligibility-'))
  const home = join(root, 'dsh-home')
  const appdata = join(home, 'appdata')
  const localappdata = join(home, 'localappdata')
  mkdirSync(appdata, { recursive: true })
  mkdirSync(localappdata)
  const profile = 'codex-eligibility-test'
  const env = {
    DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile),
    USERPROFILE: home, HOME: home, APPDATA: appdata, LOCALAPPDATA: localappdata,
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
  }
  const configured = spawnSync('cmd.exe', ['/d', '/c', binary, profile, '--from-default-profile', 'acp', '--dump-config'], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(configured.status, 0, 'Isolated profile initializes without credentials')
  const cases: { name: string; fields: Partial<SessionHeader>; listed: boolean; resumable: boolean; reason: RegExp }[] = [
    { name: 'subagent', fields: { origin: 'subagent' }, listed: false, resumable: false, reason: /subagent/ },
    { name: 'fork', fields: { parentSession: 'synthetic-parent' }, listed: false, resumable: false, reason: /parentSession/ },
    { name: 'relative cwd', fields: { cwd: 'relative-project' }, listed: false, resumable: false, reason: /source cwd/ },
    { name: 'missing cwd', fields: { cwd: undefined }, listed: false, resumable: false, reason: /source cwd/ },
    { name: 'relative alias', fields: { cwd: '.' }, listed: false, resumable: false, reason: /source cwd/ },
  ]
  const controls = cases.map(scenario => {
    const source = dshLog(root, 'none')
    const id = randomUUID()
    const artifact = writeArtifact(join(home, 'sessions'), { ...source.header, id, ...scenario.fields }, source.events)
    const before = readFileSync(artifact.path)
    const targetHome = join(root, `rejected-${id}`)
    const args = ['migrate', '--from', 'dsh', '--input', artifact.path, '--cwd', root, '--target-home', targetHome,
      '--id', randomUUID(), '--cli-version', '0.159.2', '--model-provider', 'test-provider']
    assert.throws(() => execute(args), scenario.reason)
    assert.throws(() => execute([...args, '--dry-run']), scenario.reason)
    assert.ok(!existsSync(targetHome))
    assert.deepEqual(readFileSync(artifact.path), before)
    return { ...scenario, id, path: artifact.path, before }
  })
  const source = join(root, 'top-level-rollout.jsonl')
  writeFileSync(source, codexRecords(root).map(record => JSON.stringify(record)).join('\n') + '\n')
  const targetId = randomUUID()
  const report = execute(['migrate', '--from', 'codex', '--input', source, '--cwd', root, '--target-home', home, '--id', targetId])
  assert.equal(report.toolsExecuted, 0)
  assert.equal(report.modelRequests, 0)
  assert.equal(report.nativeValidation, 'not-run')
  const target = report.output as { path: string }
  const parsed = parseSessionLog(readFrames(readFileSync(target.path)).text, 4)
  assert.ok(isAbsolute(parsed.header.cwd!))
  assert.equal(parsed.header.origin, undefined)
  assert.equal(parsed.header.parentSession, undefined)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withRpcServer('cmd.exe', ['/d', '/c', binary, profile], env, root, async (call, notifications) => {
      const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent_continue_eligibility_test', version: '0.0.1' } })
      assert.equal(initialized.error, undefined)
      context.diagnostic(`Native DSH agent: ${JSON.stringify(initialized.result?.agentInfo ?? null)}`)
      for (const params of [{}, { cwd: root }]) {
        const listed = await call('session/list', params)
        assert.equal(listed.error, undefined)
        const ids = (listed.result?.sessions as { sessionId: string }[]).map(session => session.sessionId)
        assert.ok(ids.includes(targetId))
        for (const control of controls) assert.equal(ids.includes(control.id), control.listed, control.name)
      }
      for (const control of controls) {
        const resumed = await call('session/resume', { cwd: root, sessionId: control.id })
        assert.equal(resumed.error === undefined, control.resumable, `${control.name}: ${JSON.stringify(resumed.error)}`)
        if (!control.resumable) {
          assert.match(String((resumed.error as { message: string }).message), /not resumable|cwd does not match/)
          assert.deepEqual(readFileSync(control.path), control.before, 'Refused native sources are not modified')
        }
        context.diagnostic(`D16 control ${control.name}: listed=${control.listed}, resumed=${resumed.error === undefined}, migration=refused`)
      }
      const resumed = await call('session/resume', { cwd: root, sessionId: targetId })
      assert.equal(resumed.error, undefined)
      assert.ok(resumed.result?.configOptions !== undefined)
      assert.ok(!notifications.some(notification => notification.id !== undefined), 'No historical tools or approval requests are issued')
    })
    const after = parseSessionLog(readFrames(readFileSync(target.path)).text, 4)
    assert.ok(JSON.stringify(after.events).includes('SYNTHETIC PRIVATE QUESTION'))
    assert.ok(JSON.stringify(after.events).includes('SYNTHETIC PRIVATE ANSWER'))
  }
})
