import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseRollout } from '../../codex-adapter/src/rollout.ts'
import { parseSessionLog } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { convertCodexToDsh } from '../../contract/src/codex-to-dsh.ts'
import { activeEvents } from '../../contract/tests/compaction-fixture.ts'
import { LONG_CONTEXT_MEMO } from './long-context.ts'

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const hashFile = (path: string) => sha256(readFileSync(path))
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
const contains = (directory: string, path: string) => {
  const location = relative(directory, path)
  return location !== '' && !location.startsWith('..') && !isAbsolute(location)
}

export async function auditCombinedHandoff(repository: string, runRoot: string) {
  repository = realpathSync(repository)
  const runtime = join(repository, '.agent-continue')
  const requested = resolve(runRoot)
  assert.ok(contains(runtime, requested) && /^live-handoff-[^\\/]+$/.test(relative(runtime, requested)), 'Audit requires a fresh live-handoff directory under repository runtime')
  const root = realpathSync(requested)
  assert.ok(contains(realpathSync(runtime), root), 'Audit must not follow a runtime link outside isolation')
  const evidence = JSON.parse(readFileSync(join(root, 'evidence.json'), 'utf8'))
  assert.equal(evidence.status, 'passed', 'Incomplete or failed runs cannot satisfy the goal audit')
  assert.ok(evidence.longContext && evidence.quotaRefusal, 'Audit requires compaction and refusal in the same source execution')
  assert.equal(resolve(evidence.root), root)
  assert.equal(evidence.expectedMemo, LONG_CONTEXT_MEMO)
  assert.equal(evidence.longContext.manualCompactionRequests, 0)
  assert.equal(evidence.longContext.turns.length, 7)
  assert.ok(evidence.longContext.turns.every((turn: any) => turn.status === 'completed'))
  assert.equal(evidence.quotaRefusal.interruptRequests, 0)
  assert.equal(evidence.quotaRefusal.nativeTurnStatus, 'failed')
  assert.equal(evidence.quotaRefusal.nativeError.codexErrorInfo, 'usageLimitExceeded')
  assert.equal(evidence.realQuotaExhaustion, false)
  const observations = evidence.quotaRefusal.observations as { phase: string; statusCode: number }[]
  const firstRefused = observations.findIndex(item => item.phase === 'quota-refused')
  assert.ok(firstRefused > 0 && observations.slice(0, firstRefused).some(item => item.statusCode === 200))
  assert.ok(observations.slice(firstRefused).every(item => item.phase === 'quota-refused' && item.statusCode === 429))
  const scoped = (path: string) => {
    assert.ok(contains(root, resolve(path)), 'Receipt must not reference another conversation or workspace')
    const actual = realpathSync(path)
    assert.ok(contains(root, actual), 'Receipt must not follow links outside isolation')
    return actual
  }
  const original = scoped(evidence.sourcePath)
  assert.ok(contains(join(root, 'codex-home', 'sessions'), original))
  assert.equal(hashFile(original), evidence.sourceHash)
  const source = parseRollout(readFileSync(original, 'utf8'))
  assert.equal(source.failures.length, 0)
  assert.equal(source.records[0]!.payload.id, evidence.sourceThread)
  assert.equal(realpathSync(evidence['same-workspace'].cwd), realpathSync(String(source.records[0]!.payload.cwd)), 'Same-workspace proof must use the actual source cwd, not a relocated retry')
  const compactions = source.records.filter(record => record.type === 'compacted')
  assert.ok(compactions.length >= 2)
  assert.equal(compactions.length, evidence.longContext.automaticCompactions)
  assert.ok(JSON.stringify(compactions.at(-1)!.payload.replacement_history).includes(LONG_CONTEXT_MEMO))
  const codeAtCommit = (path: string) => execFileSync('git', ['show', `${evidence.commit}:${path}`], { cwd: repository })
  assert.equal(sha256(codeAtCommit('packages/cli/tests/live-handoff.ts')), evidence.sourceBuild.runnerHash)
  assert.equal(sha256(codeAtCommit('packages/cli/tests/quota-proxy.ts')), evidence.sourceBuild.quotaProxyFixtureHash)
  assert.equal(sha256(codeAtCommit('packages/cli/tests/long-context.ts')), evidence.sourceBuild.longContextFixtureHash)
  for (const [path, expected] of Object.entries(evidence.sourceBuild.implementationHashes)) assert.equal(sha256(codeAtCommit(path)), expected, path)
  const sourceLog = readFileSync(join(root, 'codex.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const failed = sourceLog.filter(message => message.method === 'turn/completed' && message.params?.turn?.id === evidence.quotaRefusal.rejectedTurnId)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].params.turn.status, 'failed')
  assert.equal(failed[0].params.turn.error.codexErrorInfo, 'usageLimitExceeded')
  assert.equal(sourceLog.some(message => message.method === 'item/started' && message.params?.turnId === evidence.quotaRefusal.rejectedTurnId &&
    ['commandExecution', 'fileChange'].includes(message.params?.item?.type)), false)
  assert.ok(sourceLog.some(message => message.method === 'item/started' && message.params?.item?.type === 'fileChange'))
  const checkpoint = scoped(join(root, 'checkpoint'))
  assert.equal(hashFile(join(checkpoint, 'src/ledger.mjs')), evidence.checkpointHash)
  assert.ok(evidence.checkpointGitStatus.includes('src/ledger.mjs'))
  for (const path of files(checkpoint).filter(path => !relative(checkpoint, path).startsWith('.git'))) {
    assert.ok(!readFileSync(path, 'utf8').includes(LONG_CONTEXT_MEMO), 'Final requirement must not be available in checkpoint files')
  }
  const initial = (await import(`${pathToFileURL(join(checkpoint, 'src/ledger.mjs')).href}?audit=initial`)).createLedger()
  assert.equal(initial.openAccount('alpha', 900), 900)
  for (const [method, args] of [['balance', ['alpha']], ['transfer', ['t1', 'alpha', 'beta', 1]], ['history', []]] as const) {
    assert.throws(() => initial[method](...args), { message: 'NOT_IMPLEMENTED' })
  }
  assert.equal(existsSync(join(root, 'codex-home/auth.json')), false)
  const scenarios = []
  for (const name of ['same-workspace', 'relocated-workspace']) {
    const result = evidence[name]
    for (const key of ['accepted', 'restartedSuccessfully', 'explicitToolPathsStayedInWorkspace', 'onlyImplementationChanged', 'promptFinishedNormally', 'compactionPreserved', 'inheritedExpectedMemo']) assert.equal(result[key], true, `${name}: ${key}`)
    assert.equal(result.followup, '\u7ee7\u7eed')
    assert.equal(result.prompt.stopReason, 'end_turn')
    assert.equal(result.handoffDocumentCreated, false)
    assert.deepEqual(result.implementationHashes, evidence.sourceBuild.implementationHashes)
    assert.equal(result.runnerHash, evidence.sourceBuild.runnerHash)
    const cwd = scoped(result.cwd)
    assert.equal(result.startingCodeHash, evidence.checkpointHash)
    const targetHome = scoped(result.migration.target.home)
    const artifact = scoped(result.migration.output.path)
    assert.ok(contains(join(targetHome, 'sessions'), artifact))
    const imported = parseSessionLog(readFrames(readFileSync(artifact)).text, 4)
    assert.equal(imported.header.id, result.sessionId)
    assert.equal(realpathSync(imported.header.cwd), cwd)
    const converted = convertCodexToDsh(source.records, { sessionId: result.sessionId, cwd })
    assert.deepEqual(imported.events.slice(0, converted.events.length), converted.events, 'Migrated source prefix remains unmodified by continuation')
    const current = activeEvents(converted.events)
    const latest = compactions.at(-1)!
    const retained = current.filter(event => (event.data as any).source?.sourceOrdinal === latest.ordinal)
    const snapshot = latest.payload.replacement_history as any[]
    assert.deepEqual(retained.map(event => ({ role: (event.data as any).role, text: (event.data as any).content.map((part: any) => part.text).join('') })),
      snapshot.map(item => ({ role: item.role, text: item.content.map((part: any) => part.text).join('') })))
    assert.ok(retained[0]!.surfaceOp !== 'append')
    const delivered = imported.events.filter(event => event.type === 'session-log-deepseek/delivery-accepted').length
    assert.ok(delivered > 0)
    assert.equal(delivered, result.acceptedModelResponses)
    const transcript = readFileSync(join(root, `${name}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(transcript.filter(message => message.id === 3 && message.result?.stopReason).at(-1)!.result.stopReason, 'end_turn')
    const restart = readFileSync(join(root, `${name}-restart.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(restart.some(message => message.id === 2 && message.result !== undefined && !message.error))
    assert.equal(restart.some(message => message.params?.update?.sessionUpdate === 'tool_call'), false)
    assert.equal(hashFile(join(cwd, 'src/ledger.mjs')), result.finalCodeHash)
    assert.notEqual(result.finalCodeHash, evidence.checkpointHash)
    const ledger = (await import(`${pathToFileURL(join(cwd, 'src/ledger.mjs')).href}?audit=final`)).createLedger()
    ledger.openAccount('sender', 500)
    ledger.openAccount('receiver', 0)
    assert.deepEqual(ledger.transfer('audit', 'sender', 'receiver', 100), { id: 'audit', applied: true, memo: LONG_CONTEXT_MEMO })
    assert.equal(ledger.balance('sender'), 400)
    assert.equal(ledger.history()[0].memo, LONG_CONTEXT_MEMO)
    const smoke = spawnSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true })
    assert.equal(smoke.status, 0)
    assert.deepEqual(files(cwd).map(path => relative(cwd, path).replaceAll('\\', '/')).filter(path => !path.startsWith('.git/')).sort(),
      ['AGENTS.md', 'src/ledger.mjs', 'tests/smoke.test.mjs'])
    for (const path of ['AGENTS.md', 'tests/smoke.test.mjs']) assert.equal(hashFile(join(cwd, path)), hashFile(join(checkpoint, path)))
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkpoint, encoding: 'utf8' }).trim()
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), sourceHead)
    scenarios.push({ scenario: name, accepted: true, deliveries: delivered, stopReason: 'end_turn',
      originalPrefixUnmodified: true, canonicalSnapshotExact: true, firstStagePreserved: true,
      finalDialogueRequirementFollowed: true, restartedWithoutToolReplay: true, finalCodeHash: result.finalCodeHash })
  }
  assert.notEqual(evidence['same-workspace'].cwd, evidence['relocated-workspace'].cwd)
  assert.notEqual(evidence['same-workspace'].migration.target.home, evidence['relocated-workspace'].migration.target.home)
  return { sourceCommit: evidence.commit, sourceHash: evidence.sourceHash, checkpointHash: evidence.checkpointHash,
    auditRunnerHash: hashFile(import.meta.filename),
    runnerHash: evidence.sourceBuild.runnerHash, binaryHashes: evidence.binaryHashes, codexVersion: evidence.codexVersion,
    codexModel: evidence.codexModel, codexAuthMode: evidence.codexAuthMode, sourceBuild: evidence.sourceBuild,
    automaticCompactions: compactions.map(record => ({ ordinal: record.ordinal, finalDecisionPresent: JSON.stringify(record.payload.replacement_history).includes(LONG_CONTEXT_MEMO) })),
    pressureTurns: evidence.longContext.turns, autoCompactLimit: evidence.longContext.autoCompactLimit,
    quota: { injectedLocally: true, nativeTurnStatus: 'failed', nativeErrorInfo: 'usageLimitExceeded',
      forwardedRequests: firstRefused, refusedRequests: observations.length - firstRefused, interruptRequests: 0 },
    scenarios, auditStatus: 'passed', auditModelRequests: 0, credentialsRead: false,
    actualSubscriptionExhaustion: false, defaultFullWindowSaturation: false, checkedAt: new Date().toISOString() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: node packages/cli/tests/live-handoff-audit.ts ISOLATED_RUN_ROOT')
  const repository = resolve(import.meta.dirname, '../../..')
  const report = await auditCombinedHandoff(repository, process.argv[2]!)
  writeFileSync(join(resolve(process.argv[2]!), 'completion-audit.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
