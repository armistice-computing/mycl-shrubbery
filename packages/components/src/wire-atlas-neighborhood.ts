import { atlasNeighborhood, separateAtlasCards, type AtlasState, type AtlasPoint } from './wire-atlas-model.js'

/** Temporary reading geography. Never mutate or replace the saved atlas. */
export function compactNeighborhood(atlas: AtlasState, centerId: string): AtlasState {
  const depths = atlasNeighborhood(atlas.snapshot, centerId)
  if (!atlas.snapshot.documents.some(d => d.id === centerId)) throw new Error('Neighborhood document is missing')
  const snapshot = {
    documents: atlas.snapshot.documents.filter(d => depths.has(d.id)),
    wires: atlas.snapshot.wires.filter(w => depths.has(w.source.documentId) && depths.has(w.target.documentId)),
  }
  const origin = atlas.positions[centerId] ?? { x: 0, y: 0 }
  const positions: Record<string, AtlasPoint> = Object.create(null)
  positions[centerId] = { x: 0, y: 0 }
  for (const document of snapshot.documents) {
    if (document.id === centerId) continue
    const p = atlas.positions[document.id] ?? origin
    const dx = p.x - origin.x, dy = p.y - origin.y
    const distance = Math.hypot(dx, dy)
    // Monotone compression retains the initial bearing without preserving vast distances.
    const radius = 300 * Math.log1p(distance / 300)
    positions[document.id] = distance ? { x: dx * radius / distance, y: dy * radius / distance } : { x: 0, y: 0 }
  }
  return { snapshot, positions: separateAtlasCards(positions, new Set([centerId])), addedDocuments: 0, changedWires: 0, pending: false }
}

/** Each physical wire leaving the visible subgraph counts once at its visible end. */
export function onwardWireCounts(atlas: AtlasState, local: AtlasState): Map<string, number> {
  const present = new Set(atlas.snapshot.documents.map(d => d.id))
  const visible = new Set(local.snapshot.documents.map(d => d.id))
  const counts = new Map<string, number>()
  for (const wire of atlas.snapshot.wires) {
    const a = wire.source.documentId, b = wire.target.documentId
    if (!present.has(a) || !present.has(b) || visible.has(a) === visible.has(b)) continue
    const endpoint = visible.has(a) ? a : b
    counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1)
  }
  return counts
}
