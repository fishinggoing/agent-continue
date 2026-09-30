/**
 * Convert a DSH session log into a Codex rollout.
 *
 * The harder direction: DSH records more than Codex can express. A DSH log
 * carries 62 event types against Codex's nine top-level record kinds, and DSH
 * models turns *and* steps while Codex models only turns. Everything that has no
 * Codex counterpart is dropped and counted.
 *
 * Shape mapping:
 *
 * | DSH                       | Codex                                  |
 * |---|---|
 * | `turn/start`              | `event_msg/task_started`               |
 * | `turn/end`                | `event_msg/task_complete`              |
 * | `user/message`            | `response_item/message` role=user      |
 * | `assistant/message`       | `response_item/message` role=assistant |
 * | `tool/call`               | `response_item/function_call`          |
 * | `tool/result`             | `response_item/function_call_output`   |
 * | `step/start` / `step/end` | *none* — Codex has no step              |
 *
 * Measured source: a real DSH store at `$DSH_HOME/sessions`.
 */
import { randomUUID } from 'node:crypto'

import type { RolloutDraft } from '../../codex-adapter/src/rollout.ts'
import type { JsonObject } from '../../codex-adapter/src/rollout.ts'
import type { SessionEvent, SessionHeader } from '../../dsh-adapter/src/format.ts'

/** How one category of input was handled. */
export interface MappingTally {
  mapped: number
  dropped: number
  reason?: string
}

/** Options for one conversion. */
export interface ConvertOptions {
  /**
   * `session_meta.cli_version` for the produced rollout.
   *
   * Codex cannot read session metadata without it, so it must be supplied; the
   * value names the Codex build that will own the imported thread.
   */
  cliVersion: string
  /**
   * Id Codex will know this thread by, written to `session_meta.id`.
   *
   * Must equal the id registered in `state_5.sqlite.threads`; a mismatch makes
   * Codex fail to read the session metadata and report the misleading
   * "does not start with session metadata". Defaults to the DSH session id,
   * which is only safe when that id is itself a UUID.
   */
  threadId?: string
  /** Provider recorded on `session_meta`; defaults to the first model source seen. */
  modelProvider?: string
  /** Start time; defaults to the header's `createdAt`. */
  startedAt?: Date
}

/** A converted rollout plus the account of what happened to every input. */
export interface ConversionResult {
  drafts: RolloutDraft[]
  tallies: Record<string, MappingTally>
  losses: string[]
}

/** Accumulates the Codex records for one turn. */
interface TurnState {
  turn: number
  turnId: string
  startedAtMs: number
}

/**
 * Convert a DSH session into Codex rollout drafts.
 * @param header - the session header.
 * @param events - the session's events, in `seq` order.
 * @param options - target identity details Codex requires.
 * @returns the rollout drafts and the fidelity report.
 */
