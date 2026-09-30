/**
 * Zstandard frame container used by DSH session artifacts.
 *
 * A `session.vN.jsonl.zstd` artifact is a concatenation of independently
 * decodable zstd frames: the first frame holds only the session header line and
 * every later frame holds one durable append batch. Node's one-shot zstd APIs
 * decode exactly one frame, so frame boundaries have to be located
 * structurally before anything can be decompressed.
 *
 * Frame layout is taken from RFC 8878 §3: magic, frame header, a block
 * sequence ending with `last_block = 1`, then an optional 4-byte content
 * checksum. Skippable frames are accepted and passed over.
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f
const BLOCK_HEADER_BYTES = 3

/** Byte range occupied by one complete zstd frame: `start` inclusive, `end` exclusive. */
export interface FrameRange {
  start: number
  end: number
}

/** Result of a structural scan over a concatenated zstd stream. */
export interface FrameScan {
  /** Complete frames, in file order. */
  frames: FrameRange[]
  /** Start of a trailing incomplete frame, when the file ends mid-frame. */
  tornStart?: number
}

/** Bytes of a zstd dictionary id for each `Dictionary_ID_flag` value. */
const DICTIONARY_ID_BYTES = [0, 1, 2, 4]
/** Bytes of `Frame_Content_Size` for each non-zero `Frame_Content_Size_flag`. */
const CONTENT_SIZE_BYTES = [0, 2, 4, 8]

/**
 * Locate every complete frame without decompressing any block.
 * @param buffer - bytes currently present in the artifact.
 * @returns complete frame ranges, plus the start of a torn trailing frame.
 */
export function scanFrames(buffer: Buffer): FrameScan {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    const magic = buffer.readUInt32LE(offset)

    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      if (buffer.length - offset < 8) return { frames, tornStart: start }
      const end = offset + 8 + buffer.readUInt32LE(offset + 4)
      if (end > buffer.length) return { frames, tornStart: start }
      frames.push({ start, end })
      offset = end
      continue
    }

    if (magic !== ZSTD_MAGIC) {
      throw new Error(`not a zstd frame at byte ${offset} (magic 0x${magic.toString(16)})`)
    }
    const end = findFrameEnd(buffer, offset)
    if (end === undefined) return { frames, tornStart: start }
    frames.push({ start, end })
    offset = end
  }
  return { frames }
}

/**
 * Walk one frame's headers and block sequence to find where it ends.
 * @param buffer - bytes currently present in the artifact.
 * @param start - offset of the frame's magic number.
 * @returns exclusive end offset, or `undefined` when the frame is truncated.
 */
function findFrameEnd(buffer: Buffer, start: number): number | undefined {
  let p = start + 4
  if (p >= buffer.length) return undefined
  const descriptor = buffer[p++]!
  if (((descriptor >> 3) & 1) !== 0) throw new Error('reserved frame header bit is set')

  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictionaryIdFlag = descriptor & 3

  if (singleSegment === 0) p += 1
  p += DICTIONARY_ID_BYTES[dictionaryIdFlag]!
  p += contentSizeFlag === 0
    ? (singleSegment === 1 ? 1 : 0)
    : CONTENT_SIZE_BYTES[contentSizeFlag]!
  if (p > buffer.length) return undefined

  for (;;) {
    if (p + BLOCK_HEADER_BYTES > buffer.length) return undefined
    const header = buffer[p]! | (buffer[p + 1]! << 8) | (buffer[p + 2]! << 16)
    p += BLOCK_HEADER_BYTES
    const lastBlock = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >> 3
    if (blockType === 3) throw new Error('reserved block type')
    // A raw or compressed block stores `block_size` bytes; an RLE block stores one byte.
    p += blockType === 1 ? 1 : blockSize
    if (p > buffer.length) return undefined
    if (lastBlock === 1) break
  }

  if (hasChecksum === 1) p += 4
  return p > buffer.length ? undefined : p
}

/**
 * Decompress one frame previously located by {@link scanFrames}.
 * @param buffer - bytes currently present in the artifact.
 * @param range - frame range from {@link scanFrames}.
 * @returns the frame's decompressed bytes.
 */
export function decompressFrame(buffer: Buffer, range: FrameRange): Buffer {
  return zstdDecompressSync(buffer.subarray(range.start, range.end))
}

/**
 * Decompress every complete frame and concatenate the results.
 * @param buffer - bytes currently present in the artifact.
 * @returns decompressed text, plus the structural scan that produced it.
 */
export function readFrames(buffer: Buffer): { text: string; scan: FrameScan } {
  const scan = scanFrames(buffer)
  const parts = scan.frames.map((range) => decompressFrame(buffer, range))
  return { text: Buffer.concat(parts).toString('utf8'), scan }
}

/**
 * Compress one batch into a frame carrying a content checksum, matching how DSH
 * writes durable append batches.
 * @param text - the batch text, normally one or more JSONL records.
 * @returns the encoded frame bytes.
 */
export function compressFrame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}
