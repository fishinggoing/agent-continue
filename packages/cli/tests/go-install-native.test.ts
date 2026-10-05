// Development-only native acceptance of the Go executable's download/install path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseSessionLog, serializeSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { writeCodex, writeDsh } from './fixtures.ts'
import { configureHome, nativeCliVersion, withRpcServer, withServer } from './native.ts'

function goCommand(args: string[]): Record<string, any> {
  const binary = process.env.AGENT_CONTINUE_GO_CLI!
  const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('Go install canonicalizes DSH cwd aliases and survives native list/resume', { timeout: 90_000 }, async (context) => {
  const binary = process.env.AGENT_CONTINUE_DSH_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!binary || !probeRoot || !process.env.AGENT_CONTINUE_GO_CLI || process.platform !== 'win32') {
    context.skip('Requires Go executable and Windows isolated DSH native verification configuration')
    return
  }
  assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
  const root = mkdtempSync(join(probeRoot, 'go-install-dsh-'))
  const home = join(root, 'dsh-home')
  const appdata = join(home, 'appdata')
  const localappdata = join(home, 'localappdata')
  mkdirSync(appdata, { recursive: true })
  mkdirSync(localappdata)
  const profile = 'go-install-native-test'
  const env = {
    DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile),
    USERPROFILE: home, HOME: home, APPDATA: appdata, LOCALAPPDATA: localappdata,
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH,
  }
  const configured = spawnSync('cmd.exe', ['/d', '/c', binary, profile, '--from-default-profile', 'acp', '--dump-config'], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(configured.status, 0, 'Initialize isolated ACP without user credentials')
  const converted = goCommand(['migrate', '--from', 'codex', '--input', writeCodex(root), '--cwd', root, '--target-home', join(root, 'source-home')])
  const source = parseSessionLog(readFrames(readFileSync(converted.output.path)).text, 4)
  for (const alias of [root + sep, root + sep + 'child' + sep + '..' + sep + '.' + sep]) {
    const id = randomUUID()
    const input = join(root, `download-${id}.session.v4.jsonl`)
    writeFileSync(input, serializeSessionLog({ ...source.header, id, cwd: alias }, source.events))
    const report = goCommand(['install', '--from', 'dsh', '--input', input, '--cwd', root, '--target-home', home])
    assert.equal(report.status, 'written')
    const installed = parseSessionLog(readFrames(readFileSync(report.output.path)).text, 4)
    assert.equal(installed.header.cwd, root)
    await withRpcServer('cmd.exe', ['/d', '/c', binary, profile], env, root, async (call, notifications) => {
      const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'go_install_test', version: '0.0.1' } })
      assert.equal(initialized.error, undefined)
      const listed = await call('session/list', { cwd: root })
      assert.equal(listed.error, undefined)
      assert.ok((listed.result?.sessions as { sessionId: string }[]).some(session => session.sessionId === id))
      const resumed = await call('session/resume', { cwd: root, sessionId: id })
      assert.equal(resumed.error, undefined, `Native storage identity rejected ${alias}: ${JSON.stringify(resumed.error)}`)
      assert.ok(resumed.result?.configOptions !== undefined)
      assert.ok(!notifications.some(notification => notification.id !== undefined), 'No historical tool execution or approval')
    })
  }
})

test('Go installs a Codex download with model/title and native paginated history', { timeout: 90_000 }, async (context) => {
  const binary = process.env.AGENT_CONTINUE_CODEX_CLI
  const probeRoot = process.env.AGENT_CONTINUE_NATIVE_ROOT
  if (!binary || !probeRoot || !process.env.AGENT_CONTINUE_GO_CLI) {
    context.skip('Requires Go executable and isolated Codex native verification configuration')
    return
  }
  assert.ok(isAbsolute(binary) && isAbsolute(probeRoot))
  const root = mkdtempSync(join(probeRoot, 'go-install-codex-'))
  const sourceHome = join(root, 'source-home')
  const home = join(root, 'target-home')
  for (const initializedHome of [sourceHome, home]) {
    configureHome(initializedHome)
    await withServer(binary, initializedHome, root, async call => {
      const started = await call('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' })
      assert.equal(started.error, undefined)
    })
  }
  const converted = goCommand([
    'migrate', '--from', 'dsh', '--input', writeDsh(root), '--cwd', root, '--target-home', sourceHome,
    '--cli-version', nativeCliVersion(binary), '--model-provider', 'local-probe',
  ])
  const id = converted.target.sessionId
  const report = goCommand([
    'install', '--from', 'codex', '--input', converted.output.path, '--cwd', root, '--target-home', home,
    '--model', 'offline-probe', '--title', 'Go downloaded conversation',
  ])
  assert.equal(report.status, 'written')
  assert.equal(report.nativeValidation, 'not-run')
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT model, title FROM threads WHERE id = ?').get(id)
    assert.equal(row?.model, 'offline-probe')
    assert.equal(row?.title, 'Go downloaded conversation')
  } finally { db.close() }
  await withServer(binary, home, root, async call => {
    const listed = await call('thread/list', { useStateDbOnly: true, sourceKinds: ['exec'], modelProviders: ['local-probe'], limit: 20 })
    assert.equal(listed.error, undefined)
    assert.ok((listed.result?.data as { id: string }[]).some(thread => thread.id === id))
    const resumed = await call('thread/resume', { threadId: id, cwd: root, model: 'offline-probe', modelProvider: 'local-probe', approvalPolicy: 'on-request', sandbox: 'read-only' })
    assert.equal(resumed.error, undefined)
    const history = await call('thread/items/list', { threadId: id, limit: 20 })
    assert.equal(history.error, undefined)
    const items = JSON.stringify(history.result?.data)
    assert.ok(items.includes('SYNTHETIC PRIVATE QUESTION'))
    assert.ok(items.includes('SYNTHETIC PRIVATE ANSWER'))
  })
})
