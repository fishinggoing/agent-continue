import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { parseRollout, sessionMeta, type JsonObject, type RolloutRecord } from '../../codex-adapter/src/rollout.ts'
import { rolloutPath, STATE_STORE_FILENAME } from '../../codex-adapter/src/paths.ts'
import { registerThread, writeRollout } from '../../codex-adapter/src/write.ts'
import { parseSessionLog, type SessionEvent, type SessionHeader } from '../../dsh-adapter/src/format.ts'
import { readFrames } from '../../dsh-adapter/src/zstd.ts'
import { artifactPath } from '../../dsh-adapter/src/paths.ts'
import { writeArtifact } from '../../dsh-adapter/src/write.ts'
import { convertCodexToDsh } from '../../contract/src/codex-to-dsh.ts'
import { convertDshToCodex } from '../../contract/src/dsh-to-codex.ts'

type Harness = 'codex' | 'dsh'
type Source = { kind: 'codex'; records: RolloutRecord[] } | { kind: 'dsh'; header: SessionHeader; events: SessionEvent[] }

export interface PendingOperation {
  callId: string
  name: string
  state: 'unknown'
}

export type CommandReport = Record<string, unknown>

export const USAGE = [
  'agent-continue inspect --from codex|dsh --input FILE',
  'agent-continue migrate --from codex|dsh --input FILE --cwd ABSOLUTE_DIR --target-home ABSOLUTE_DIR [--dry-run] [--id UUID]',
  'DSH -> Codex additionally requires --cli-version VERSION --model-provider PROVIDER.',
  'Optional Codex registration fields: --model MODEL --title TITLE.',
  'No model requests, tool execution, implicit user home, or overwrite are performed.',
].join('\n')

const INSPECT_FLAGS = new Set(['from', 'input'])
const MIGRATE_FLAGS = new Set(['from', 'input', 'cwd', 'target-home', 'dry-run', 'id', 'cli-version', 'model-provider', 'model', 'title'])
const REGISTRY_COLUMNS = [
  'id', 'rollout_path', 'created_at', 'updated_at', 'source', 'model_provider', 'cwd', 'title',
  'sandbox_policy', 'approval_mode', 'tokens_used', 'has_user_event', 'archived', 'cli_version',
  'first_user_message', 'memory_mode', 'model', 'reasoning_effort', 'created_at_ms', 'updated_at_ms',
  'thread_source', 'preview', 'recency_at', 'recency_at_ms', 'history_mode', 'is_pinned', 'originator',
]

function parseArguments(args: readonly string[]): { command: string; flags: Map<string, string> } {
  const command = args[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') return { command: 'help', flags: new Map() }
  if (command !== 'inspect' && command !== 'migrate') throw new Error(`Unknown command: ${command}`)
  const allowed = command === 'inspect' ? INSPECT_FLAGS : MIGRATE_FLAGS
  const flags = new Map<string, string>()
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!
    if (!token.startsWith('--')) throw new Error(`Expected a named option, got ${token}`)
    const name = token.slice(2)
    if (!allowed.has(name)) throw new Error(`Unknown option --${name}`)
    if (flags.has(name)) throw new Error(`Duplicate option --${name}`)
    if (name === 'dry-run') { flags.set(name, 'true'); continue }
    const value = args[++index]
    if (value === undefined || value.startsWith('--') || value.length === 0) throw new Error(`Missing value for --${name}`)
    flags.set(name, value)
  }
  return { command, flags }
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name)
  if (value === undefined) throw new Error(`Required option --${name} is missing`)
  return value
}

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}

