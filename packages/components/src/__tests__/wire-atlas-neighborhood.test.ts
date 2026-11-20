import { describe, expect, it } from 'vitest'
import { compactNeighborhood, onwardWireCounts } from '../wire-atlas-neighborhood.js'
import { ATLAS_CARD_WIDTH, ATLAS_CARD_HEIGHT, type AtlasState } from '../wire-atlas-model.js'

function atlas(): AtlasState {
  return {
    snapshot: {
      documents: ['a', 'b', 'c', 'd', 'alone'].map(id => ({ id, title: id })),
      wires: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'c']].map(([a, b], i) => ({ id: `w${i}`, source: { documentId: a, blockId: `p${i}` }, target: { documentId: b }, predicate: 'supports' })),
    },
    positions: { a: { x: 1000, y: 1000 }, b: { x: 6000, y: 1000 }, c: { x: 6000, y: 6000 }, d: { x: 6000, y: 10000 } },
    addedDocuments: 2, changedWires: 4, pending: false,
  }
}
describe('compact atlas neighborhoods', () => {
  it('retains two hops and exact wires without changing atlas positions or counters', () => {
    const source = atlas(), before = structuredClone(source)
    const local = compactNeighborhood(source, 'a')
    expect(local.snapshot.documents.map(d => d.id)).toEqual(['a', 'b', 'c'])
    expect(local.snapshot.wires).toEqual(source.snapshot.wires.slice(0, 2))
    expect(source).toEqual(before)
    expect(local.positions.a).toEqual({ x: 0, y: 0 })
    expect(local.positions.b.x).toBeGreaterThan(0)
    expect(local.positions.b.x).toBeLessThan(5000)
    expect(local.positions.b.y).toBe(0)
    expect(local.positions.c.x).toBeGreaterThan(0)
    expect(local.positions.c.y).toBeGreaterThan(0)
  })
  it('counts each outward wire at the visible endpoint, not internal wires', () => {
    const source = atlas(), local = compactNeighborhood(source, 'a')
    expect([...onwardWireCounts(source, local)]).toEqual([['c', 2]])
    expect(onwardWireCounts(source, compactNeighborhood(source, 'b')).size).toBe(0)
  })
  it('shows an unwired center, rejects an absent center', () => {
    expect(compactNeighborhood(atlas(), 'alone').snapshot.documents).toEqual([{ id: 'alone', title: 'alone' }])
    expect(() => compactNeighborhood(atlas(), 'missing')).toThrow('missing')
  })
  it('separates compressed cards while keeping the center pinned', () => {
    const source = atlas()
    source.positions.b = { x: 1000, y: 1000 }
    source.positions.c = { x: 1000, y: 1000 }
    const local = compactNeighborhood(source, 'a')
    const points = Object.values(local.positions)
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      expect(Math.abs(points[i].x - points[j].x) >= ATLAS_CARD_WIDTH || Math.abs(points[i].y - points[j].y) >= ATLAS_CARD_HEIGHT).toBe(true)
    }
    expect(local.positions.a).toEqual({ x: 0, y: 0 })
  })
})
