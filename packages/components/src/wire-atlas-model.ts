/** Pure atlas state. Hosts own graph-scoped persistence and supply complete snapshots. */
export interface AtlasDocument { id: string; title: string }
export interface AtlasEndpoint { documentId: string; blockId?: string }
export interface AtlasWire {
  id: string
  source: AtlasEndpoint
  target: AtlasEndpoint
  predicate: string
  bidirectional?: boolean
}
export interface AtlasSnapshot {
  documents: readonly AtlasDocument[]
  wires: readonly AtlasWire[]
}
export interface AtlasPoint { x: number; y: number }
export const ATLAS_CARD_WIDTH = 200
export const ATLAS_CARD_HEIGHT = 96
const CARD_GAP = 8

/** Minimum undirected hop distance: the atlas shows engagement, not agreement. */
export function atlasNeighborhood(snapshot: AtlasSnapshot, selected: string | null): Map<string, number> {
  const distances = new Map<string, number>()
  if (!selected) return distances
  const neighbours = new Map<string, Set<string>>()
  for (const bundle of atlasConnections(snapshot)) for (const wire of bundle) {
    for (const [a, b] of [[wire.source.documentId, wire.target.documentId], [wire.target.documentId, wire.source.documentId]]) {
      const set = neighbours.get(a) ?? new Set<string>(); set.add(b); neighbours.set(a, set)
    }
  }
  distances.set(selected, 0)
  let frontier = [selected]
  for (let depth = 1; depth <= 2; depth++) {
    const next: string[] = []
    for (const id of frontier) for (const neighbour of neighbours.get(id) ?? []) {
      if (distances.has(neighbour)) continue
      distances.set(neighbour, depth); next.push(neighbour)
    }
    frontier = next
  }
  return distances
}

/** Place rectangles near their desired coordinates. Existing landmarks can be pinned. */
export function separateAtlasCards(input: Record<string, AtlasPoint>, pinned: ReadonlySet<string> = new Set()): Record<string, AtlasPoint> {
  const width = ATLAS_CARD_WIDTH + CARD_GAP, height = ATLAS_CARD_HEIGHT + CARD_GAP
  const result: Record<string, AtlasPoint> = Object.create(null)
  const cells = new Map<string, AtlasPoint[]>()
  const key = (x: number, y: number) => `${x},${y}`
  const put = (id: string, p: AtlasPoint) => {
    result[id] = { ...p }
    const k = key(Math.floor(p.x / width), Math.floor(p.y / height))
    const bucket = cells.get(k) ?? []; bucket.push(p); cells.set(k, bucket)
  }
  const free = (p: AtlasPoint) => {
    const cx = Math.floor(p.x / width), cy = Math.floor(p.y / height)
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      for (const q of cells.get(key(x, y)) ?? []) if (Math.abs(p.x - q.x) < width && Math.abs(p.y - q.y) < height) return false
    }
    return true
  }
  const ids = Object.keys(input).sort()
  for (const id of ids) if (pinned.has(id)) put(id, input[id])
  for (const id of ids) {
    if (pinned.has(id)) continue
    const origin = input[id]
    let candidate = origin
    for (let ring = 1; !free(candidate); ring++) {
      let nearest: AtlasPoint | null = null
      let distance = Infinity
      for (let x = -ring; x <= ring; x++) for (let y = -ring; y <= ring; y++) {
        if (Math.abs(x) !== ring && Math.abs(y) !== ring) continue
        const point = { x: origin.x + x * width / 2, y: origin.y + y * height / 2 }
        const d = (point.x - origin.x) ** 2 + (point.y - origin.y) ** 2
        if (d < distance && free(point)) { nearest = point; distance = d }
      }
      if (nearest) candidate = nearest
    }
    put(id, candidate)
  }
  return result
}
export interface AtlasState {
  snapshot: AtlasSnapshot
  positions: Record<string, AtlasPoint>
  addedDocuments: number
  changedWires: number
  pending: boolean
}

