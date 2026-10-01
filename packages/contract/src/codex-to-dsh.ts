/**
 * Convert a Codex rollout into a DSH session log.
 *
 * Both sides describe the same thing — turns, messages, tool calls — with
 * different vocabularies. This module owns the mapping and, just as importantly,
 * the record of what it could not carry across.
 *
 * Shape mapping (measured against both real stores):
 *
 * | Codex                                        | DSH                                   |
 * |---|---|
 * | `response_item/message` role=user            | `user/message` (surface)              |
 * | `response_item/message` role=developer       | `developer/message` (surface)         |
 * | `response_item/message` role=assistant       | `assistant/message` (surface)         |
 * | `response_item/function_call`                | `tool/call`                           |
 * | `response_item/function_call_output`         | `tool/result` (surface)               |
 * | `response_item/custom_tool_call`             | `tool/call`                           |
 * | `response_item/custom_tool_call_output`      | `tool/result` (surface)               |
 * | `event_msg/task_started` + `task_complete`   | `turn/start` + `turn/end`             |
 *
 * Nothing is invented. Where Codex holds text this mapping cannot decode, the
 * record is dropped and counted rather than replaced with a placeholder.
 */
import type { RolloutRecord, JsonObject } from '../../codex-adapter/src/rollout.ts'
import { toolOutputText } from '../../codex-adapter/src/rollout.ts'
import type { SessionEvent, SessionHeader } from '../../dsh-adapter/src/format.ts'
import { TOOL_OUTCOME_UNKNOWN } from './conventions.ts'

/** How one category of input was handled. */
export interface MappingTally {
  /** Records carried into the output. */
  mapped: number
  /** Records deliberately left behind. */
  dropped: number
  /** Human-readable reason, set when anything was dropped. */
  reason?: string
}

/** Options for one conversion. */
export interface ConvertOptions {
  /** Session id for the produced log; also names its directory. */
  sessionId: string
  /** Working directory recorded in the header. */
  cwd: string
  /** Creation time in epoch milliseconds; defaults to the first record's time. */
  createdAt?: number
}

/** A converted session plus the account of what happened to every input. */
export interface ConversionResult {
  header: SessionHeader
  events: SessionEvent[]
  /** Per-category tallies keyed by the Codex record kind. */
  tallies: Record<string, MappingTally>
  /** Statements about fidelity that a reader of the migrated session must know. */
  losses: string[]
}

/** Turn accumulator used while walking records. */
interface TurnState {
  turn: number
  turnId: string
  startedAt: number
  step: number
  openStep: boolean
  lastAssistantSeen: boolean
  /**
   * Call ids that were advertised and started but have no result yet.
   *
   * DSH rejects a `step/end` or `turn/end` that closes over an unresolved started
   * call. Leaving the tail open is the correct import shape: DSH's own recovery
   * appends a `TOOL_OUTCOME_UNKNOWN` result for exactly this case
   * (`packages/core/session/src/repair.ts`), which is the honest outcome for a
   * call we never saw finish.
   */
  openCalls: Set<string>
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number }
}

/**
 * Convert Codex rollout records into a DSH session.
 * @param records - parsed rollout records, in file order.
 * @param options - target session identity.
 * @returns the converted session and its fidelity report.
 */
