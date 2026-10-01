import { isDeepStrictEqual } from 'node:util'
import { SURFACE_EVENT_TYPES, type SessionEvent } from './format.ts'

export function currentSurface(events: readonly SessionEvent[]): SessionEvent[] {
  const nodes: SessionEvent[] = []
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) throw new Error('Refusing migration: noncontiguous DSH surface log')
    if (event.type === 'image/offload') {
      throw new Error('Refusing migration: image/offload requires its owning message projection interpreter')
    }
    const operation = event.surfaceOp
    if (operation === undefined) continue
    if (!SURFACE_EVENT_TYPES.has(event.type)) {
      throw new Error(`Refusing migration: unsupported surface projection ${event.type}`)
    }
    const references = event.sourceEventSeqs ?? []
    if (references.some(seq => !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq)
      || new Set(references).size !== references.length) {
      throw new Error('Refusing migration: invalid DSH surface provenance')
    }
    if (operation === 'append') {
      nodes.push(event)
      continue
    }
    const first = nodes.findIndex(node => node.seq === operation.startSeq)
    const last = nodes.findIndex(node => node.seq === operation.endSeq)
    if (operation.op !== 'replace' || first < 0 || last < first) {
      throw new Error('Refusing migration: replacement endpoints are not in the current DSH surface')
    }
    const shadowed = nodes.slice(first, last + 1)
    if (shadowed.some(node => !references.includes(node.seq))) {
      throw new Error('Refusing migration: DSH surface replacement omits shadowed provenance')
    }
    if (first === 0 && nodes[0]!.type === 'system/message'
      && (event.type !== 'system/message' || shadowed.length !== 1)) {
      throw new Error('Refusing migration: replacement overwrites the protected DSH system head')
    }
    if (event.type === 'tool/result') {
      const original = shadowed[0]!
      const withoutContent = (value: unknown) => {
        const data = value as Record<string, unknown>
        return { ...data, message: { ...data.message as Record<string, unknown>, content: null } }
      }
      if (shadowed.length !== 1 || original.type !== 'tool/result'
        || !isDeepStrictEqual(withoutContent(original.data), withoutContent(event.data))) {
        throw new Error('Refusing migration: DSH tool-result replacement may change only content')
      }
    }
    nodes.splice(first, last - first + 1, event)
  }
  return nodes
}
