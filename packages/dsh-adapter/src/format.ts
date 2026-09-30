/**
 * Line codec and admission rules for DSH session logs.
 *
 * A log is JSONL: the first line is the session header, every later line is one
 * event envelope. The envelope is identical across format v3 and v4 (measured
 * on a real session store — see `docs/HANDOFF.md` §3.9), so only the header
 * needs version dispatch.
 *
 * The rules here mirror the ones DSH enforces when it opens a log, because a
 * foreign writer that violates them produces a session DSH refuses to load:
 * dense zero-based `seq`, a `surfaceOp` on exactly the surface event types and
 * on no others, and `ignorable: true` on any type this build does not know.
 */

/**
 * Every `SessionEventMap` member of deepseek-harness v0.2.0-rc.2, copied from
 * `packages/core/session/src/known-event-types.ts` (itself generated).
 *
 * A log containing a type outside this set is only loadable when that event
 * carries `ignorable: true`; DSH treats it as written by a newer or
 * out-of-repo build. Keep this list in sync when targeting a newer harness.
 */
export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
  'workspace/changes',
])

/** Event types that must carry a `surfaceOp` marker, and are the only ones allowed to. */
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** First line of a session log. */
export interface SessionHeader {
  type: 'session'
  /** Session format generation; also named by the artifact filename. */
  version: number
  /** Session id; also names the session directory. */
  id: string
  /** Creation time in epoch milliseconds. */
  createdAt: number
  /** Project directory; absent logs live under `_no-cwd` and are not listed. */
  cwd?: string
  /** Parent session, present only on forks and subagent sessions. */
  parentSession?: string
  /** Whether the log starts from an inherited seed rather than a fresh turn. */
  isSeeded: boolean
  /** Marker present only on subagent sessions, which DSH excludes from listing. */
  origin?: 'subagent'
  /** Delegation depth; optional in the type, but required on disk at every version. */
  delegationDepth: number
  /** Agent preset name, when the session was composed from one. */
  agentPreset?: string
}

/** How a surface event changes the reconstructed conversation. */
export type SurfaceOp = 'append' | { op: 'replace'; startSeq: number; endSeq: number }

/** One event envelope. */
export interface SessionEvent {
  type: string
  /** Zero-based position in the log; must equal the record's index. */
  seq: number
  /** Event time in epoch milliseconds. */
  time: number
  data: unknown
  /** Required on surface types, forbidden elsewhere. */
  surfaceOp?: SurfaceOp
  /** Envelope sequence numbers this event's projection derives from. */
  sourceEventSeqs?: number[]
  /** Present only when the event type is unknown to the reading build. */
  ignorable?: true
}

/** Rejection of a log that violates the format rules. */
export class SessionLogError extends Error {
  override readonly name = 'SessionLogError'
}

const HEADER_REQUIRED_KEYS = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const HEADER_OPTIONAL_KEYS = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const HEADER_KEYS = new Set<string>([...HEADER_REQUIRED_KEYS, ...HEADER_OPTIONAL_KEYS])

const EVENT_ENVELOPE_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])

/**
 * Validate a decoded header line.
 * @param value - parsed JSON of the log's first line.
 * @param expectedVersion - version named by the artifact filename, when known.
 * @returns the validated header.
 */
export function parseHeader(value: unknown, expectedVersion?: number): SessionHeader {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionLogError('session header must be a JSON object')
  }
  const record = withoutUndefined(value as Record<string, unknown>)
  for (const key of HEADER_REQUIRED_KEYS) {
    if (!(key in record)) throw new SessionLogError(`session header is missing required key "${key}"`)
  }
  for (const key of Object.keys(record)) {
    if (!HEADER_KEYS.has(key)) throw new SessionLogError(`session header has unknown key "${key}"`)
  }
  if (record.type !== 'session') throw new SessionLogError(`session header type must be "session", got ${JSON.stringify(record.type)}`)
  assertSafeInteger(record.version, 'session header version')
  assertSafeInteger(record.createdAt, 'session header createdAt')
  assertSafeInteger(record.delegationDepth, 'session header delegationDepth')
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new SessionLogError('session header id must be a non-empty string')
  }
  if (typeof record.isSeeded !== 'boolean') {
    throw new SessionLogError('session header isSeeded must be a boolean')
  }
  if (record.origin !== undefined && record.origin !== 'subagent') {
    throw new SessionLogError(`session header origin must be "subagent" when present, got ${JSON.stringify(record.origin)}`)
  }
  for (const key of ['cwd', 'parentSession', 'agentPreset'] as const) {
    const entry = record[key]
    if (entry !== undefined && typeof entry !== 'string') {
      throw new SessionLogError(`session header ${key} must be a string when present`)
    }
  }
  if (expectedVersion !== undefined && record.version !== expectedVersion) {
    throw new SessionLogError(`session header version ${record.version} does not match the artifact filename version ${expectedVersion}`)
  }
  return record as unknown as SessionHeader
}