export function convertCodexToDsh(
  records: readonly RolloutRecord[],
  options: ConvertOptions,
): ConversionResult {
  const tallies: Record<string, MappingTally> = {}
  const tally = (kind: string, outcome: 'mapped' | 'dropped', reason?: string, count = 1): void => {
    const entry = tallies[kind] ?? { mapped: 0, dropped: 0 }
    entry[outcome] += count
    if (outcome === 'dropped' && reason !== undefined) entry.reason = reason
    tallies[kind] = entry
  }

  const meta = records.find((record) => record.type === 'session_meta')?.payload
  const provider = typeof meta?.model_provider === 'string' ? meta.model_provider : 'unknown'
  const createdAt = options.createdAt
    ?? (Date.parse(String(records[0]?.timestamp ?? '')) || Date.now())

  const events: SessionEvent[] = []
  let turn: TurnState | undefined
  let turnCount = 0
  let fallbackModel = 'unknown'

  const push = (type: string, data: JsonObject, surfaceOp?: 'append'): void => {
    const event: SessionEvent = { type, seq: events.length, time: eventTime(records, events.length, createdAt), data }
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    events.push(event)
  }

  const closeStep = (): void => {
    if (turn?.openStep !== true) return
    // An unresolved started call makes the closer illegal; the tail stays open.
    if (turn.openCalls.size > 0) return
    push('step/end', { turn: turn.turn, step: turn.step })
    turn.openStep = false
  }

  const closeTurn = (reason: JsonObject): void => {
    if (turn === undefined) return
    if (turn.openCalls.size > 0) {
      // Leave the step and the turn open for DSH's recovery to balance.
      turn = undefined
      return
    }
    closeStep()
    push('turn/end', { turn: turn.turn, reason })
    turn = undefined
  }

  const openTurn = (turnId: string, startedAt: number): void => {
    closeTurn({ kind: 'interrupted' })
    turnCount += 1
    turn = { turn: turnCount, turnId, startedAt, step: 0, openStep: false, lastAssistantSeen: false, openCalls: new Set() }
    push('turn/start', { turn: turn.turn })
  }

  const beginStep = (): TurnState => {
    const current = turn!
    if (current.lastAssistantSeen || !current.openStep) {
      closeStep()
      current.step += 1
      current.lastAssistantSeen = false
      push('step/start', { turn: current.turn, step: current.step })
      current.openStep = true
    }
    return current
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    const kind = kindOf(record)
    switch (kind) {
      case 'session_meta':
        tally(kind, 'mapped')
        break

      case 'event_msg/turn_aborted':
        tally(kind, 'dropped', 'Codex aborts a turn without a DSH equivalent reason payload')
        break

      case 'event_msg/task_started': {
        const turnId = String(record.payload.turn_id ?? `turn-${turnCount + 1}`)
        const startedAt = typeof record.payload.started_at === 'number' ? record.payload.started_at * 1000 : Date.now()
        openTurn(turnId, startedAt)
        tally(kind, 'mapped')
        break
      }

      case 'event_msg/task_complete':
        closeTurn({ kind: 'completed' })
        tally(kind, 'mapped')
        break

      case 'event_msg/token_count':
        // Turn-level usage is taken from token_usage_record, which carries turn_id.
        tally(kind, 'dropped', 'per-request token counters and rate limits have no DSH event')
        break

      case 'turn_context': {
        if (typeof record.payload.model === 'string') fallbackModel = record.payload.model
        if (turn === undefined) {
          const turnId = String(record.payload.turn_id ?? `turn-${turnCount + 1}`)
          openTurn(turnId, Date.parse(record.timestamp) || Date.now())
        }
        tally(kind, 'mapped')
        break
      }

      case 'token_usage_record': {
        const usage = record.payload.turn_token_usage ?? record.payload.usage
        if (turn !== undefined && isUsage(usage)) {
          turn.usage = {
            inputTokens: numberOr(usage.input_tokens),
            outputTokens: numberOr(usage.output_tokens),
            cacheReadTokens: numberOr(usage.cached_input_tokens),
            cacheWriteTokens: numberOr(usage.cache_write_input_tokens),
            totalTokens: numberOr(usage.total_tokens),
          }
          tally(kind, 'mapped')
        } else {
          tally(kind, 'dropped', 'usage record had no open turn or no recognizable counters')
        }
        break
      }

      case 'response_item/reasoning':
        tally(kind, 'dropped', 'Codex reasoning text is encrypted (encrypted_content); DSH has no standalone reasoning event')
        break

      case 'response_item/message': {
        const role = String(record.payload.role ?? '')
        if (role === 'developer' || role === 'system') {
          // Codex injects its own environment block and base instructions here.
          // They are harness context rather than conversation, and DSH's
          // `developer/message` needs a `{turn, step, message}` body whose exact
          // shape no real DSH log in the sample store exercises. Replaying
          // foreign system text would be worse than dropping it.
          tally(kind, 'dropped', `role=${role} is Codex-injected harness context, not conversation`)
          break
        }
        const text = contentText(record.payload.content)
        if (text === '' && !Array.isArray(record.payload.content)) {
          tally(kind, 'dropped', 'message carried no content blocks')
          break
        }
        if (turn === undefined) openTurn(`turn-${turnCount + 1}`, Date.parse(record.timestamp) || Date.now())
        if (role === 'assistant') {
          const current = beginStep()
          const content = toDshContent(record.payload.content)
          if (content.dropped > 0) {
            tally(CONTENT_BLOCKS, 'dropped', 'Codex content blocks with no DSH equivalent (only text survives)', content.dropped)
          }
          push('assistant/message', {
            turn: current.turn,
            step: current.step,
            message: {
              id: String(record.payload.id ?? `msg-${events.length}`),
              role: 'assistant',
              content: content.blocks,
              source: { kind: 'model', provider, model: modelOf(record, fallbackModel) },
            },
            ...(current.usage === undefined ? {} : { usage: current.usage }),
            stream: [],
          }, 'append')
          current.lastAssistantSeen = true
          current.usage = undefined
        } else {
          beginStep()
          const content = toDshContent(record.payload.content)
          if (content.dropped > 0) {
            tally(CONTENT_BLOCKS, 'dropped', 'Codex content blocks with no DSH equivalent (only text survives)', content.dropped)
          }
          push('user/message', {
            id: String(record.payload.id ?? `msg-${events.length}`),
            role: 'user',
            content: content.blocks,
            source: { kind: 'user' },
          }, 'append')
        }
        tally(kind, 'mapped')
        break
      }

      case 'response_item/function_call':
      case 'response_item/custom_tool_call': {
        if (turn === undefined) openTurn(`turn-${turnCount + 1}`, Date.parse(record.timestamp) || Date.now())
        const current = beginStep()

        // Codex emits parallel calls as sibling records; take the whole run so one
        // assistant message can advertise all of them.
        const run: { callId: string; name: string; args: string; kind: string }[] = []
        let probe = index
        while (probe < records.length) {
          const candidate = records[probe]!
          const candidateKind = kindOf(candidate)
          if (candidateKind !== 'response_item/function_call' && candidateKind !== 'response_item/custom_tool_call') break
          run.push({
            callId: String(candidate.payload.call_id ?? `call-${probe}`),
            name: String(candidate.payload.name ?? 'unknown'),
            args: candidateKind === 'response_item/function_call'
              ? String(candidate.payload.arguments ?? '')
              : JSON.stringify(candidate.payload.input ?? ''),
            kind: candidateKind,
          })
          probe += 1
        }

        // v4 requires every tool call to be *advertised* by an assistant message in
        // the same turn and step, before its `tool/call`, with id, name, and
        // arguments matching exactly (`session-format-v3-to-v4/src/relationships.ts`).
        // Omitting this is what made DSH reject imported tool sessions with
        // "has no advertised tool lifecycle".
        push('assistant/message', {
          turn: current.turn,
          step: current.step,
          message: {
            id: `msg-advertise-${current.turn}-${current.step}-${run.length}`,
            role: 'assistant',
            content: run.map((call) => ({ type: 'tool-call', id: call.callId, name: call.name, arguments: call.args })),
            source: { kind: 'model', provider, model: fallbackModel },
          },
          stream: [],
        }, 'append')

        for (const call of run) {
          push('tool/call', { turn: current.turn, step: current.step, callId: call.callId, name: call.name, arguments: call.args })
          current.openCalls.add(call.callId)
          tally(call.kind, 'mapped')
        }
        index = probe - 1
        break
      }

      case 'response_item/function_call_output':
      case 'response_item/custom_tool_call_output': {
        if (turn === undefined) {
          tally(kind, 'dropped', 'tool result appeared before any turn opened')
          break
        }
        const current = beginStep()
        const callId = String(record.payload.call_id ?? '')
        // An explicit recovery marker is the only signal we treat as "unknown
        // outcome"; a plain known failure stays a plain failure (HANDOFF §9.2.1).
        const recovery = record.payload.recovery === TOOL_OUTCOME_UNKNOWN
        const message: JsonObject = {
          id: String(record.payload.id ?? `tool-${events.length}`),
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{ type: 'text', text: toolOutputText(record.payload) }],
        }
        if (record.payload.isError === true || recovery) message.isError = true
        else if (record.payload.isError === false) message.isError = false
        else {
          // Codex records carry no error flag for successful results. Asserting
          // `false` would be inventing a fact, so the field is left unset and the
          // omission is reported instead.
          tally('tool/result.error-status', 'dropped', 'Codex tool output carries no error flag, so DSH isError is left unset rather than asserted false')
        }
        const data: JsonObject = { turn: current.turn, step: current.step, message }
        if (recovery) data.error = { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
        push('tool/result', data, 'append')
        current.openCalls.delete(callId)
        tally(kind, 'mapped')
        break
      }

      default:
        tally(kind, 'dropped', 'no DSH event corresponds to this Codex record')
        break
    }
  }
  closeTurn({ kind: 'interrupted' })

  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id: options.sessionId,
    createdAt,
    cwd: options.cwd,
    isSeeded: false,
    delegationDepth: 0,
  }

  return { header, events, tallies, losses: describeLosses(tallies) }
}

