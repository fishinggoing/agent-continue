/**
 * Field-level mapping between the Codex rollout format and DSH session format v4.
 *
 * Each converter returns the produced session together with an account of every
 * input record it could not carry, because a migration that silently drops
 * content is worse than one that refuses.
 */
export {
  convertCodexToDsh,
  type ConversionResult as CodexToDshResult,
  type ConvertOptions as CodexToDshOptions,
  type MappingTally,
} from './codex-to-dsh.ts'

export {
  convertDshToCodex,
  type ConversionResult as DshToCodexResult,
  type ConvertOptions as DshToCodexOptions,
} from './dsh-to-codex.ts'
