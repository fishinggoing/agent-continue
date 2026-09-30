/**
 * Writing Codex threads.
 *
 * Making a rollout resumable takes three things, and a rollout file alone is
 * not one of them working by itself:
 *
 * 1. the rollout JSONL at `<home>/sessions/YYYY/MM/DD/rollout-<local>-<id>.jsonl`;
 * 2. a `threads` row in `<home>/state_5.sqlite`, which is the registry
 *    `codex resume` and `codex agents` list from;
 * 3. a cursor row in `<home>/thread_history_1.sqlite` telling the projector that
 *    nothing has been read yet, so it derives `thread_items` / `thread_turns`
 *    from the rollout itself.
 *
 * Measured on a scratch home: a Codex-written turn is 13 records —
 * `session_meta`, `task_started`, developer/user/assistant `message` items,
 * `world_state`, `turn_context`, paired `item_completed` events, token records,
 * `task_complete`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { rolloutPath } from './paths.ts'
import type { JsonObject } from './rollout.ts'

/** One rollout record before the writer assigns its ordinal. */
export interface RolloutDraft {
  /** Top-level record type. */
  type: string
  /** Type-specific body. */
  payload: JsonObject
  /** ISO-8601 timestamp; defaults to the rollout's single timestamp. */
  timestamp?: string
  /** Set on every record after the first to share one timestamp. */
}

/**
 * Encode rollout records as JSONL.
 * @param drafts - records in order; `ordinal` is assigned by position.
 * @param timestamp - ISO-8601 timestamp used for drafts that omit one.
 * @returns the rollout text, newline-terminated.
 */
export function encodeRollout(drafts: readonly RolloutDraft[], timestamp: string): string {
  return drafts.map((draft, ordinal) => `${JSON.stringify({
    timestamp: draft.timestamp ?? timestamp,
    ordinal,
    type: draft.type,
    payload: draft.payload,
  })}\n`).join('')
}

/** What one rollout write produced. */
export interface WrittenRollout {
  /** Absolute path of the rollout. */
  path: string
  /** Size in bytes. */
  bytes: number
  /** Number of records written. */
  records: number
}

/**
 * Write a rollout where Codex will look for it.
 * @param home - Codex home directory.
 * @param sessionId - session id; also the thread id.
 * @param when - local start time, which names the day directory and the filename.
 * @param drafts - records in order.
 * @returns what was written.
 */
export function writeRollout(
  home: string,
  sessionId: string,
  when: Date,
  drafts: readonly RolloutDraft[],
): WrittenRollout {
  const timestamp = when.toISOString()
  const text = encodeRollout(drafts, timestamp)
  const path = rolloutPath(home, when, sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return { path, bytes: Buffer.byteLength(text), records: drafts.length }
}

/**
 * Convert a path to the extended-length form Codex stores in `threads.cwd`.
 * @param path - any absolute path.
 * @returns the `\\?\`-prefixed absolute path with backslash separators.
 */
export function extendedLengthPath(path: string): string {
  const absolute = resolve(path).replace(/\//g, '\\')
  return absolute.startsWith('\\\\?\\') ? absolute : `\\\\?\\${absolute}`
}

/** The `threads` columns this project sets; every other column takes its default. */
export interface ThreadRegistration {
  /** Thread id, equal to the rollout's `session_meta.id`. */
  id: string
  /** Absolute path of the rollout. */
  rolloutPath: string
  /** Creation time in epoch **seconds**. */
  createdAt: number
  /** Last update in epoch **seconds**. */
  updatedAt: number
  /** Origin surface, e.g. `exec`, `vscode`. */
  source: string
  /** Provider id from the Codex config, e.g. `example-provider`. */
  modelProvider: string
  /** Working directory; stored in extended-length form. */
  cwd: string
  /** Session title shown in pickers. */
  title: string
  /** Model name, when known. */
  model?: string
  /** Reasoning effort, when known. */
  reasoningEffort?: string
  /** First user message, shown in listings. */
  firstUserMessage?: string
  /** Short preview text; defaults to the first user message. */
  preview?: string
  /** Originator string, e.g. `codex_exec`. */
  originator?: string
  /** Sandbox policy JSON; defaults to the disabled policy. */
  sandboxPolicy?: string
  /** Approval mode; defaults to `never`. */
  approvalMode?: string
  /** CLI version that owns the store. */
  cliVersion?: string
  /** Thread source; defaults to `user`. */
  threadSource?: string
}

/** Sandbox policy JSON matching a session with no confinement. */
const DEFAULT_SANDBOX_POLICY = JSON.stringify({ type: 'disabled' })
/** History mode of every thread observed in a current store. */
const HISTORY_MODE = 'paginated'

/**
 * Insert the registry row that makes a rollout listable.
 * @param stateDbPath - path to `state_5.sqlite`.
 * @param registration - the thread to register.
 * @returns nothing.
 */
export function registerThread(stateDbPath: string, registration: ThreadRegistration): void {
  const db = new DatabaseSync(stateDbPath)
  try {
    db.prepare(`INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived,
        cli_version, first_user_message, memory_mode, model, reasoning_effort,
        created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms,
        history_mode, is_pinned, originator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 'enabled', ?, ?,
                ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
      registration.id,
      registration.rolloutPath,
      registration.createdAt,
      registration.updatedAt,
      registration.source,
      registration.modelProvider,
      extendedLengthPath(registration.cwd),
      registration.title,
      registration.sandboxPolicy ?? DEFAULT_SANDBOX_POLICY,
      registration.approvalMode ?? 'never',
      registration.cliVersion ?? '',
      registration.firstUserMessage ?? '',
      registration.model ?? null,
      registration.reasoningEffort ?? null,
      registration.createdAt * 1000,
      registration.updatedAt * 1000,
      registration.threadSource ?? 'user',
      registration.preview ?? registration.firstUserMessage ?? '',
      registration.createdAt,
      registration.createdAt * 1000,
      HISTORY_MODE,
      registration.originator ?? null,
    )
  } finally {
    db.close()
  }
}

/**
 * Declare that nothing of a rollout has been projected yet.
 *
 * Without this row the projector has no cursor for the thread; with it set to
 * zero the projector derives `thread_items` and `thread_turns` by reading the
 * rollout from its start.
 * @param threadHistoryDbPath - path to `thread_history_1.sqlite`.
 * @param threadId - thread to seed.
 * @returns nothing.
 */
export function seedProjectionCursor(threadHistoryDbPath: string, threadId: string): void {
  const db = new DatabaseSync(threadHistoryDbPath)
  try {
    db.prepare(`INSERT INTO thread_history_projection_state (thread_id, next_rollout_byte_offset, next_rollout_ordinal)
                VALUES (?, 0, 0)
                ON CONFLICT(thread_id) DO UPDATE SET next_rollout_byte_offset = 0, next_rollout_ordinal = 0`)
      .run(threadId)
  } finally {
    db.close()
  }
}
