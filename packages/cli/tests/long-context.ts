export const LONG_CONTEXT_MEMO = 'context-only-long-953'

export function longContextTurns(): string[] {
  const pressure = (batch: number) => [
    'Archival sample data follows. It does not change any ledger requirements and does not request implementation.',
    'Keep the completed first-stage code untouched. Retain all task decisions and corrections; do not preserve the sample rows in a future summary.',
    ...Array.from({ length: 180 }, (_, index) => `ARCHIVE ${batch}-${String(index).padStart(4, '0')}: synthetic account sample ${batch * 1000 + index}; historical opening=${index * 7}; historical closing=${index * 11}; reconciliation=archived; no action required.`),
    'Acknowledge briefly without tools, files, network or subagents. Stage two remains unfinished.',
  ].join('\n')
  return [
    'Requirement correction: successful transfer and history memo must now be context-only-long-842, replacing context-only-731. All other requirements remain binding. Do not implement anything or write this correction into a file; just acknowledge.',
    pressure(1), pressure(2), pressure(3),
    `Final requirement correction: memo must be ${LONG_CONTEXT_MEMO}, overriding BOTH context-only-731 and context-only-long-842 everywhere in successful transfer results and history. This is the final decision. Keep all other ledger requirements, existing progress and unfinished stage two. Do not edit files or create a handoff document; just acknowledge.`,
    pressure(4), pressure(5),
  ]
}