function readSource(kind: Harness, input: string): Source {
  if (!statSync(input).isFile()) throw new Error('Input must be a file')
  if (statSync(input).size > 128 * 1024 * 1024) throw new Error('Input exceeds the 128 MiB source limit')
  const bytes = readFileSync(input)
  if (kind === 'codex') {
    const parsed = parseRollout(bytes.toString('utf8'))
    if (parsed.failures.length > 0) {
      const first = parsed.failures[0]!
      throw new Error(`Damaged Codex source at line ${first.line + 1}; refusing partial migration`)
    }
    if (parsed.records[0]?.type !== 'session_meta' || sessionMeta(parsed.records) === undefined) {
      throw new Error('Codex source must begin with session_meta')
    }
    return { kind, records: parsed.records }
  }
  let text = bytes.toString('utf8')
  if (input.endsWith('.zstd')) {
    const decoded = readFrames(bytes)
    if (decoded.scan.tornStart !== undefined) throw new Error('DSH source has an incomplete trailing frame; refusing partial migration')
    text = decoded.text
  }
  const version = /session\.v(\d+)\.jsonl(?:\.zstd)?$/.exec(input)?.[1]
  let parsed: ReturnType<typeof parseSessionLog>
  try {
    parsed = parseSessionLog(text, version === undefined ? undefined : Number(version))
  } catch {
    throw new Error('Invalid DSH source header, JSON or event envelope; refusing partial migration')
  }
  if (parsed.header.version !== 3 && parsed.header.version !== 4) throw new Error(`Unsupported DSH format version ${parsed.header.version}`)
  return { kind, ...parsed }
}

function pendingOperations(source: Source): PendingOperation[] {
  const pending = new Map<string, PendingOperation>()
  if (source.kind === 'codex') {
    for (const record of source.records) {
      if (record.type !== 'response_item') continue
      const payload = record.payload
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
      if (callId === undefined) continue
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        pending.set(callId, { callId, name: String(payload.name ?? 'unknown'), state: 'unknown' })
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        pending.delete(callId)
      }
    }
  } else {
    for (const event of source.events) {
      const data = object(event.data)
      if (event.type === 'tool/call' && typeof data.callId === 'string') {
        pending.set(data.callId, { callId: data.callId, name: String(data.name ?? 'unknown'), state: 'unknown' })
      } else if (event.type === 'tool/result') {
        const message = object(data.message)
        const messageSource = object(message.source)
        const callId = messageSource.callId ?? data.toolCallId ?? message.toolCallId
        if (typeof callId === 'string') {
          if (object(data.error).code === 'TOOL_OUTCOME_UNKNOWN') {
            pending.set(callId, pending.get(callId) ?? { callId, name: 'unknown', state: 'unknown' })
          } else pending.delete(callId)
        }
      }
    }
  }
  return [...pending.values()]
}

function absoluteDirectory(value: string, mustExist: boolean): string {
  if (!isAbsolute(value)) throw new Error('Working directory and target home must be absolute paths')
  const path = resolve(value)
  if (mustExist && !statSync(path).isDirectory()) throw new Error('Working directory must be an existing directory')
  if (existsSync(path) && !statSync(path).isDirectory()) throw new Error('Target home must be a directory')
  return path
}

function preflightRegistry(path: string, id: string): void {
  if (!existsSync(path)) throw new Error('Target Codex home must already contain an initialized state_5.sqlite; no registry is guessed or copied')
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map((column) => String(column.name)))
    if (REGISTRY_COLUMNS.some((column) => !columns.has(column))) throw new Error('Target Codex threads schema is incompatible with this adapter')
    if (database.prepare('SELECT id FROM threads WHERE id = ?').get(id) !== undefined) throw new Error('Refusing to overwrite an existing registered thread')
  } finally {
    database.close()
  }
}

