import type { AtlasWire } from './wire-atlas-model.js'

/** Labels follow the readable line orientation, not whichever wire arrived first. */
export function atlasPredicateLabels(wires: readonly AtlasWire[], readingFrom: string): string[] {
  const groups = new Map<string, { predicate: string; direction: string; count: number }>()
  for (const wire of wires) {
    const direction = wire.bidirectional ? 'both' : wire.source.documentId === readingFrom ? 'forward' : 'backward'
    const key = JSON.stringify([wire.predicate, direction])
    const group = groups.get(key) ?? { predicate: wire.predicate, direction, count: 0 }
    group.count++; groups.set(key, group)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => {
    const label = (group.predicate.split(/[\/#:]/).pop() || group.predicate).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    const count = group.count > 1 ? ` ×${group.count}` : ''
    return group.direction === 'backward' ? `← ${label}${count}` : `${label}${count} ${group.direction === 'both' ? '↔' : '→'}`
  })
}
