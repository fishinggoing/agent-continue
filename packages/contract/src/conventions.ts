/**
 * Cross-harness field conventions.
 *
 * These are the field-level agreements between the two adapters, registered in
 * `docs/HANDOFF.md` §9.2.1. They belong in code as well as prose so both
 * converters reference one definition instead of repeating a string literal.
 */

/**
 * Marks a tool result whose outcome was never durably recorded.
 *
 * DSH's own recovery uses this code (`packages/core/session/src/repair.ts`,
 * `TOOL_OUTCOME_UNKNOWN`) when it finds a durable `tool/call` with no result. A
 * migration must keep the distinction: an unknown outcome is not a known
 * failure, and it is certainly not a success.
 */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * Payload field carrying the recovery marker on Codex tool output records.
 *
 * Written at the top level of `response_item/function_call_output.payload` and
 * `response_item/custom_tool_call_output.payload`. Only an explicit marker means
 * unknown; consumers must not infer it from the result text.
 */
export const RECOVERY_FIELD = 'recovery'

export interface PendingOutcome {
  callId: string
  name: string
  state: 'unknown'
}

export function pendingOutcomes(value: unknown): PendingOutcome[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const metadata = value as Record<string, unknown>
  if (metadata.recovery !== TOOL_OUTCOME_UNKNOWN) {
    if (metadata.kind === 'agent-continue-unknown-outcomes') {
      throw new Error('Refusing migration: unknown-outcome notice lacks a machine-readable recovery marker; reimport its original source')
    }
    return []
  }
  const operations = metadata.pendingOperations ?? metadata.pending_operations
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('Refusing migration: unknown-outcome context is missing machine-readable pending operations')
  }
  return operations.map(operation => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      throw new Error('Refusing migration: malformed pending operation')
    }
    const entry = operation as Record<string, unknown>
    if (typeof entry.callId !== 'string' || entry.callId.length === 0
      || typeof entry.name !== 'string' || entry.name.length === 0 || entry.state !== 'unknown') {
      throw new Error('Refusing migration: malformed pending operation identity or state')
    }
    return { callId: entry.callId, name: entry.name, state: 'unknown' }
  })
}

/**
 * The message body DSH itself writes for an interrupted-but-started call.
 *
 * Copied verbatim from `packages/core/session/src/repair.ts` (`CLOSER_TEXT.interrupted.started`).
 * When an import has to close a turn that still holds an unresolved call, it
 * resolves that call exactly the way DSH's own recovery would rather than
 * inventing different wording — the record has to read as an unknown outcome,
 * not as a result this migration made up.
 */
export const TOOL_OUTCOME_UNKNOWN_TEXT = 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
