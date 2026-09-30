/**
 * Writing DSH session artifacts.
 *
 * An artifact is one frame holding only the header line, followed by one frame
 * per durable append batch. DSH validates every record on load, so the writer
 * runs the same admission rules the reader does before anything reaches disk: a
 * rejected record must fail here rather than produce a session the harness
 * refuses to open.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { parseEvent, parseHeader, type SessionEvent, type SessionHeader } from './format.ts'
import { artifactPath, type ArtifactLocation } from './paths.ts'
import { compressFrame } from './zstd.ts'

/** Result of writing one artifact. */
export interface WrittenArtifact {
  /** Absolute path of the artifact. */
  path: string
  /** Encoded size in bytes. */
  bytes: number
  /** Number of frames written: one header frame plus one per batch. */
  frames: number
}

/**
 * Encode a header and its events into artifact bytes.
 * @param header - session header; written alone in the first frame.
 * @param events - events in `seq` order, validated before encoding.
 * @param batches - batch sizes for the frames after the header; defaults to one batch.
 * @returns the encoded artifact bytes.
 */
export function encodeArtifact(
  header: SessionHeader,
  events: readonly SessionEvent[],
  batches: readonly number[] = [events.length],
): Buffer {
  const validatedHeader = parseHeader(header)
  const validatedEvents = events.map((event, index) => parseEvent(event, index))

  const total = batches.reduce((sum, size) => sum + size, 0)
  if (total !== validatedEvents.length) {
    throw new Error(`batch sizes sum to ${total} but there are ${validatedEvents.length} events`)
  }

  const frames = [compressFrame(`${JSON.stringify(validatedHeader)}\n`)]
  let cursor = 0
  for (const size of batches) {
    const batch = validatedEvents.slice(cursor, cursor + size)
    cursor += size
    if (batch.length === 0) continue
    frames.push(compressFrame(batch.map((event) => `${JSON.stringify(event)}\n`).join('')))
  }
  return Buffer.concat(frames)
}

/**
 * Encode an artifact and write it where DSH will look for it.
 * @param root - sessions root, normally `$DSH_HOME/sessions`.
 * @param header - session header; its `id` and `cwd` also name the location.
 * @param events - events in `seq` order.
 * @returns what was written.
 */
export function writeArtifact(
  root: string,
  header: SessionHeader,
  events: readonly SessionEvent[],
): WrittenArtifact {
  const bytes = encodeArtifact(header, events)
  const location: ArtifactLocation = { root, cwd: header.cwd, id: header.id, version: header.version }
  const path = artifactPath(location)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return { path, bytes: bytes.length, frames: 1 + (events.length > 0 ? 1 : 0) }
}
