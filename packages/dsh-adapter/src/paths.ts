/**
 * On-disk layout of DeepSeek Harness session artifacts.
 *
 * Layout: `<root>/--<projectKey(cwd)>--/<encodeSegment(id)>/session.vN.jsonl[.zstd]`,
 * where `root` is `$DSH_HOME/sessions`. Both names derive from the session
 * header, and DSH re-derives the expected path from that header when it opens a
 * log (`assertStoredIdentity`): a file whose location does not match its own
 * `cwd` + `id` is rejected as corrupt. So a foreign writer has no freedom here.
 *
 * Rules mirror `session-persistence-jsonl/src/format.ts`.
 */
import { join } from 'node:path'

/** Physical encoding of a JSONL session artifact. */
export type JsonlCompression = 'zstd' | 'none'

/** Characters that survive encoding literally, besides the escape character itself. */
const SAFE_CODE_UNIT = /^[A-Za-z0-9._-]$/
/** Maximum length of the readable part of a project directory name. */
const PROJECT_SLUG_LIMIT = 251

/**
 * Encode one arbitrary string into a single safe path segment.
 *
 * Safe code units stay literal; everything else — including `~`, path
 * separators, and NUL — becomes `~XXXX` (uppercase hex of the code unit). `.`
 * and `..` are special-cased so an otherwise safe segment cannot traverse.
 * @param raw - the string to encode; throws when empty.
 * @returns the escaped segment, decodable back to `raw`.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && SAFE_CODE_UNIT.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the human-navigable project directory name for a working directory.
 *
 * Runs of `/`, `\`, and `:` collapse into a single `-`; other unsafe code units
 * use the same `~XXXX` escape as segments. Separator replacement and truncation
 * are deliberately lossy, so this name is not a reversible encoding of `cwd`.
 * @param cwd - the session's project directory; throws when empty.
 * @returns the project directory name, wrapped in `--`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let inSeparatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!inSeparatorRun) readable += '-'
      inSeparatorRun = true
    } else if (ch !== '~' && SAFE_CODE_UNIT.test(ch)) {
      readable += ch
      inSeparatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      inSeparatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, PROJECT_SLUG_LIMIT)}--`
}

/**
 * Directory that groups every session recorded for one working directory.
 * @param root - the sessions root, normally `$DSH_HOME/sessions`.
 * @param cwd - the session's project directory, or `undefined` for `_no-cwd`.
 * @returns the project directory path.
 */
export function projectDir(root: string, cwd: string | undefined): string {
  return cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
}

/**
 * Basename of one immutable format generation.
 * @param version - session format version; 0 keeps the untagged `session.jsonl`.
 * @param compression - configured physical encoding.
 * @returns the artifact basename.
 */
export function generationLogFilename(version: number, compression: JsonlCompression): string {
  assertFormatVersion(version)
  const base = version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`
  return `${base}${compression === 'zstd' ? '.zstd' : ''}`
}

/** Options locating one session artifact. */
export interface ArtifactLocation {
  /** Sessions root, normally `$DSH_HOME/sessions`. */
  root: string
  /** Session working directory from the header; `undefined` selects `_no-cwd`. */
  cwd: string | undefined
  /** Session id from the header. */
  id: string
  /** Session format version from the header. */
  version: number
  /** Physical encoding; DSH defaults to `zstd`. */
  compression?: JsonlCompression
}

/**
 * Directory holding one session's artifacts.
 * @param location - root, cwd, and id.
 * @returns the session directory path.
 */
export function sessionDir(location: Pick<ArtifactLocation, 'root' | 'cwd' | 'id'>): string {
  return join(projectDir(location.root, location.cwd), encodeSegment(location.id))
}

/**
 * Absolute path DSH will derive from a session header.
 * @param location - root, cwd, id, version, and optional encoding.
 * @returns the artifact path expected by `assertStoredIdentity`.
 */
export function artifactPath(location: ArtifactLocation): string {
  const compression = location.compression ?? 'zstd'
  return join(sessionDir(location), generationLogFilename(location.version, compression))
}

/**
 * Judge a session format version the way DSH's own guard does.
 * @param version - candidate version.
 * @returns nothing; throws when the version cannot name a generation.
 */
export function assertFormatVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`session format version must be a non-negative safe integer, got ${version}`)
  }
}
