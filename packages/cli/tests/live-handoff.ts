import assert from 'node:assert/strict'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execute } from '../src/command.ts'
import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { activeEvents } from '../../contract/tests/compaction-fixture.ts'

if (process.env.AGENT_CONTINUE_LIVE !== '1') throw new Error('Real model calls require AGENT_CONTINUE_LIVE=1')
const repository = resolve(import.meta.dirname, '../../..')
const binary = process.env.AGENT_CONTINUE_CODEX_CLI!
const dshBinary = process.env.AGENT_CONTINUE_DSH_CLI!
const python = process.env.AGENT_CONTINUE_PYTHON!
for (const path of [binary, dshBinary, python]) assert.ok(path && isAbsolute(path) && existsSync(path))
const runtime = join(repository, '.agent-continue')
mkdirSync(runtime, { recursive: true })
const resumeRoot = process.env.AGENT_CONTINUE_LIVE_RESUME
const verifyOnly = process.env.AGENT_CONTINUE_LIVE_VERIFY_ONLY === '1'
assert.ok(!verifyOnly || resumeRoot, 'Verification-only mode requires an existing isolated run')
const compactBeforeInterruption = process.env.AGENT_CONTINUE_LIVE_COMPACT === '1'
const root = resumeRoot ? resolve(resumeRoot) : mkdtempSync(join(runtime, 'live-handoff-'))
assert.ok(relative(runtime, root) && !relative(runtime, root).startsWith('..') && !isAbsolute(relative(runtime, root)))
const evidence: Record<string, any> = resumeRoot ? JSON.parse(readFileSync(join(root, 'evidence.json'), 'utf8')) : {
  startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  simulatedInterruption: true, realQuotaExhaustion: false, root,
}
const persist = () => writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
const auth = verifyOnly ? { model: evidence.codexModel, provider: '', route: {}, auth: {}, dshKey: undefined } : JSON.parse(execFileSync(python, ['-c', [
  'import json,tomllib,yaml,pathlib',
  "home=pathlib.Path.home(); config=tomllib.loads((home/'.codex/config.toml').read_text(encoding='utf-8'))",
  "codex_auth=json.loads((home/'.codex/auth.json').read_text()); dsh_credentials=yaml.safe_load((home/'.dsh/.credentials.yaml').read_text(encoding='utf-8'))",
  "provider=config['model_provider']; route=config['model_providers'][provider]",
  "print(json.dumps({'model':config['model'],'provider':provider,'route':{key:route[key] for key in ['name','base_url','wire_api','requires_openai_auth','env_key','env_key_instructions'] if key in route},'auth':codex_auth,'dshKey':dsh_credentials['refs']['DEEPSEEK_API_KEY']}))",
].join(';')], { encoding: 'utf8', windowsHide: true }))
const secrets = [auth.dshKey, auth.auth.OPENAI_API_KEY].filter((value) => typeof value === 'string' && value.length > 0)
if (!verifyOnly) evidence.configuredCodexModel = auth.model
auth.model = process.env.AGENT_CONTINUE_LIVE_MODEL ?? auth.model
const redact = (text: string) => secrets.reduce((current, secret) => current.replaceAll(secret, '[REDACTED]'), text)
const environment = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC,
  USERPROFILE: home, HOME: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
  TEMP: join(home, 'temp'), TMP: join(home, 'temp'),
  DSH_HOME: home, CODEX_HOME: home, DSH_TELEMETRY_DISABLED: '1',
})
const prepareHome = (home: string) => {
  for (const child of ['appdata', 'localappdata', 'temp']) mkdirSync(join(home, child), { recursive: true })
}

