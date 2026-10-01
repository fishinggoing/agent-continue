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