/**
 * Label a record as `type` or `type/payloadType`.
 * @param record - rollout record.
 * @returns the label used for tallies.
 */
function kindOf(record: RolloutRecord): string {
  const sub = typeof record.payload.type === 'string' ? record.payload.type : undefined
  return sub === undefined || sub === record.type ? record.type : `${record.type}/${sub}`
}

/**
 * Turn a parsed timestamp into epoch milliseconds, falling back to the session start.
 * @param records - the source records.
 * @param index - event index, clamped to the record range.
 * @param fallback - value used when no timestamp parses.
 * @returns epoch milliseconds.
 */
function eventTime(records: readonly RolloutRecord[], index: number, fallback: number): number {
  const record = records[Math.min(index, records.length - 1)]
  const parsed = record === undefined ? Number.NaN : Date.parse(record.timestamp)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Read the model that produced a message.
 * @param record - the message record.
 * @param fallback - model from the surrounding turn context.
 * @returns the model name.
 */
function modelOf(record: RolloutRecord, fallback: string): string {
  const passthrough = record.payload.internal_chat_message_metadata_passthrough as JsonObject | undefined
  const model = passthrough?.model
  return typeof model === 'string' ? model : fallback
}

/**
 * Concatenate the text of plain content blocks.
 * @param content - a Codex content block array.
 * @returns the concatenated text.
 */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
    ? (block as { text: string }).text
    : '')).join('')
}