class RpcClient {
  process: ReturnType<typeof spawn>
  notifications: any[] = []
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  nextId = 0
  buffer = ''
  log: string
  toolCalls = new Map<string, any>()
  constructor(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, name: string) {
    this.log = join(root, `${name}.jsonl`)
    this.process = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.process.stderr!.on('data', (chunk) => {
      writeFileSync(join(root, `${name}.stderr`), redact(chunk.toString()), { flag: 'a' })
    })
    this.process.stdout!.setEncoding('utf8')
    this.process.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      let boundary: number
      while ((boundary = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, boundary).trim()
        this.buffer = this.buffer.slice(boundary + 1)
        let message: any
        try { message = JSON.parse(line) } catch { continue }
        writeFileSync(this.log, `${redact(JSON.stringify(message))}\n`, { flag: 'a' })
        if (message.method) {
          this.notifications.push(message)
          const update = message.params?.update
          if (update?.sessionUpdate === 'tool_call') {
            this.toolCalls.set(update.toolCallId, update)
            console.log(`${name}: tool ${update.title}`)
          }
          if (message.method === 'item/started') console.log(`${name}: item ${message.params?.item?.type}`)
          if (message.id !== undefined) this.answer(message, cwd)
        } else {
          const entry = this.pending.get(message.id)
          if (entry) {
            clearTimeout(entry.timer)
            this.pending.delete(message.id)
            if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
            else entry.resolve(message.result)
          }
        }
      }
    })
    const fail = (error: Error) => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
      this.pending.clear()
    }
    this.process.on('error', fail)
    this.process.on('exit', () => fail(new Error(`${name} exited`)))
    this.process.stdin!.on('error', fail)
  }
  send(value: unknown) { this.process.stdin!.write(`${JSON.stringify(value)}\n`) }
  call(method: string, params: unknown, timeout = 480_000): Promise<any> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }
  answer(message: any, cwd: string) {
    if (message.method === 'session/request_permission') {
      const tool = this.toolCalls.get(message.params.toolCall.toolCallId)
      const raw = JSON.stringify(tool?.rawInput ?? {})
      const allowed = tool !== undefined && !/https?:|credentials|auth\.json|\.codex|\.dsh|\.\.\\|\.\.\/|subagent|spawn_agent/i.test(raw)
      this.send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: allowed ? 'allow-once' : 'reject-once' } } })
    } else {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Acceptance client rejects unsupported request in ${cwd}` } })
    }
  }
  async wait(predicate: (message: any) => boolean, timeout = 480_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const found = this.notifications.find(predicate)
      if (found) return found
      if (this.process.exitCode !== null) throw new Error('Native process exited before expected event')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Native event timeout')
  }
  async close() {
    this.process.stdin!.end()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (this.process.exitCode === null && this.process.pid) {
      spawnSync('taskkill.exe', ['/PID', String(this.process.pid), '/T', '/F'], { windowsHide: true })
    }
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }
}

const work = join(root, 'work')
if (!resumeRoot) {
mkdirSync(join(work, 'src'), { recursive: true })
mkdirSync(join(work, 'tests'))
writeFileSync(join(work, 'AGENTS.md'), [
  '# Isolated acceptance workspace',
  'Only read and write this workspace. Do not read parent directories, session files, authentication or home configuration.',
  'Do not use subagents, network, MCP, skills, or orchestration. Do not commit.',
  'Only edit src/ledger.mjs. Preserve tests. Do not create handoff documentation.',
].join('\n'))
writeFileSync(join(work, 'src/ledger.mjs'), `export function createLedger() {\n  throw new Error('NOT_IMPLEMENTED')\n}\n`)
writeFileSync(join(work, 'tests/smoke.test.mjs'), `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLedger } from '../src/ledger.mjs'
test('openAccount accepts safe cents', () => {
  const ledger = createLedger()
  assert.equal(ledger.openAccount('alpha', 900), 900)
  assert.throws(() => ledger.openAccount('alpha', 1), { message: 'ACCOUNT_EXISTS' })
})
test('openAccount rejects invalid values', () => {
  const ledger = createLedger()
  assert.throws(() => ledger.openAccount('', 2), { message: 'INVALID_ACCOUNT' })
  assert.throws(() => ledger.openAccount('bad', -1), { message: 'INVALID_AMOUNT' })
})
`)
execFileSync('git', ['init', '--quiet', work])
execFileSync('git', ['add', 'AGENTS.md', 'src/ledger.mjs', 'tests/smoke.test.mjs'], { cwd: work })
execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost', 'commit', '--quiet', '-m', 'Synthetic empty fixture'], { cwd: work })
}
const task = [
  'Implement createLedger() in src/ledger.mjs: an in-memory cents ledger, no dependencies.',
  'API: openAccount(name,cents) returns cents; balance(name) returns current cents; transfer(id,from,to,cents) returns {id,applied,memo}; history() returns successful transfers in order.',
  'Accounts are nonempty strings; __proto__ is an ordinary valid name. Initial cents are nonnegative safe integers; transfer cents are positive safe integers.',
  'Errors must have exact messages INVALID_ACCOUNT, INVALID_AMOUNT, ACCOUNT_EXISTS, UNKNOWN_ACCOUNT, SAME_ACCOUNT, INSUFFICIENT_FUNDS, BALANCE_OVERFLOW as appropriate.',
  'Transfer IDs are nonempty strings (otherwise INVALID_TRANSFER_ID). Duplicate ID with identical arguments returns applied:false without moving money or adding history. Reusing ID with different arguments throws TRANSFER_CONFLICT.',
  'Successful new transfer returns applied:true and memo="context-only-731". That exact memo must also appear on each history entry {id,from,to,cents,memo}.',
  'A failed transfer must not change either balance, history, or consume its ID: the same ID can succeed after its cause is fixed. Returned history must be detached so caller mutation cannot change stored history.',
  'Work in stages. In THIS turn only implement createLedger and openAccount and pass the existing smoke tests. Leave balance, transfer, history as NOT_IMPLEMENTED stubs. Do not implement the remaining functions yet; they are the next stage of this same task.',
  'After that checkpoint stop without a handoff file. Do not commit; only edit src/ledger.mjs. No subagents or network. The complete requirements above remain binding in the next stage.',
].join('\n')
const sourceHome = join(root, 'codex-home')
prepareHome(sourceHome)
if (!resumeRoot) {
writeFileSync(join(sourceHome, 'auth.json'), JSON.stringify(auth.auth), { mode: 0o600 })
writeFileSync(join(sourceHome, 'config.toml'), [
  `model = ${JSON.stringify(auth.model)}`, `model_provider = ${JSON.stringify(auth.provider)}`,
  'model_reasoning_effort = "low"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
  `[model_providers.${auth.provider}]`,
  ...Object.entries(auth.route).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), '',
].join('\n'))
}
evidence.codexVersion = execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
if (!verifyOnly) evidence.codexAuthMode = auth.auth.auth_mode
evidence.codexModel = auth.model
evidence.runnerHash = hash(import.meta.filename)
evidence.implementationHashes = Object.fromEntries(['cli', 'contract', 'codex-adapter', 'dsh-adapter'].flatMap((name) =>
  files(join(repository, 'packages', name, 'src')).map((path) => [relative(repository, path).replaceAll('\\', '/'), hash(path)])))
evidence.binaryHashes = { codex: hash(binary), dshLauncher: hash(dshBinary) }
persist()
console.log(`Isolated evidence: ${root}`)
let codex: RpcClient | undefined
let dsh: RpcClient | undefined
try {
  if (!resumeRoot) {
  codex = new RpcClient(binary, ['app-server', '--listen', 'stdio://'], environment(sourceHome), work, 'codex')
  await codex.call('initialize', { clientInfo: { name: 'agent_continue_live_acceptance', version: '0.0.1' }, capabilities: { experimentalApi: true } })
  codex.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const started = await codex.call('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access' })
  const threadId = started.thread.id
  evidence.sourceThread = threadId
  const stage = await codex.call('turn/start', { threadId, input: [{ type: 'text', text: task }] })
  const ended = await codex.wait((message) => message.method === 'turn/completed' && message.params?.turn?.id === stage.turn.id)
  assert.equal(ended.params.turn.status, 'completed', redact(JSON.stringify(ended.params.turn.error)))
  const smoke = spawnSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], { cwd: work, encoding: 'utf8', timeout: 10_000 })
  writeFileSync(join(root, 'checkpoint-tests.tap'), smoke.stdout + smoke.stderr)
  assert.equal(smoke.status, 0, 'Codex must genuinely finish the first stage')
  const checkpoint = await import(pathToFileURL(join(work, 'src/ledger.mjs')).href)
  assert.throws(() => checkpoint.createLedger().transfer('pending', 'alpha', 'beta', 1), { message: 'NOT_IMPLEMENTED' })
  evidence.checkpointHash = hash(join(work, 'src/ledger.mjs'))
  evidence.checkpointGitStatus = execFileSync('git', ['status', '--short'], { cwd: work, encoding: 'utf8' }).trim()
  assert.ok(String(evidence.checkpointGitStatus).includes('src/ledger.mjs'))
  cpSync(work, join(root, 'checkpoint'), { recursive: true })
  if (compactBeforeInterruption) {
    const sourcePath = files(join(sourceHome, 'sessions')).find((path) => path.endsWith('.jsonl') && path.includes(threadId))!
    const before = codex.notifications.length
    await codex.call('thread/compact/start', { threadId }, 30_000)
    await codex.wait((message) => codex!.notifications.indexOf(message) >= before && message.method === 'turn/completed', 180_000)
    const compacted = parseRollout(readFileSync(sourcePath, 'utf8')).records.filter((record) => record.type === 'compacted')
    evidence.compaction = {
      nativeRecords: compacted.length,
      payloadKeys: compacted.map((record) => Object.keys(record.payload)),
      historyKinds: compacted.map((record) => Array.isArray(record.payload.replacement_history) ? record.payload.replacement_history.map((item: any) => item.type) : []),
      plaintextSummaryLengths: compacted.map((record) => typeof record.payload.message === 'string' ? record.payload.message.length : 0),
    }
    persist()
    assert.ok(compacted.length > 0, 'Real native compaction must persist before testing compacted continuation')
  }
  const followup = await codex.call('turn/start', { threadId, input: [{ type: 'text', text: 'Continue with the remaining stage now. First run the existing smoke tests before editing anything.' }] })
  const boundary = await codex.wait((message) => message.method === 'item/started' && message.params?.turnId === followup.turn.id && message.params?.item?.type === 'commandExecution', 90_000)
  evidence.interruptionItem = boundary.params.item.type
  await codex.call('turn/interrupt', { threadId, turnId: followup.turn.id }, 30_000)
  const aborted = await codex.wait((message) => message.method === 'turn/completed' && message.params?.turn?.id === followup.turn.id, 30_000)
  assert.equal(aborted.params.turn.status, 'interrupted')
  await codex.close()
  codex = undefined
  evidence.unchangedAtInterruption = hash(join(work, 'src/ledger.mjs')) === evidence.checkpointHash
  assert.equal(evidence.unchangedAtInterruption, true)
  const rollout = files(join(sourceHome, 'sessions')).find((path) => path.endsWith('.jsonl') && path.includes(threadId))!
  assert.ok(rollout)
  evidence.sourcePath = rollout
  evidence.sourceHash = hash(rollout)
  const source = parseRollout(readFileSync(rollout, 'utf8'))
  assert.equal(source.failures.length, 0)
  evidence.sourceRecordKinds = source.records.reduce((counts: Record<string, number>, record) => { counts[record.type] = (counts[record.type] ?? 0) + 1; return counts }, {})
  evidence.originalRequirementInSource = readFileSync(rollout, 'utf8').includes('context-only-731')
  persist()
  }
  const rollout = evidence.sourcePath ?? files(join(sourceHome, 'sessions')).find((path) => path.endsWith('.jsonl') && path.includes(evidence.sourceThread))!
  const sourceRelative = relative(join(sourceHome, 'sessions'), rollout)
  assert.ok(sourceRelative && !sourceRelative.startsWith('..') && !isAbsolute(sourceRelative), 'Resume cannot read an unrelated source store')
  assert.equal(hash(rollout), evidence.sourceHash, 'Resume must use the unchanged original conversation')
  for (const scenario of ['same-workspace', 'relocated-workspace']) {
    const previous = evidence[scenario]
    const baseCwd = scenario === 'same-workspace' ? work : join(root, 'relocated')
    const retry = !verifyOnly && (previous !== undefined ? previous.accepted !== true : Boolean(resumeRoot && existsSync(baseCwd)))
    const cwd = retry ? mkdtempSync(join(root, `${scenario}-retry-`)) : previous?.cwd ?? baseCwd
    if (retry) {
      cpSync(join(root, 'checkpoint'), cwd, { recursive: true })
      evidence.previousAttempts ??= []
      evidence.previousAttempts.push({ scenario, ...previous, failure: evidence.failure })
      delete evidence[scenario]
    }
    if (scenario === 'relocated-workspace' && !existsSync(cwd)) cpSync(join(root, 'checkpoint'), cwd, { recursive: true })
    let result: Record<string, any> = evidence[scenario]
    if (verifyOnly) {
      assert.ok(result?.migration?.output?.path && result?.restartedSuccessfully, 'Verification-only mode cannot finish an incomplete native execution')
      assert.equal(hash(join(cwd, 'src/ledger.mjs')), result.finalCodeHash, 'Existing completed code must remain unchanged')
    }
    if (result?.accepted !== true && !verifyOnly) {
    evidence[scenario] = { cwd, status: 'preparing', runnerHash: evidence.runnerHash, implementationHashes: evidence.implementationHashes }
    persist()
    const home = mkdtempSync(join(root, `${scenario}-dsh-home-`))
    prepareHome(home)
    const profile = 'live-acceptance'
    const env = { ...environment(home), DEEPSEEK_API_KEY: auth.dshKey, DSH_PROFILE: profile, DSH_PROFILE_DIR: join(home, 'profiles', profile) }
    const configured = spawnSync('cmd.exe', ['/d', '/c', dshBinary, profile, '--from-default-profile', 'acp', '--dump-config'], { cwd, env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
    assert.equal(configured.status, 0, 'Isolated DSH profile creation')
    writeFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), [
      '- id: acp', '  config:', '    provider: deepseek-official', '    model: deepseek-flash',
      ...['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow', 'tool-plugin-manager', 'tool-web', 'tool-skill', 'session-telemetry-otel', 'llm-deepseek-account'].flatMap((id) => [`- id: ${id}`, '  disabled: true']), '',
    ].join('\n'))
    const id = randomUUID()
    const migration = execute(['migrate', '--from', 'codex', '--input', rollout, '--cwd', cwd, '--target-home', home, '--id', id])
    const output = (migration.output as { path: string }).path
    const imported = parseSessionLog(readFrames(readFileSync(output)).text, 4)
    const compactions = parseRollout(readFileSync(rollout, 'utf8')).records.filter((record) => record.type === 'compacted')
    let compactionPreserved: boolean | undefined
    if (compactions.length > 0) {
      const latest = compactions.at(-1)!
      const history = latest.payload.replacement_history as { type: string; role: string; content: { text: string }[] }[]
      const active = activeEvents(imported.events)
      const retained = active.filter((event) => (event.data as any).source?.kind === 'agent-continue-codex-compaction')
      assert.deepEqual(retained.map((event) => ({ role: (event.data as any).role, text: (event.data as any).content.map((block: any) => block.text).join('') })),
        history.map((item) => ({ role: item.role, text: item.content.map((block) => block.text).join('') })), 'Canonical native replacement context must survive exactly and in order')
      assert.equal(retained[0]!.surfaceOp === 'append', false, 'Compaction must replace old active history, not append a second copy')
      compactionPreserved = true
    }
    result = {
      cwd, sessionId: id, migration, importedHash: hash(output),
      runnerHash: evidence.runnerHash, implementationHashes: evidence.implementationHashes,
      compactionPreserved,
      inheritedRequirement: JSON.stringify(imported.events).includes('context-only-731'),
      startingCodeHash: hash(join(cwd, 'src/ledger.mjs')), followup: '\u7ee7\u7eed',
    }
    evidence[scenario] = result
    persist()
    dsh = new RpcClient('cmd.exe', ['/d', '/c', dshBinary, profile], env, cwd, scenario)
    result.initialize = await dsh.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent_continue_live_acceptance', version: '0.0.1' } }, 30_000)
    result.resume = await dsh.call('session/resume', { cwd, sessionId: id, mcpServers: [] }, 60_000)
    const prompt = dsh.call('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: '\u7ee7\u7eed' }] })
    const watchdog = setInterval(() => {
      try {
        const current = parseSessionLog(readFrames(readFileSync(output)).text, 4)
        if (current.events.filter((event) => event.type === 'session-log-deepseek/delivery-accepted').length > 14) dsh!.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: id } })
      } catch {}
    }, 1000)
    try { result.prompt = await prompt } finally { clearInterval(watchdog) }
    result.assistantText = dsh.notifications.filter((message) => message.params?.update?.sessionUpdate === 'agent_message_chunk').map((message) => message.params.update.content?.text ?? '').join('\n')
    result.toolNames = [...dsh.toolCalls.values()].map((tool) => tool.title)
    await dsh.call('session/close', { sessionId: id }, 30_000)
    await dsh.close()
    dsh = undefined
    dsh = new RpcClient('cmd.exe', ['/d', '/c', dshBinary, profile], env, cwd, `${scenario}-restart`)
    const restarted = await dsh.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent_continue_live_restart', version: '0.0.1' } }, 30_000)
    const reopened = await dsh.call('session/resume', { cwd, sessionId: id, mcpServers: [] }, 60_000)
    assert.ok(reopened)
    assert.equal(dsh.toolCalls.size, 0, 'Restart cannot replay historical tools')
    result.restartedSuccessfully = true
    result.restartAgent = restarted.agentInfo
    await dsh.call('session/close', { sessionId: id }, 30_000)
    await dsh.close()
    dsh = undefined
    }
    const native = parseSessionLog(readFrames(readFileSync(result.migration.output.path)).text, 4)
    delete result.modelRequests
    result.acceptedModelResponses = native.events.filter((event) => event.type === 'session-log-deepseek/delivery-accepted').length
    result.requestCountNote = 'request/header is routing context, not a request counter; accepted deliveries exclude unrecorded retries'
    result.finalCodeHash = hash(join(cwd, 'src/ledger.mjs'))
    const { createLedger } = await import(`${pathToFileURL(join(cwd, 'src/ledger.mjs')).href}?scenario=${scenario}`)
    const ledger = createLedger()
    assert.equal(ledger.openAccount('alpha', 900), 900)
    ledger.openAccount('beta', 100)
    assert.equal(ledger.balance('alpha'), 900)
    assert.deepEqual(ledger.transfer('t1', 'alpha', 'beta', 250), { id: 't1', applied: true, memo: 'context-only-731' })
    assert.equal(ledger.balance('alpha'), 650)
    assert.equal(ledger.balance('beta'), 350)
    assert.deepEqual(ledger.transfer('t1', 'alpha', 'beta', 250), { id: 't1', applied: false, memo: 'context-only-731' })
    assert.throws(() => ledger.transfer('t1', 'alpha', 'beta', 251), { message: 'TRANSFER_CONFLICT' })
    assert.throws(() => ledger.transfer('failed', 'alpha', 'beta', 1000), { message: 'INSUFFICIENT_FUNDS' })
    assert.equal(ledger.balance('alpha'), 650)
    assert.deepEqual(ledger.transfer('failed', 'alpha', 'beta', 50), { id: 'failed', applied: true, memo: 'context-only-731' })
    const history = ledger.history()
    assert.deepEqual(history, [
      { id: 't1', from: 'alpha', to: 'beta', cents: 250, memo: 'context-only-731' },
      { id: 'failed', from: 'alpha', to: 'beta', cents: 50, memo: 'context-only-731' },
    ])
    history[0].cents = 999
    history.pop()
    assert.equal(ledger.history()[0].cents, 250)
    assert.equal(ledger.history().length, 2)
    ledger.openAccount('__proto__', 0)
    assert.equal(ledger.balance('__proto__'), 0)
    ledger.openAccount('full', Number.MAX_SAFE_INTEGER)
    assert.throws(() => ledger.transfer('overflow', 'beta', 'full', 1), { message: 'BALANCE_OVERFLOW' })
    assert.equal(ledger.balance('beta'), 400)
    assert.equal(ledger.history().length, 2)
    assert.throws(() => ledger.transfer('', 'alpha', 'beta', 1), { message: 'INVALID_TRANSFER_ID' })
    assert.throws(() => ledger.transfer('same', 'alpha', 'alpha', 1), { message: 'SAME_ACCOUNT' })
    assert.throws(() => ledger.transfer('missing', 'alpha', 'ghost', 1), { message: 'UNKNOWN_ACCOUNT' })
    for (const amount of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => ledger.transfer('invalid', 'alpha', 'beta', amount), { message: 'INVALID_AMOUNT' })
    }
    const finalSmoke = spawnSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], { cwd, encoding: 'utf8', timeout: 10_000 })
    assert.equal(finalSmoke.status, 0, 'Completed first-stage behavior must remain correct')
    const workspaceFiles = files(cwd).map((path) => relative(cwd, path).replaceAll('\\', '/')).filter((path) => !path.startsWith('.git/')).sort()
    assert.deepEqual(workspaceFiles, ['AGENTS.md', 'src/ledger.mjs', 'tests/smoke.test.mjs'])
    for (const path of ['AGENTS.md', 'tests/smoke.test.mjs']) {
      assert.equal(hash(join(cwd, path)), hash(join(root, 'checkpoint', path)), 'Instructions and existing tests remain untouched')
    }
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(root, 'checkpoint'), encoding: 'utf8' }))
    result.onlyImplementationChanged = true
    const observedTools = readFileSync(join(root, `${scenario}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((message) => message.params?.sessionId === result.sessionId && message.params?.update?.sessionUpdate === 'tool_call').map((message) => message.params.update)
    for (const tool of observedTools) {
      for (const path of [tool.rawInput?.file_path, tool.rawInput?.workdir, tool.rawInput?.path]) {
        if (typeof path !== 'string') continue
        const target = relative(cwd, resolve(cwd, path))
        assert.ok(!target.startsWith('..') && !isAbsolute(target), 'Observed tool target must stay in the current workspace')
      }
    }
    result.explicitToolPathsStayedInWorkspace = true
    result.promptFinishedNormally = result.prompt?.stopReason === 'end_turn'
    result.handoffDocumentCreated = files(cwd).some((path) => /handoff.*\.md$/i.test(basename(path)))
    assert.equal(result.handoffDocumentCreated, false)
    result.accepted = true
    persist()
    console.log(`${scenario}: real continuation accepted`)
  }
  if (resumeRoot && evidence.failure) {
    evidence.previousRunnerFailure = evidence.failure
    delete evidence.failure
  }
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  evidence.failure = redact(String(error))
  console.error(redact(String(error)))
  process.exitCode = 1
} finally {
  if (codex) await codex.close()
  if (dsh) await dsh.close()
  rmSync(join(sourceHome, 'auth.json'), { force: true })
  evidence.finishedAt = new Date().toISOString()
  persist()
}
