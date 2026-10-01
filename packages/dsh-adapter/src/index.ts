/**
 * Public surface of the DSH session adapter.
 *
 * Reading and writing `session.vN.jsonl.zstd` artifacts from outside the
 * harness: locate frame boundaries, decode records, and derive the on-disk
 * location DSH expects from a session header.
 */
export {
  compressFrame,
  decompressFrame,
  readFrames,
  scanFrames,
  type FrameRange,
  type FrameScan,
} from './zstd.ts'

export {
  artifactPath,
  assertFormatVersion,
  encodeSegment,
  generationLogFilename,
  projectDir,
  projectKey,
  sessionDir,
  type ArtifactLocation,
  type JsonlCompression,
} from './paths.ts'

export {
  KNOWN_SESSION_EVENT_TYPES,
  SURFACE_EVENT_TYPES,
  SessionLogError,
  parseEvent,
  parseHeader,
  parseSessionLog,
  serializeSessionLog,
  type SessionEvent,
  type SessionHeader,
  type SurfaceOp,
} from './format.ts'

export {
  encodeArtifact,
  writeArtifact,
  type WriteArtifactOptions,
  type WrittenArtifact,
} from './write.ts'

export { currentSurface } from './surface.ts'