export function convertDshToCodex(
  header: SessionHeader,
  events: readonly SessionEvent[],
  options: ConvertOptions,
): ConversionResult {
  const tallies: Record<string, MappingTally> = {}
  const tally = (kind: string, outcome: 'mapped' | 'dropped', reason?: string): void => {
    const entry = tallies[kind] ?? { mapped: 0, dropped: 0 }
    entry[outcome] += 1
    if (outcome === 'dropped' && reason !== undefined) entry.reason = reason
    tallies[kind] = entry
  }

  const startedAt = options.startedAt ?? new Date(header.createdAt)
  const iso = (ms: number): string => new Date(ms).toISOString()
  const drafts: RolloutDraft[] = []
  const modelSource = firstModelSource(events)
  const provider = options.modelProvider ?? modelSource?.provider ?? 'unknown'
  const model = modelSource?.model ?? 'unknown'
  // Needed inside the loop for `item_completed.thread_id`, and at the end for
  // `session_meta.id`: both must equal the registered thread id.
  const threadId = options.threadId ?? header.id

  let turn: TurnState | undefined
  /** Call ids seen from `tool/call`, so a later result can be paired. */
  const openCalls = new Map<string, string>()

  const push = (type: string, payload: JsonObject, timestamp?: string): void => {
    drafts.push({ type, payload, ...(timestamp === undefined ? {} : { timestamp }) })
  }

  const closeTurn = (atMs: number): void => {
    if (turn === undefined) return
    push('event_msg', {
      type: 'task_complete',
      turn_id: turn.turnId,
      started_at: Math.floor(turn.startedAtMs / 1000),
      completed_at: Math.floor(atMs / 1000),
      duration_ms: Math.max(0, atMs - turn.startedAtMs),
    }, iso(atMs))
    turn = undefined
  }

  const openTurn = (turnNumber: number, atMs: number): TurnState => {
    const created: TurnState = { turn: turnNumber, turnId: randomUUID(), startedAtMs: atMs }
    push('event_msg', {
      type: 'task_started',
      turn_id: created.turnId,
      started_at: Math.floor(atMs / 1000),
      model_context_window: 272_000,
    }, iso(atMs))
    push('turn_context', {
      turn_id: created.turnId,
      root_turn_id: created.turnId,
      cwd: header.cwd ?? '',
      workspace_roots: header.cwd === undefined ? [] : [header.cwd],
      model,
      approval_policy: 'never',
      sandbox_policy: { type: 'disabled' },
    }, iso(atMs))
    return created
  }

  for (const event of events) {
    const kind = event.type
    const atMs = typeof event.time === 'number' ? event.time : header.createdAt
    const data = (event.data ?? {}) as JsonObject

    switch (kind) {
      case 'turn/start':
        closeTurn(atMs)
        turn = openTurn(typeof data.turn === 'number' ? data.turn : 1, atMs)
        tally(kind, 'mapped')
        break

      case 'turn/end':
        closeTurn(atMs)
        tally(kind, 'mapped')
        break

      case 'step/start':
      case 'step/end':
        // Codex has no step concept; the messages inside the step carry its content.
        tally(kind, 'dropped', 'Codex models turns but not steps')
        break

      case 'user/message': {
        turn ??= openTurn(1, atMs)
        const content = toCodexContent(data.content, 'input_text')
        if (content.dropped > 0) {
          tally(CONTENT_BLOCKS, 'dropped', 'DSH content blocks with no Codex equivalent (only text survives)', content.dropped)
        }
        push('response_item', {
          type: 'message',
          id: `msg_${String(data.id ?? randomUUID())}`,
          role: 'user',
          content: content.blocks,
          internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
        }, iso(atMs))
        push('event_msg', {
          type: 'item_completed',
          thread_id: threadId,
          turn_id: turn.turnId,
          item: {
            type: 'UserMessage',
            id: `item_${String(data.id ?? randomUUID())}`,
            client_id: null,
            content: userItemContent(content.blocks),
          },
          started_at_ms: atMs,
          completed_at_ms: atMs,
        }, iso(atMs))
        tally(kind, 'mapped')
        break
      }

      case 'assistant/message': {
        turn ??= openTurn(1, atMs)
        const message = (data.message ?? {}) as JsonObject
        const content = toCodexContent(message.content, 'output_text')
        if (content.dropped > 0) {
          tally(CONTENT_BLOCKS, 'dropped', 'DSH content blocks with no Codex equivalent (only text survives)', content.dropped)
        }
        push('response_item', {
          type: 'message',
          id: `msg_${String(message.id ?? randomUUID())}`,
          role: 'assistant',
          content: content.blocks,
          internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
        }, iso(atMs))
        push('event_msg', {
          type: 'item_completed',
          thread_id: threadId,
          turn_id: turn.turnId,
          item: {
            type: 'AgentMessage',
            id: `item_${String(message.id ?? randomUUID())}`,
            client_id: null,
            content: agentItemContent(content.blocks),
          },
          started_at_ms: atMs,
          completed_at_ms: atMs,
        }, iso(atMs))
        // DSH keeps streamed fragments and per-message usage; Codex has a separate
        // usage record with thread-level counters we cannot reconstruct.
        tally(kind, 'mapped')
        if (data.stream !== undefined && Array.isArray(data.stream) && data.stream.length > 0) {
          tally('assistant/message.stream', 'dropped', 'Codex has no streamed-fragment record')
        }
        if (data.usage !== undefined) {
          tally('assistant/message.usage', 'dropped', 'Codex token_usage_record needs thread-level counters; a partial record risks failing its schema')
        }
        break
      }

      case 'tool/call': {
        turn ??= openTurn(1, atMs)
        const callId = String(data.callId ?? randomUUID())
        const name = String(data.name ?? 'unknown')
        openCalls.set(callId, name)
        push('response_item', {
          type: 'function_call',
          id: `fc_${callId}`,
          name,
          arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
          call_id: callId,
          internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
        }, iso(atMs))
        tally(kind, 'mapped')
        break
      }

      case 'tool/result': {
        turn ??= openTurn(1, atMs)
        const message = (data.message ?? {}) as JsonObject
        const callId = String(data.toolCallId ?? message.toolCallId ?? randomUUID())
        const source = (message.source ?? {}) as JsonObject
        const resolved = typeof source.callId === 'string' ? source.callId : callId
        openCalls.delete(resolved)
        push('response_item', {
          type: 'function_call_output',
          id: `fco_${resolved}`,
          call_id: resolved,
          output: textOf(message.content),
          internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
        }, iso(atMs))
        tally(kind, 'mapped')
        break
      }

      case 'session-log-deepseek/delivery-accepted':
        tally(kind, 'dropped', 'harness-private delivery bookkeeping')
        break

      default:
        tally(kind, 'dropped', 'no Codex record corresponds to this DSH event')
        break
    }
  }
  closeTurn(events.length === 0 ? header.createdAt : (events[events.length - 1]!.time ?? header.createdAt))

  // `session_meta` must be the first record, its `id` must equal the id the
  // registry row uses, and its `history_mode` must match that row. Codex refuses
  // to build paginated history when the two disagree, which leaves a thread that
  // resumes without error but has no readable history.
  const meta: RolloutDraft = {
    type: 'session_meta',
    timestamp: iso(header.createdAt),
    payload: {
      session_id: threadId,
      id: threadId,
      timestamp: iso(header.createdAt),
      cwd: header.cwd ?? '',
      runtime_workspace_roots: header.cwd === undefined ? [] : [header.cwd],
      originator: 'codex_exec',
      cli_version: options.cliVersion,
      source: 'exec',
      thread_source: 'user',
      model_provider: provider,
      history_mode: HISTORY_MODE,
    },
  }
  drafts.unshift(meta)
  tally('session_meta', 'mapped')

  return { drafts, tallies, losses: describeLosses(tallies) }
}

