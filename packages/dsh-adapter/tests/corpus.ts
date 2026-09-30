/**
 * Shared access to the real DSH session store on this machine.
 *
 * Tests read artifacts that DSH itself wrote; they never print record content,
 * only structural counts and type names.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readFrames } from '../src/zstd.ts'

/** One decoded session artifact. */
export interface Artifact {
  /** Absolute path of the artifact on disk. */
  path: string
  /** Header record of the log. */
  header: Record<string, unknown>
  /** Every event record after the header, in file order. */
  records: Record<string, unknown>[]
  /** True when the file ends inside a frame, which an append can do. */
  tornTail: boolean
}

/**
 * Sessions root of the DSH store under test.
 * @returns `$DSH_SESSION_ROOT`, else `$DSH_HOME/sessions`, else `~/.dsh/sessions`.
 */
export function sessionRoot(): string {
  return process.env.DSH_SESSION_ROOT
    ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'sessions')
}

/**
 * Collect committed `session.vN.jsonl.zstd` artifacts under a sessions root.
 * @param root - absolute sessions directory.
 * @param limit - maximum artifacts to return, keeping the corpus bounded.
 * @returns absolute artifact paths.
 */
export function findArtifacts(root: string, limit = 40): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > 4) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= limit) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) found.push(path)
    }
  }
  walk(root, 0)
  return found
}

/**
 * Decode one artifact into its header and event records.
 * @param path - absolute artifact path.
 * @returns the decoded artifact.
 */
export function readArtifact(path: string): Artifact {
  const { text, scan } = readFrames(readFileSync(path))
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const [headerLine, ...eventLines] = lines
  return {
    path,
    header: JSON.parse(headerLine!) as Record<string, unknown>,
    records: eventLines.map((line) => JSON.parse(line) as Record<string, unknown>),
    tornTail: scan.tornStart !== undefined,
  }
}

/**
 * Decode the machine's session store.
 * @param limit - maximum artifacts to read.
 * @returns decoded artifacts; empty when no store is present.
 */
export function readCorpus(limit = 40): Artifact[] {
  let paths: string[]
  try {
    paths = findArtifacts(sessionRoot(), limit)
  } catch {
    return []
  }
  return paths.map(readArtifact)
}