/**
 * Tally key for content blocks that could not be carried across.
 *
 * Block-level loss is tracked separately from record-level loss: a message whose
 * envelope survives but whose blocks are dropped must not be reported as a clean
 * mapping.
 */
const CONTENT_BLOCKS = 'message.content-blocks'

/**
 * Convert Codex content blocks into DSH content blocks.
 *
 * DSH's own logs use only `{type:'text', text}` for message content, so Codex's
 * `input_text` / `output_text` are **normalized** rather than passed through.
 * Writing a foreign block type into a DSH log is what silently lost user text
 * before: DSH accepted the artifact and resumed it, so nothing complained.
 * @param content - a Codex content block array.
 * @returns DSH text blocks, plus how many input blocks were dropped.
 */
function toDshContent(content: unknown): { blocks: JsonObject[]; dropped: number } {
  if (!Array.isArray(content)) return { blocks: [], dropped: 0 }
  const blocks: JsonObject[] = []
  let dropped = 0
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      dropped += 1
      continue
    }
    const entry = block as JsonObject
    const type = entry.type
    const text = entry.text
    const isText = type === 'text' || type === 'input_text' || type === 'output_text'
    if (isText && typeof text === 'string') blocks.push({ type: 'text', text })
    else dropped += 1
  }
  return { blocks, dropped }
}

/**
 * Check for a usage object.
 * @param value - candidate.
 * @returns true when the value looks like a usage counter object.
 */
function isUsage(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && 'total_tokens' in value
}

/**
 * Read a counter defensively.
 * @param value - candidate counter.
 * @returns the number, or 0 when absent.
 */
function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Turn per-category tallies into statements a reader must know.
 * @param tallies - the conversion tallies.
 * @returns one line per category that lost anything.
 */
function describeLosses(tallies: Record<string, MappingTally>): string[] {
  return Object.entries(tallies)
    .filter(([, entry]) => entry.dropped > 0)
    .map(([kind, entry]) => `${kind}: ${entry.dropped} record(s) dropped — ${entry.reason ?? 'no mapping'}`)
    .sort()
}