export function execute(args: readonly string[]): CommandReport {
  const { command, flags } = parseArguments(args)
  if (command === 'help') return { command, usage: USAGE }
  const from = required(flags, 'from')
  if (from !== 'codex' && from !== 'dsh') throw new Error('--from must be codex or dsh')
  const input = resolve(required(flags, 'input'))
  const source = readSource(from, input)
  const pending = pendingOperations(source)
  const count = source.kind === 'codex' ? source.records.length : source.events.length
  const sourceCwd = source.kind === 'codex' ? sessionMeta(source.records)?.cwd : source.header.cwd
  if (command === 'inspect') {
    return { command, source: { harness: from, path: input, records: count, cwd: sourceCwd }, pendingOperations: pending, toolsExecuted: 0 }
  }
  const cwd = absoluteDirectory(required(flags, 'cwd'), true)
  const home = absoluteDirectory(required(flags, 'target-home'), false)
  const sessionId = flags.get('id') ?? randomUUID()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('--id must be a UUID; a fresh UUID is generated when omitted')
  const dryRun = flags.has('dry-run')
  const target = from === 'codex' ? 'dsh' : 'codex'
  const base = {
    command, status: dryRun ? 'planned' : 'written',
    source: { harness: from, path: input, records: count, cwd: sourceCwd },
    target: { harness: target, home, cwd, sessionId },
    pendingOperations: pending, toolsExecuted: 0, modelRequests: 0,
    nativeValidation: 'not-run',
    cwdRemapped: sourceCwd !== undefined && sourceCwd !== cwd,
  }
  if (source.kind === 'codex') {
    for (const name of ['cli-version', 'model-provider', 'model', 'title']) {
      if (flags.has(name)) throw new Error(`--${name} is only used when the target is Codex`)
    }
    const converted = convertCodexToDsh(source.records, { sessionId, cwd })
    const outputPath = artifactPath({ root: join(home, 'sessions'), cwd, id: sessionId, version: converted.header.version })
    if (existsSync(outputPath)) throw new Error('Refusing to overwrite an existing DSH session artifact')
    const written = dryRun ? undefined : writeArtifact(join(home, 'sessions'), converted.header, converted.events)
    return { ...base, output: { path: outputPath, records: converted.events.length, bytes: written?.bytes }, tallies: converted.tallies, losses: converted.losses }
  }
  const cliVersion = required(flags, 'cli-version')
  const modelProvider = required(flags, 'model-provider')
  const converted = convertDshToCodex({ ...source.header, cwd }, source.events, { cliVersion, modelProvider, threadId: sessionId })
  const firstUser = converted.drafts.find((record) => record.type === 'response_item' && record.payload.type === 'message' && record.payload.role === 'user')
  const firstUserMessage = Array.isArray(firstUser?.payload.content)
    ? firstUser.payload.content.map((block) => object(block).text).filter((text): text is string => typeof text === 'string').join('')
    : undefined
  const when = new Date(source.header.createdAt)
  if (!Number.isFinite(when.getTime())) throw new Error('Source creation time is outside the supported date range')
  const outputPath = rolloutPath(home, when, sessionId)
  if (existsSync(outputPath)) throw new Error('Refusing to overwrite an existing Codex rollout')
  let bytes: number | undefined
  if (!dryRun) {
    const statePath = join(home, STATE_STORE_FILENAME)
    preflightRegistry(statePath, sessionId)
    const written = writeRollout(home, sessionId, when, converted.drafts)
    bytes = written.bytes
    try {
      registerThread(statePath, {
        id: sessionId, rolloutPath: written.path,
        createdAt: Math.floor(when.getTime() / 1000), updatedAt: Math.floor(when.getTime() / 1000),
        source: 'exec', modelProvider, cwd, title: flags.get('title') ?? 'Imported DSH conversation',
        cliVersion, model: flags.get('model'), originator: 'agent_continue',
        firstUserMessage, preview: firstUserMessage,
        sandboxPolicy: JSON.stringify({ type: 'read-only' }), approvalMode: 'on-request',
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Rollout was written but thread registration failed; inspect ${written.path} before retrying: ${reason}`)
    }
  }
  return { ...base, output: { path: outputPath, records: converted.drafts.length, bytes }, tallies: converted.tallies, losses: converted.losses }
}
