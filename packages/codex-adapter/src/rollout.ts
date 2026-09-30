/**
 * Reading Codex rollout logs.
 *
 * A rollout is JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<id>.jsonl`.
 * Every line shares the envelope `{timestamp, ordinal, type, payload}`; nine
 * top-level types were observed over 12280 real lines (25 files):
 * `event_msg`, `response_item`, `token_usage_record`, `turn_context`,
 * `realtime_item`, `world_state`, `inter_agent_communication_metadata`,
 * `session_meta`, `compacted`.
 *
 * This reader is deliberately permissive. Codex owns this format and evolves it,
 * so unknown record types and unknown payload fields are preserved rather than
 * rejected: the only hard requirements are the envelope fields themselves.
 */

/** A JSON object with unknown members. */
export type JsonObject = Record<string, unknown>

/** The envelope every rollout line carries. */
export interface RolloutRecord {
  /** ISO-8601 timestamp assigned by the writer. */
  timestamp: string
  /** Zero-based record index within the rollout; sibling of DSH's `seq`. */
  ordinal: number
  /** Top-level record type. */
  type: string
  /** Type-specific body; `response_item` and `event_msg` carry their own `type` here. */
  payload: JsonObject
}

/** A rollout line whose parse failed, kept so callers can report damage. */
export interface RolloutParseFailure {
  /** Zero-based line index in the file. */
  line: number
  /** Why the line could not be read. */
  reason: string
  /** The raw line, truncated for reporting. */
  excerpt: string
}

/** Everything one rollout file yielded. */
export interface ParsedRollout {
  records: RolloutRecord[]
  failures: RolloutParseFailure[]
}

const ENVELOPE_KEYS = ['timestamp', 'ordinal', 'type', 'payload'] as const

/**
 * Parse one rollout file's text.
 *
 * A malformed line is recorded in `failures` and skipped, because a rollout can
 * be observed mid-append; callers decide whether that is acceptable.
 * @param text - raw file text.
 * @returns parsed records and any per-line failures.
 */
export function parseRollout(text: string): ParsedRollout {
  const records: RolloutRecord[] = []
  const failures: RolloutParseFailure[] = []
  const lines = text.split('\n')
  for (const [line, raw] of lines.entries()) {
    if (raw.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      failures.push({ line, reason: (error as Error).message, excerpt: raw.slice(0, 120) })
      continue
    }
    const failure = validateEnvelope(value, line)
    if (failure) {
      failures.push({ line, reason: failure, excerpt: raw.slice(0, 120) })
      continue
    }
    records.push(value as RolloutRecord)
  }
  return { records, failures }
}

/**
 * Check the envelope fields a record cannot omit.
 * @param value - parsed JSON value.
 * @param line - line index, for the message.
 * @returns a reason string when invalid, else `undefined`.
 */
function validateEnvelope(value: unknown, line: number): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'record is not a JSON object'
  const record = value as JsonObject
  for (const key of ENVELOPE_KEYS) {
    if (!(key in record)) return `record is missing envelope key "${key}"`
  }
  if (typeof record.timestamp !== 'string') return 'envelope timestamp is not a string'
  if (typeof record.ordinal !== 'number' || !Number.isSafeInteger(record.ordinal)) return 'envelope ordinal is not an integer'
  if (typeof record.type !== 'string') return 'envelope type is not a string'
  if (typeof record.payload !== 'object' || record.payload === null) return `payload of "${record.type}" is not an object (line ${line})`
  return undefined
}

/**
 * Count records of one top-level type.
 * @param records - parsed records.
 * @param type - top-level type to count.
 * @returns how many records carry that type.
 */
export function countByType(records: readonly RolloutRecord[], type: string): number {
  return records.reduce((total, record) => total + (record.type === type ? 1 : 0), 0)
}

/**
 * Group records by top-level type and, for `response_item` and `event_msg`, by
 * the payload's own `type`.
 * @param records - parsed records.
 * @returns counts keyed by `type` or `type/payloadType`, descending.
 */
export function summarizeKinds(records: readonly RolloutRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const record of records) {
    const sub = typeof record.payload.type === 'string' ? record.payload.type : undefined
    const key = sub === undefined || record.type === sub ? record.type : `${record.type}/${sub}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1]))
}

/** The `session_meta` payload fields this project relies on. */
export interface SessionMetaPayload extends JsonObject {
  session_id?: string
  id?: string
  cwd?: string
  runtime_workspace_roots?: string[]
  originator?: string
  cli_version?: string
  source?: string
  thread_source?: string
  model_provider?: string
}

/**
 * Read the first `session_meta` record of a rollout.
 * @param records - parsed records.
 * @returns the session metadata, or `undefined` when the file has none.
 */
export function sessionMeta(records: readonly RolloutRecord[]): SessionMetaPayload | undefined {
  const meta = records.find((record) => record.type === 'session_meta')
  return meta?.payload as SessionMetaPayload | undefined
}

/**
 * List records of one top-level type with a given payload type.
 * @param records - parsed records.
 * @param type - top-level type.
 * @param payloadType - optional payload `type` to require.
 * @returns the matching records.
 */
export function select(
  records: readonly RolloutRecord[],
  type: string,
  payloadType?: string,
): RolloutRecord[] {
  return records.filter((record) =>
    record.type === type && (payloadType === undefined || record.payload.type === payloadType))
}

/** Content-block kinds seen inside Codex `message.content` and tool outputs. */
export type CodexContentBlock = JsonObject & { type?: string; text?: string }

/**
 * Normalize a tool result body.
 *
 * Codex stores `function_call_output.output` as a string but
 * `custom_tool_call_output.output` as an array of content blocks; callers that
 * only need text should use this instead of branching themselves.
 * @param payload - a `function_call_output` or `custom_tool_call_output` payload.
 * @returns concatenated text.
 */
export function toolOutputText(payload: JsonObject): string {
  const output = payload.output
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map((block) => (typeof block === 'object' && block !== null && typeof (block as CodexContentBlock).text === 'string'
      ? (block as CodexContentBlock).text!
      : '')).join('')
  }
  return ''
}

/**
 * Start and end timestamps of a turn, from the `task_started` / `task_complete`
 * event pair.
 */
export interface TurnWindow {
  turnId: string
  startedAt?: number
  completedAt?: number
  durationMs?: number
}

/**
 * Collect turn windows in record order.
 * @param records - parsed records.
 * @returns one entry per turn seen, keyed by `turn_id`.
 */
export function turnWindows(records: readonly RolloutRecord[]): TurnWindow[] {
  const windows = new Map<string, TurnWindow>()
  for (const record of records) {
    if (record.type !== 'event_msg') continue
    const turnId = record.payload.turn_id
    if (typeof turnId !== 'string') continue
    const window = windows.get(turnId) ?? { turnId }
    if (record.payload.type === 'task_started' && typeof record.payload.started_at === 'number') {
      window.startedAt = record.payload.started_at
    }
    if (record.payload.type === 'task_complete') {
      if (typeof record.payload.started_at === 'number') window.startedAt = record.payload.started_at
      if (typeof record.payload.completed_at === 'number') window.completedAt = record.payload.completed_at
      if (typeof record.payload.duration_ms === 'number') window.durationMs = record.payload.duration_ms
    }
    windows.set(turnId, window)
  }
  return [...windows.values()]
}