function fingerprint(w: AtlasWire): string {
  return JSON.stringify([w.source.documentId, w.source.blockId ?? null,
    w.target.documentId, w.target.blockId ?? null, w.predicate, !!w.bidirectional])
}

export function atlasSnapshotSignature(snapshot: AtlasSnapshot): string {
  return JSON.stringify([
    snapshot.documents.map(d => [d.id, d.title]).sort((a, b) => a[0].localeCompare(b[0])),
    snapshot.wires.map(w => [w.id, fingerprint(w)]).sort((a, b) => a[0].localeCompare(b[0])),
  ])
}

/** A bundle is adjacency, not an assertion that entire documents share a predicate. */
export function atlasConnections(snapshot: AtlasSnapshot): AtlasWire[][] {
  const ids = new Set(snapshot.documents.map(d => d.id))
  const pairs = new Map<string, AtlasWire[]>()
  for (const w of snapshot.wires) {
    if (!ids.has(w.source.documentId) || !ids.has(w.target.documentId)) continue
    const key = JSON.stringify([w.source.documentId, w.target.documentId].sort())
    const list = pairs.get(key) ?? []
    list.push(w)
    pairs.set(key, list)
  }
  return [...pairs.values()]
}

export function atlasUnplaced(snapshot: AtlasSnapshot): AtlasDocument[] {
  const linked = new Set(atlasConnections(snapshot).flatMap(ws => ws.flatMap(w =>
    w.source.documentId === w.target.documentId ? [] : [w.source.documentId, w.target.documentId])))
  return snapshot.documents.filter(d => !linked.has(d.id))
}

function copySnapshot(s: AtlasSnapshot): AtlasSnapshot {
  if (new Set(s.documents.map(d => d.id)).size !== s.documents.length ||
      new Set(s.wires.map(w => w.id)).size !== s.wires.length) {
    throw new Error('Atlas snapshots require unique document and wire IDs')
  }
  return { documents: s.documents.map(d => ({ ...d })),
    wires: s.wires.map(w => ({ ...w, source: { ...w.source }, target: { ...w.target } })) }
}

/** Existing landmarks never move here. New connected documents get provisional positions. */
function placeNew(snapshot: AtlasSnapshot, previous: Record<string, AtlasPoint>): Record<string, AtlasPoint> {
  const unplaced = new Set(atlasUnplaced(snapshot).map(d => d.id))
  const positions: Record<string, AtlasPoint> = Object.create(null)
  const documents = [...snapshot.documents].sort((a, b) => a.id.localeCompare(b.id))
  for (const d of documents) {
    if (!unplaced.has(d.id) && previous[d.id]) positions[d.id] = { ...previous[d.id] }
  }
  const neighbours = new Map<string, Set<string>>()
  for (const bundle of atlasConnections(snapshot)) for (const w of bundle) {
    for (const [a, b] of [[w.source.documentId, w.target.documentId], [w.target.documentId, w.source.documentId]]) {
      if (a === b) continue
      const set = neighbours.get(a) ?? new Set<string>(); set.add(b); neighbours.set(a, set)
    }
  }
  for (const [index, d] of documents.entries()) {
    if (unplaced.has(d.id) || positions[d.id]) continue
    const nearby = [...(neighbours.get(d.id) ?? [])].flatMap(id => positions[id] ? [positions[id]] : [])
    const angle = index * 2.399963229728653
    const radius = nearby.length ? 160 : 180 * Math.sqrt(index + 1)
    positions[d.id] = {
      x: nearby.reduce((sum, p) => sum + p.x, 0) / Math.max(1, nearby.length) + Math.cos(angle) * radius,
      y: nearby.reduce((sum, p) => sum + p.y, 0) / Math.max(1, nearby.length) + Math.sin(angle) * radius,
    }
  }
  return Object.keys(previous).length ? separateAtlasCards(positions, new Set(Object.keys(previous))) : positions
}

