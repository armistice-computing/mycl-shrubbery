import { describe, it, expect } from 'vitest'
import { atlasSnapshotQuery, decodeAtlasSnapshot, atlasExcerptQuery, decodeSavedAtlas, decodeSavedAtlasView, atlasTerm } from '../src/cell/wire-atlas-data.js'
import { updateAtlas } from '@shrubbery/components'

const doc = 'urn:mnemosyne:local:document:'
describe('atlas read boundary', () => {
  it('retains stored block ids verbatim including the block- prefix', () => {
    const data = decodeAtlasSnapshot('g', { rows: [
      { kind: '"document"', id: `<${doc}a>`, title: '"A \\"quote\\""'.replaceAll('\\\\', '\\') },
      { kind: '"wire"', id: '<urn:w>', source: `<${doc}a>`, target: `<${doc}b>`, sourceBlock: `<${doc}a#block-block-123>`, predicate: '<urn:qualifies>', bidirectional: '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>' },
    ] })
    expect(data.wires[0].source.blockId).toBe('block-123')
    expect(data.wires[0].bidirectional).toBe(true)
    expect(atlasExcerptQuery('g', 'a', 'block-123')).toContain('#block-block-123>')
  })
  it('rejects partial results instead of replacing the map with a misleading subset', () => {
    expect(() => decodeAtlasSnapshot('g', { rows: [], warnings: ['truncated'] })).toThrow('incomplete')
    expect(() => decodeAtlasSnapshot('g', {})).toThrow('no rows')
  })
  it('excludes cross-graph wires explicitly and refuses mismatched block ownership', () => {
    const row = { kind: '"wire"', id: '<w>', source: `<${doc}a>`, target: `<${doc}b>` }
    expect(decodeAtlasSnapshot('g', { rows: [{ ...row, targetGraph: '"other"' }] }).omittedExternalWires).toBe(1)
    expect(() => decodeAtlasSnapshot('g', { rows: [{ ...row, sourceBlock: `<${doc}b#block-x>` }] })).toThrow('belong')
  })
  it('hides PDF annotation companions and every wire with a companion endpoint', () => {
    const rows = [
      { kind: '"document"', id: `<${doc}a>`, title: '"A"' },
      { kind: '"document"', id: `<${doc}pdf-ann-a>`, title: '"PDF annotations — A.pdf"' },
      { kind: '"wire"', id: '<w1>', source: `<${doc}a>`, target: `<${doc}pdf-ann-a>`, predicate: '<urn:annotates>' },
      { kind: '"wire"', id: '<w2>', source: `<${doc}pdf-ann-a>`, target: `<${doc}a>`, predicate: '<urn:annotates>' },
      { kind: '"wire"', id: '<w3>', source: `<${doc}a>`, target: `<${doc}b>`, predicate: '<urn:supports>' },
    ]
    const snapshot = decodeAtlasSnapshot('g', { rows })
    expect(snapshot.documents.map(document => document.id)).toEqual(['a'])
    expect(snapshot.wires.map(wire => wire.id)).toEqual(['w3'])
    const state = updateAtlas(null, snapshot)
    const restored = decodeSavedAtlas(JSON.stringify({ version: 1, graphId: 'g', state }), 'g')
    expect(restored?.snapshot.documents.map(document => document.id)).toEqual(['a'])
    expect(restored?.snapshot.wires.map(wire => wire.id)).toEqual(['w3'])
  })
  it('rejects interpolated query syntax', () => {
    expect(() => atlasSnapshotQuery('g> } UNION {')).toThrow('Unsafe')
    expect(() => atlasExcerptQuery('g', 'a', 'x>')).toThrow('Unsafe')
  })
  it('decodes escaped RDF literal strings', () => {
    expect(atlasTerm('"A \\"quote\\""'.replaceAll('\\\\', '\\'))).toBe('A "quote"')
  })
  it('restores only valid graph-matching disposable view state', () => {
    const state = updateAtlas(null, { documents: [], wires: [] })
    expect(decodeSavedAtlas(JSON.stringify({ version: 1, graphId: 'g', state }), 'g')).toEqual(state)
    expect(decodeSavedAtlas(JSON.stringify({ version: 1, graphId: 'other', state }), 'g')).toBeNull()
    expect(decodeSavedAtlas('{broken', 'g')).toBeNull()
    expect(decodeSavedAtlas(JSON.stringify({ version: 1, graphId: 'g', state: { ...state, positions: { x: { x: 'bad', y: 2 } } } }), 'g')).toBeNull()
  })
  it('validates saved camera bounds without trusting arbitrary stored objects', () => {
    const view = { zoom: .5, left: 120, top: 80 }
    expect(decodeSavedAtlasView(JSON.stringify({ version: 1, graphId: 'g', view }), 'g')).toEqual(view)
    expect(decodeSavedAtlasView(JSON.stringify({ version: 1, graphId: 'g', view: { ...view, zoom: 100 } }), 'g')).toBeUndefined()
    expect(decodeSavedAtlasView(JSON.stringify({ version: 1, graphId: 'g', view }), 'other')).toBeUndefined()
  })
})
