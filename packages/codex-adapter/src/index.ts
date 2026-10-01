/**
 * Public surface of the Codex session adapter.
 *
 * Reading and writing `rollout-*.jsonl` logs and the `state_5.sqlite` registry
 * row that makes a rollout listable and resumable.
 */
export {
  countByType,
  parseRollout,
  select,
  sessionMeta,
  summarizeKinds,
  toolOutputText,
  turnWindows,
  type CodexContentBlock,
  type JsonObject,
  type ParsedRollout,
  type RolloutParseFailure,
  type RolloutRecord,
  type SessionMetaPayload,
  type TurnWindow,
} from './rollout.ts'

export {
  STATE_STORE_FILENAME,
  SESSIONS_DIRNAME,
  THREAD_HISTORY_FILENAME,
  codexHome,
  findRollouts,
  parseRolloutFilename,
  rolloutFilename,
  rolloutPath,
  sessionsRoot,
  type FindRolloutsOptions,
  type RolloutFilenameParts,
  type RolloutFile,
} from './paths.ts'

export {
  encodeRollout,
  extendedLengthPath,
  registerThread,
  seedProjectionCursor,
  writeRollout,
  type RolloutDraft,
  type ThreadRegistration,
  type WriteRolloutOptions,
  type WrittenRollout,
} from './write.ts'
