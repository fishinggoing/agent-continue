/**
 * On-disk layout of the Codex session store.
 *
 * Layout: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local-iso>-<session_id>.jsonl`.
 *
 * The timestamp in the filename is **local time without a zone suffix**, not the
 * UTC time carried by `session_meta.timestamp`. Measured on three sessions: a
 * rollout named `...T15-25-52-...` holds `session_meta.timestamp`
 * `2026-09-30T07:25:52.359Z`, i.e. UTC+8. The date directories follow the same
 * local clock, so a writer must format local time or the file lands in the
 * wrong day directory.
 *
 * The registry that makes a rollout listable lives beside it:
 * `<CODEX_HOME>/state_5.sqlite` holds `threads`, and
 * `<CODEX_HOME>/thread_history_1.sqlite` holds the derived projections.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Name of the SQLite store holding the `threads` registry. */
export const STATE_STORE_FILENAME = 'state_5.sqlite'
/** Name of the SQLite store holding derived thread projections. */
export const THREAD_HISTORY_FILENAME = 'thread_history_1.sqlite'
/** Subdirectory of the Codex home that holds rollout logs. */
export const SESSIONS_DIRNAME = 'sessions'

const ROLLOUT_FILENAME = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/

/**
 * Resolve the Codex home directory.
 * @param env - environment to read `CODEX_HOME` from; defaults to `process.env`.
 * @returns the configured home, else `~/.codex`.
 */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME
  if (configured !== undefined && configured !== '') return configured
  return join(env.USERPROFILE ?? env.HOME ?? '', '.codex')
}

/**
 * Sessions root of a Codex home.
 * @param home - Codex home directory.
 * @returns the sessions directory path.
 */
export function sessionsRoot(home: string): string {
  return join(home, SESSIONS_DIRNAME)
}

/**
 * Build a rollout filename from a local timestamp.
 * @param when - the local instant the rollout starts.
 * @param sessionId - session id, appended verbatim.
 * @returns the rollout basename.
 */
export function rolloutFilename(when: Date, sessionId: string): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
    + `T${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`
  return `rollout-${stamp}-${sessionId}.jsonl`
}

/**
 * Absolute path a rollout belongs at, following the local-clock day directory.
 * @param home - Codex home directory.
 * @param when - the local instant the rollout starts.
 * @param sessionId - session id.
 * @returns the rollout path.
 */
export function rolloutPath(home: string, when: Date, sessionId: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return join(
    sessionsRoot(home),
    String(when.getFullYear()),
    pad(when.getMonth() + 1),
    pad(when.getDate()),
    rolloutFilename(when, sessionId),
  )
}

/** What a rollout filename encodes. */
export interface RolloutFilenameParts {
  /** Local start time the filename encodes. */
  startedAt: Date
  /** Session id, which also names the thread in the registry. */
  sessionId: string
}

/**
 * Decode a rollout basename.
 * @param filename - basename to decode.
 * @returns its parts, or `undefined` when the name is not canonical.
 */
export function parseRolloutFilename(filename: string): RolloutFilenameParts | undefined {
  const match = ROLLOUT_FILENAME.exec(filename)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second, sessionId] = match as unknown as string[]
  const startedAt = new Date(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
  )
  return { startedAt, sessionId: sessionId! }
}

/** Options bounding a rollout search. */
export interface FindRolloutsOptions {
  /** Maximum files to return. */
  limit?: number
  /** Stop once accumulated bytes reach this budget. */
  byteBudget?: number
}

/** One discovered rollout. */
export interface RolloutFile {
  /** Absolute path. */
  path: string
  /** Size on disk in bytes. */
  bytes: number
  /** Session id decoded from the filename. */
  sessionId: string
  /** Local start time decoded from the filename. */
  startedAt: Date
}

/**
 * Find rollout logs under a sessions root, newest first.
 * @param root - sessions root, or a Codex home when `home` is true.
 * @param options - limits on count and total size.
 * @returns discovered rollouts.
 */
export function findRollouts(root: string, options: FindRolloutsOptions = {}): RolloutFile[] {
  const limit = options.limit ?? 50
  const budget = options.byteBudget ?? Number.POSITIVE_INFINITY
  const found: RolloutFile[] = []
  let used = 0

  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || used >= budget || depth > 4) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= limit || used >= budget) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, depth + 1)
        continue
      }
      const parts = parseRolloutFilename(entry.name)
      if (parts === undefined) continue
      const bytes = statSync(path).size
      found.push({ path, bytes, sessionId: parts.sessionId, startedAt: parts.startedAt })
      used += bytes
    }
  }
  walk(root, 0)
  return found.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
}
