/**
 * Shared access to the real Codex session store on this machine.
 *
 * Reading every rollout would mean parsing ~88 MB, so both the count and the
 * total bytes are bounded. Tests print only structural facts, never content.
 */
import { readFileSync } from 'node:fs'

import { codexHome, findRollouts, sessionsRoot, type RolloutFile } from '../src/paths.ts'
import { parseRollout, type ParsedRollout } from '../src/rollout.ts'

/** One rollout file together with its decoded contents. */
export interface RolloutCorpusEntry {
  file: RolloutFile
  parsed: ParsedRollout
}

/**
 * Sessions root of the Codex store under test.
 * @returns `$CODEX_SESSIONS_ROOT`, else `$CODEX_HOME/sessions`, else `~/.codex/sessions`.
 */
export function storeRoot(): string {
  return process.env.CODEX_SESSIONS_ROOT ?? sessionsRoot(process.env.CODEX_HOME ?? codexHome())
}

/** Bounds for {@link readRollouts}. */
export interface RolloutCorpusOptions {
  /** Maximum rollout files to read. */
  limit?: number
  /** Stop once accumulated bytes reach this budget. */
  byteBudget?: number
}

/**
 * Read a bounded slice of the machine's rollout store.
 * @param options - file-count and byte limits.
 * @returns decoded rollouts; empty when no store is present.
 */
export function readRollouts(options: RolloutCorpusOptions = {}): RolloutCorpusEntry[] {
  const limit = options.limit ?? 30
  const byteBudget = options.byteBudget ?? 32 * 1024 * 1024
  let files: RolloutFile[]
  try {
    files = findRollouts(storeRoot(), { limit, byteBudget })
  } catch {
    return []
  }
  return files.map((file) => ({ file, parsed: parseRollout(readFileSync(file.path, 'utf8')) }))
}