/** History mode of every thread observed in a current Codex store. */
const HISTORY_MODE = 'paginated'

/**
 * Content encoding for a `UserMessage` projection item.
 *
 * Codex encodes `item_completed` items differently from `response_item/message`:
 * these are **not** interchangeable, and reusing one for the other is why
 * migrated threads showed up with empty history. Measured against a control
 * rollout written by the real binary.
 * @param blocks - Codex `input_text` blocks produced for the message record.
 * @returns `UserMessage` content blocks.
 */
function userItemContent(blocks: readonly JsonObject[]): JsonObject[] {
  return blocks.map((block) => ({ type: 'text', text: block.text, text_elements: [] }))
}

/**
 * Content encoding for an `AgentMessage` projection item.
 *
 * The block type is capitalised `Text` here, unlike `response_item`'s
 * `output_text`. That asymmetry is Codex's, and was read off a rollout the real
 * binary wrote.
 * @param blocks - Codex `output_text` blocks produced for the message record.
 * @returns `AgentMessage` content blocks.
 */
function agentItemContent(blocks: readonly JsonObject[]): JsonObject[] {
  return blocks.map((block) => ({ type: 'Text', text: block.text }))
}

/** Provider and model recorded on the first assistant message. */
function firstModelSource(events: readonly SessionEvent[]): { provider?: string; model?: string } | undefined {
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const message = ((event.data ?? {}) as JsonObject).message as JsonObject | undefined
    const source = message?.source as JsonObject | undefined
    if (source === undefined) continue
    return {
      ...(typeof source.provider === 'string' ? { provider: source.provider } : {}),
      ...(typeof source.model === 'string' ? { model: source.model } : {}),
    }
  }
  return undefined
}

/** Tally key for content blocks that could not be carried across. */
const CONTENT_BLOCKS = 'message.content-blocks'

/**
 * Convert DSH content blocks into Codex content blocks.
 *
 * Only text survives: DSH reasoning and tool-call blocks have no Codex content
 * equivalent — Codex keeps reasoning in `encrypted_content` and tool calls as
 * their own records. `input_text` / `output_text` are accepted as well as
 * `text`, because a log written by an older converter may still carry them.
 * @param content - DSH content block array.
 * @param textType - `input_text` for user messages, `output_text` for assistant.
 * @returns Codex content blocks, plus how many input blocks were dropped.
 */
function toCodexContent(content: unknown, textType: string): { blocks: JsonObject[]; dropped: number } {
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
    if (isText && typeof text === 'string') blocks.push({ type: textType, text })
    else dropped += 1
  }
  return { blocks, dropped }
}

/**
 * Concatenate a DSH tool result's text.
 * @param content - DSH content block array.
 * @returns the concatenated text.
 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
    ? (block as { text: string }).text
    : '')).join('')
}

/**
 * Turn per-category tallies into statements a reader must know.
 * @param tallies - conversion tallies.
 * @returns one line per category that lost anything.
 */
function describeLosses(tallies: Record<string, MappingTally>): string[] {
  return Object.entries(tallies)
    .filter(([, entry]) => entry.dropped > 0)
    .map(([kind, entry]) => `${kind}: ${entry.dropped} dropped — ${entry.reason ?? 'no mapping'}`)
    .sort()
}