/** Bounded deterministic settling from the previous geography; no animation loop. */
export function rearrangeAtlas(state: AtlasState): AtlasState {
  const positions = placeNew(state.snapshot, state.positions)
  const ids = Object.keys(positions).sort()
  const links = atlasConnections(state.snapshot).filter(ws => ws[0].source.documentId !== ws[0].target.documentId)
  for (let step = 0; step < 60; step++) {
    const delta: Record<string, AtlasPoint> = Object.create(null)
    for (const id of ids) delta[id] = { x: 0, y: 0 }
    // Repulsion has a finite radius: only adjacent grid cells can contribute.
    const cells = new Map<string, string[]>()
    for (const id of ids) {
      const key = `${Math.floor(positions[id].x / 240)},${Math.floor(positions[id].y / 240)}`
      const bucket = cells.get(key) ?? []; bucket.push(id); cells.set(key, bucket)
    }
    for (const a of ids) {
      const cx = Math.floor(positions[a].x / 240), cy = Math.floor(positions[a].y / 240)
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
        for (const b of cells.get(`${x},${y}`) ?? []) {
          if (b <= a) continue
          const dx = positions[b].x - positions[a].x || 0.01
          const dy = positions[b].y - positions[a].y
          const distance = Math.max(1, Math.hypot(dx, dy))
          if (distance >= 240) continue
          const push = (240 - distance) * 0.035
          delta[a].x -= dx / distance * push; delta[a].y -= dy / distance * push
          delta[b].x += dx / distance * push; delta[b].y += dy / distance * push
        }
      }
    }
    for (const bundle of links) {
      const a = bundle[0].source.documentId, b = bundle[0].target.documentId
      const dx = positions[b].x - positions[a].x, dy = positions[b].y - positions[a].y
      const distance = Math.max(1, Math.hypot(dx, dy))
      // Contradiction is engagement too. Repeated wires strengthen attraction sublinearly.
      const pull = (distance - 230) * 0.008 * Math.min(3, 1 + Math.log2(bundle.length))
      delta[a].x += dx / distance * pull; delta[a].y += dy / distance * pull
      delta[b].x -= dx / distance * pull; delta[b].y -= dy / distance * pull
    }
    for (const id of ids) {
      positions[id].x += Math.max(-8, Math.min(8, delta[id].x))
      positions[id].y += Math.max(-8, Math.min(8, delta[id].y))
    }
  }
  return { ...state, positions: separateAtlasCards(positions), addedDocuments: 0, changedWires: 0, pending: false }
}

export function updateAtlas(state: AtlasState | null, input: AtlasSnapshot): AtlasState {
  const snapshot = copySnapshot(input)
  // Seeding is cheap. Settling belongs to the worker, never the render/update path.
  if (!state) return { snapshot, positions: placeNew(snapshot, {}), addedDocuments: 0, changedWires: 0, pending: false }
  const previousDocs = new Set(state.snapshot.documents.map(d => d.id))
  const before = new Map(state.snapshot.wires.map(w => [w.id, fingerprint(w)]))
  const after = new Map(snapshot.wires.map(w => [w.id, fingerprint(w)]))
  const addedDocuments = state.addedDocuments + snapshot.documents.filter(d => !previousDocs.has(d.id)).length
  const changedWires = state.changedWires + [...new Set([...before.keys(), ...after.keys()])]
    .filter(id => before.get(id) !== after.get(id)).length
  return { snapshot, positions: placeNew(snapshot, state.positions), addedDocuments, changedWires,
    pending: state.pending || addedDocuments >= 5 || changedWires >= 10 }
}

/** Call on a closed -> open transition, never on ordinary live updates. */
export function openAtlas(state: AtlasState): AtlasState {
  return state.pending ? rearrangeAtlas(state) : state
}
