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
import { isAbsolute } from 'node:path'

import type { RolloutDraft } from '../../codex-adapter/src/rollout.ts'
import type { JsonObject } from '../../codex-adapter/src/rollout.ts'
import type { SessionEvent, SessionHeader } from '../../dsh-adapter/src/format.ts'
import { currentSurface } from '../../dsh-adapter/src/surface.ts'
import { RECOVERY_FIELD, TOOL_OUTCOME_UNKNOWN, pendingOutcomes } from './conventions.ts'

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

export function assertDshMigrationSource(header: SessionHeader): void {
  if (header.origin === 'subagent') {
    throw new Error('Refusing migration: DSH subagent sources are excluded from ACP session/list and session/resume')
  }
  if (header.parentSession !== undefined) {
    throw new Error('Refusing migration: DSH forked sources with parentSession are excluded from ACP session/list and session/resume')
  }
  if (typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) {
    throw new Error('Refusing migration: DSH source cwd must be an absolute path for ACP visibility; --cwd remapping does not override source eligibility')
  }
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
  assertDshMigrationSource(header)
  const surface = currentSurface(events)
  const activeSequences = new Set(surface.map(event => event.seq))
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
  const modelSource = firstModelSource(surface)
  const provider = options.modelProvider ?? modelSource?.provider ?? 'unknown'
  const model = modelSource?.model ?? 'unknown'
  // Needed inside the loop for `item_completed.thread_id`, and at the end for
  // `session_meta.id`: both must equal the registered thread id.
  const threadId = options.threadId ?? header.id

  let turn: TurnState | undefined
  const emittedCalls = new Map<string, JsonObject>()
  const loggedCalls = new Map<string, SessionEvent>()
  const advertisedCalls = new Set<string>()
  const settledCalls = new Set<string>()
  const unresolvedOutcomes = new Set<string>()
  const owners = new Map<number, number>()
  let sourceTurn = 1
  for (const event of events) {
    const data = (event.data ?? {}) as JsonObject
    if (event.type === 'turn/start' && typeof data.turn === 'number') sourceTurn = data.turn
    owners.set(event.seq, typeof data.turn === 'number' ? data.turn : sourceTurn)
    if (event.type === 'tool/call') loggedCalls.set(`${owners.get(event.seq)}/${String(data.callId)}`, event)
    if (event.type === 'tool/result') {
      const message = (data.message ?? {}) as JsonObject
      const callId = String((message.source as JsonObject | undefined)?.callId ?? message.toolCallId ?? data.toolCallId)
      settledCalls.add(`${owners.get(event.seq)}/${callId}`)
      if ((data.error as JsonObject | undefined)?.code === TOOL_OUTCOME_UNKNOWN) unresolvedOutcomes.add(callId)
      else unresolvedOutcomes.delete(callId)
    }
    if (event.type === 'assistant/message') {
      const message = (data.message ?? {}) as JsonObject
      for (const block of Array.isArray(message.content) ? message.content as JsonObject[] : []) {
        if (block.type === 'tool-call') advertisedCalls.add(`${owners.get(event.seq)}/${String(block.id)}`)
      }
    }
    if (event.surfaceOp !== undefined) {
      if (!activeSequences.has(event.seq)) tally(event.type, 'dropped', 'not in the current DSH surface; retained only in the source audit log')
    } else if (['turn/start', 'turn/end'].includes(event.type)) tally(event.type, 'mapped')
    else if (event.type === 'step/start' || event.type === 'step/end') tally(event.type, 'dropped', 'Codex models turns but not steps')
    else if (event.type !== 'tool/call') tally(event.type, 'dropped', 'log-only DSH event, not current model history')
  }

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

  const emitCall = (data: JsonObject, owner: number, atMs: number): void => {
    if (typeof data.callId !== 'string' || data.callId.length === 0 || typeof data.name !== 'string' || data.name.length === 0) {
      throw new Error('Refusing migration: active DSH tool call is missing its identity')
    }
    const callId = String(data.callId)
    const key = `${owner}/${callId}`
    const identity = { name: String(data.name), arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}) }
    const logged = loggedCalls.get(key)?.data as JsonObject | undefined
    if (logged !== undefined && (logged.name !== identity.name || logged.arguments !== identity.arguments)) {
      throw new Error('Refusing migration: active tool advertisement does not match its recorded call')
    }
    const previous = emittedCalls.get(key)
    if (previous !== undefined) {
      if (previous.name !== identity.name || previous.arguments !== identity.arguments) {
        throw new Error('Refusing migration: contradictory active tool advertisements')
      }
      return
    }
    emittedCalls.set(key, identity)
    push('response_item', {
      type: 'function_call', id: `fc_${callId}`, ...identity, call_id: callId,
      internal_chat_message_metadata_passthrough: { turn_id: turn!.turnId },
    }, iso(atMs))
    tally('tool/call', 'mapped')
  }

  const activeCalls = new Set<string>()
  const activeUnknown = new Set<string>()
  const exportEvents = [...surface]
  for (const event of surface) {
    const data = (event.data ?? {}) as JsonObject
    const message = (data.message ?? {}) as JsonObject
    if (event.type === 'user/message') {
      for (const operation of pendingOutcomes(data.source)) activeUnknown.add(operation.callId)
    }
    for (const block of Array.isArray(message.content) ? message.content as JsonObject[] : []) {
      if (event.type === 'assistant/message' && block.type === 'tool-call') activeCalls.add(`${owners.get(event.seq)}/${String(block.id)}`)
    }
    if (event.type === 'tool/result') {
      const callId = String((message.source as JsonObject | undefined)?.callId ?? message.toolCallId ?? data.toolCallId)
      activeCalls.add(`${owners.get(event.seq)}/${callId}`)
      if ((data.error as JsonObject | undefined)?.code === TOOL_OUTCOME_UNKNOWN) activeUnknown.add(callId)
    }
  }
  if ([...unresolvedOutcomes].some(callId => !activeUnknown.has(callId))) {
    throw new Error('Refusing migration: an unknown tool outcome has no machine-readable carrier on the current DSH surface')
  }
  for (const [key, event] of loggedCalls) {
    if (!advertisedCalls.has(key) && !activeCalls.has(key) && !settledCalls.has(key)) exportEvents.push(event)
    else if (!activeCalls.has(key)) tally('tool/call', 'dropped', 'advertisement and result are outside the current DSH surface')
  }

  for (const event of exportEvents) {
    const kind = event.type
    const atMs = typeof event.time === 'number' ? event.time : header.createdAt
    const data = (event.data ?? {}) as JsonObject
    const owner = owners.get(event.seq) ?? 1
    if (turn !== undefined && turn.turn !== owner) closeTurn(atMs)
    turn ??= openTurn(owner, atMs)

    switch (kind) {
      case 'user/message': {
        turn ??= openTurn(1, atMs)
        const content = toCodexContent(data.content, 'input_text')
        if (content.dropped > 0) {
          tally(CONTENT_BLOCKS, 'dropped', 'DSH content blocks with no Codex equivalent (only text survives)', content.dropped)
        }
        const pending = pendingOutcomes(data.source)
        push('response_item', {
          type: 'message',
          id: `msg_${String(data.id ?? randomUUID())}`,
          role: 'user',
          content: content.blocks,
          internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
          ...(pending.length === 0 ? {} : { [RECOVERY_FIELD]: TOOL_OUTCOME_UNKNOWN, pending_operations: pending }),
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
        const content = toCodexContent(Array.isArray(message.content)
          ? (message.content as JsonObject[]).filter(block => block.type !== 'tool-call') : message.content, 'output_text')
        if (content.dropped > 0) {
          tally(CONTENT_BLOCKS, 'dropped', 'DSH content blocks with no Codex equivalent (only text survives)', content.dropped)
        }
        let part = 0
        const emitText = (blocks: JsonObject[]): void => {
          if (blocks.length === 0) return
          const suffix = part++ === 0 ? '' : `_part${part}`
          push('response_item', {
            type: 'message',
            id: `msg_${String(message.id ?? randomUUID())}${suffix}`,
            role: 'assistant',
            content: blocks,
            internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
          }, iso(atMs))
          push('event_msg', {
            type: 'item_completed',
            thread_id: threadId,
            turn_id: turn.turnId,
            item: {
              type: 'AgentMessage',
              id: `item_${String(message.id ?? randomUUID())}${suffix}`,
              client_id: null,
              content: agentItemContent(blocks),
            },
            started_at_ms: atMs,
            completed_at_ms: atMs,
          }, iso(atMs))
        }
        // DSH keeps streamed fragments and per-message usage; Codex has a separate
        // usage record with thread-level counters we cannot reconstruct.
        tally(kind, 'mapped')
        if (data.stream !== undefined && Array.isArray(data.stream) && data.stream.length > 0) {
          tally('assistant/message.stream', 'dropped', 'Codex has no streamed-fragment record')
        }
        if (data.usage !== undefined) {
          tally('assistant/message.usage', 'dropped', 'Codex token_usage_record needs thread-level counters; a partial record risks failing its schema')
        }
        let group: JsonObject[] = []
        for (const block of Array.isArray(message.content) ? message.content as JsonObject[] : []) {
          if (block.type === 'tool-call') {
            emitText(toCodexContent(group, 'output_text').blocks)
            group = []
            emitCall({ callId: block.id, name: block.name, arguments: block.arguments }, owner, atMs)
          } else group.push(block)
        }
        emitText(toCodexContent(group, 'output_text').blocks)
        break
      }

      case 'tool/call': {
        emitCall(data, owner, atMs)
        break
      }

      case 'tool/result': {
        turn ??= openTurn(1, atMs)
        const message = (data.message ?? {}) as JsonObject
        const callId = data.toolCallId ?? message.toolCallId
        const source = (message.source ?? {}) as JsonObject
        const resolved = source.callId ?? callId
        if (typeof resolved !== 'string' || resolved.length === 0 || (callId !== undefined && callId !== resolved)) {
          throw new Error('Refusing migration: active DSH tool result is missing or contradicts its call identity')
        }
        const key = `${owner}/${resolved}`
        if (!emittedCalls.has(key)) {
          const logged = loggedCalls.get(key)
          if (logged === undefined || advertisedCalls.has(key)) {
            throw new Error(`Refusing migration: active tool result ${resolved} has no current advertisement`)
          }
          emitCall(logged.data as JsonObject, owner, atMs)
        }
        // HANDOFF §9.2.1: an unknown outcome must survive the migration as an
        // explicit marker, or the target reads the call as settled. A plain known
        // failure keeps `isError` and gets no recovery marker.
        const error = (data.error ?? {}) as JsonObject
        const unknown = error.code === TOOL_OUTCOME_UNKNOWN
        const payload: JsonObject = {
          type: 'function_call_output',
          id: `fco_${resolved}`,
          call_id: resolved,
          output: textOf(message.content),
          internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
        }
        if (unknown) {
          payload.isError = true
          payload[RECOVERY_FIELD] = TOOL_OUTCOME_UNKNOWN
        } else if (message.isError === true) {
          payload.isError = true
        }
        push('response_item', payload, iso(atMs))
        tally(kind, 'mapped')
        break
      }

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
