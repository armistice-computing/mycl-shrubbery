import { describe, it, expect } from 'vitest'
import { atlasConnections, atlasUnplaced, atlasNeighborhood, separateAtlasCards, ATLAS_CARD_WIDTH, ATLAS_CARD_HEIGHT, openAtlas, rearrangeAtlas, updateAtlas, type AtlasSnapshot, type AtlasWire } from '../wire-atlas-model.js'

const documents = ['a', 'b'].map(id => ({ id, title: id }))
const wire: AtlasWire = { id: 'w', source: { documentId: 'a', blockId: 'one' }, target: { documentId: 'b' }, predicate: 'contradicts' }
const snapshot: AtlasSnapshot = { documents, wires: [wire] }

describe('wire atlas lifecycle', () => {
  it('separates dense coincident card rectangles deterministically', () => {
    const points = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [String(i), { x: 0, y: 0 }]))
    const result = separateAtlasCards(points)
    expect(result).toEqual(separateAtlasCards(points))
    const placed = Object.values(result)
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      expect(Math.abs(placed[i].x - placed[j].x) >= ATLAS_CARD_WIDTH || Math.abs(placed[i].y - placed[j].y) >= ATLAS_CARD_HEIGHT).toBe(true)
    }
  })
  it('places new cards without moving pinned landmarks', () => {
    const result = separateAtlasCards({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }, new Set(['a']))
    expect(result.a).toEqual({ x: 0, y: 0 })
    expect(result.b).not.toEqual(result.a)
  })
  it('finds the minimum two-hop neighborhood in either direction', () => {
    const docs = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, title: id }))
    const wires = [['b', 'a'], ['b', 'c'], ['c', 'd']].map(([a, b], i) => ({ ...wire, id: String(i), source: { documentId: a }, target: { documentId: b } }))
    expect([...atlasNeighborhood({ documents: docs, wires }, 'a')]).toEqual([['a', 0], ['b', 1], ['c', 2]])
  })
  it('retains exact endpoints, directions and predicates inside adjacency bundles', () => {
    const reverse = { ...wire, id: 'reverse', source: wire.target, target: wire.source, predicate: 'supports' }
    expect(atlasConnections({ documents, wires: [wire, reverse] })).toEqual([[wire, reverse]])
  })
  it('keeps unwired and self-wired documents in the margin', () => {
    const s = { documents, wires: [{ ...wire, target: wire.source }] }
    expect(atlasUnplaced(s)).toEqual(documents)
    expect(Object.keys(updateAtlas(null, s).positions)).toEqual([])
  })
  it('never invents document nodes for dangling endpoints', () => {
    expect(atlasConnections({ documents: [documents[0]], wires: [wire] })).toEqual([])
  })
  it('does not recount unchanged snapshots or title changes', () => {
    const state = updateAtlas(null, snapshot)
    const next = updateAtlas(state, { ...snapshot, documents: documents.map(d => ({ ...d, title: 'new' })) })
    expect(next.addedDocuments).toBe(0)
    expect(next.changedWires).toBe(0)
    expect(next.positions).toEqual(state.positions)
  })
  it('schedules at five documents, without moving existing nodes until opening', () => {
    const state = updateAtlas(null, snapshot)
    const next = updateAtlas(state, { ...snapshot, documents: [...documents, ...Array.from({ length: 5 }, (_, i) => ({ id: `new-${i}`, title: 'New' }))] })
    expect(next.pending).toBe(true)
    expect(next.positions).toEqual(state.positions)
    const reopened = openAtlas(next)
    expect(reopened.pending).toBe(false)
    expect(reopened.addedDocuments).toBe(0)
    expect(reopened.changedWires).toBe(0)
  })
  it('counts additions, edits and deletions once each and triggers at ten', () => {
    let state = updateAtlas(null, snapshot)
    for (let i = 0; i < 9; i++) state = updateAtlas(state, { documents, wires: [{ ...wire, predicate: `p${i}` }] })
    expect(state.pending).toBe(false)
    state = updateAtlas(state, { documents, wires: [] })
    expect(state.changedWires).toBe(10)
    expect(state.pending).toBe(true)
    expect(rearrangeAtlas(state).changedWires).toBe(0)
  })
  it('seeds new connected nodes immediately while keeping existing positions', () => {
    const state = updateAtlas(null, snapshot)
    const next = updateAtlas(state, { documents: [...documents, { id: 'c', title: 'C' }], wires: [wire, { ...wire, id: 'new', target: { documentId: 'c' } }] })
    expect(next.positions.a).toEqual(state.positions.a)
    expect(next.positions.b).toEqual(state.positions.b)
    expect(Number.isFinite(next.positions.c.x)).toBe(true)
  })
  it('copies input so caller mutations cannot hide changes', () => {
    const input = structuredClone(snapshot)
    const state = updateAtlas(null, input)
    input.wires[0].source.blockId = 'changed'
    expect(updateAtlas(state, input).changedWires).toBe(1)
  })
  it('treats contradictory relations as proximity, not repulsion', () => {
    expect(updateAtlas(null, snapshot).positions).toEqual(updateAtlas(null, { ...snapshot, wires: [{ ...wire, predicate: 'supports' }] }).positions)
  })
  it('rejects duplicate IDs instead of miscounting changes', () => {
    expect(() => updateAtlas(null, { documents, wires: [wire, wire] })).toThrow('unique')
  })
})