/**
 * Validate one event envelope against the admission rules.
 * @param value - parsed JSON of one event line.
 * @param index - zero-based position of the line after the header; `seq` must equal it.
 * @param knownTypes - types this build understands; unknown ones need `ignorable: true`.
 * @returns the validated event.
 */
export function parseEvent(
  value: unknown,
  index: number,
  knownTypes: ReadonlySet<string> = KNOWN_SESSION_EVENT_TYPES,
): SessionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionLogError(`event ${index} must be a JSON object`)
  }
  const record = withoutUndefined(value as Record<string, unknown>)
  for (const key of Object.keys(record)) {
    if (!EVENT_ENVELOPE_KEYS.has(key)) throw new SessionLogError(`event ${index} has unknown envelope key "${key}"`)
  }
  if (typeof record.type !== 'string' || record.type.length === 0) {
    throw new SessionLogError(`event ${index} type must be a non-empty string`)
  }
  assertSafeInteger(record.seq, `event ${index} seq`)
  assertSafeInteger(record.time, `event ${index} time`)
  if (record.seq !== index) {
    throw new SessionLogError(`event ${index} seq must be the dense zero-based index ${index}, got ${record.seq}`)
  }
  if (!('data' in record)) throw new SessionLogError(`event ${index} is missing "data"`)

  const type = record.type
  const isSurface = SURFACE_EVENT_TYPES.has(type)
  if (isSurface && record.surfaceOp === undefined) {
    throw new SessionLogError(`event ${index} "${type}" is surface-eligible and requires a surfaceOp marker`)
  }
  if (!isSurface && record.surfaceOp !== undefined) {
    throw new SessionLogError(`event ${index} "${type}" is log-only and must not carry a surfaceOp marker`)
  }
  if (record.surfaceOp !== undefined) validateSurfaceOp(record.surfaceOp, index)

  if (record.ignorable !== undefined && record.ignorable !== true) {
    throw new SessionLogError(`event ${index} ignorable must be exactly true when present`)
  }
  if (!knownTypes.has(type) && record.ignorable !== true) {
    throw new SessionLogError(`event ${index} has unknown type "${type}" and no ignorable marker; DSH would refuse the log`)
  }
  if (record.sourceEventSeqs !== undefined) {
    if (!Array.isArray(record.sourceEventSeqs)) {
      throw new SessionLogError(`event ${index} sourceEventSeqs must be an array`)
    }
    for (const seq of record.sourceEventSeqs) assertSafeInteger(seq, `event ${index} sourceEventSeqs entry`)
  }
  return record as unknown as SessionEvent
}

/**
 * Validate a `surfaceOp` value.
 * @param value - the marker to check.
 * @param index - event index, for the error message.
 * @returns nothing; throws when the marker is malformed.
 */
function validateSurfaceOp(value: unknown, index: number): void {
  if (value === 'append') return
  if (typeof value !== 'object' || value === null) {
    throw new SessionLogError(`event ${index} surfaceOp must be "append" or a replace marker`)
  }
  const marker = value as Record<string, unknown>
  if (marker.op !== 'replace') throw new SessionLogError(`event ${index} surfaceOp.op must be "replace"`)
  assertSafeInteger(marker.startSeq, `event ${index} surfaceOp.startSeq`)
  assertSafeInteger(marker.endSeq, `event ${index} surfaceOp.endSeq`)
}

/**
 * Decode a whole log.
 * @param text - decompressed log text.
 * @param expectedVersion - version named by the artifact filename, when known.
 * @param knownTypes - types this build understands.
 * @returns the validated header and events.
 */
export function parseSessionLog(
  text: string,
  expectedVersion?: number,
  knownTypes: ReadonlySet<string> = KNOWN_SESSION_EVENT_TYPES,
): { header: SessionHeader; events: SessionEvent[] } {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new SessionLogError('session log is empty')
  const header = parseHeader(JSON.parse(lines[0]!), expectedVersion)
  const events = lines.slice(1).map((line, index) => parseEvent(JSON.parse(line), index, knownTypes))
  return { header, events }
}

/**
 * Encode a header and its events as log text.
 * @param header - validated header; written first, alone.
 * @param events - validated events, in `seq` order.
 * @returns newline-terminated JSONL, one record per line.
 */
export function serializeSessionLog(header: SessionHeader, events: readonly SessionEvent[]): string {
  const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))]
  return `${lines.join('\n')}\n`
}

/**
 * Drop keys whose value is `undefined`, so a programmatically built record
 * treats an explicitly undefined field the same way a decoded one does.
 * @param record - candidate record.
 * @returns a copy without undefined-valued keys.
 */
function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Enforce the integer fields the format requires.
 * @param value - candidate value.
 * @param label - field name for the error message.
 * @returns nothing; throws when the value is not a non-negative safe integer.
 */
function assertSafeInteger(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionLogError(`${label} must be a non-negative safe integer, got ${JSON.stringify(value)}`)
  }
}
