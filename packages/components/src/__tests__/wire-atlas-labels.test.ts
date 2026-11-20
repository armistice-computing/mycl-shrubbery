import { describe, expect, it } from 'vitest'
import { atlasPredicateLabels } from '../wire-atlas-labels.js'
import type { AtlasWire } from '../wire-atlas-model.js'

const wire: AtlasWire = { id: 'one', source: { documentId: 'a', blockId: 'p' }, target: { documentId: 'b' }, predicate: 'http://mnemosyne.ai/vocab#flowsInto' }
describe('atlas predicate labels', () => {
  it('keeps direction relative to the readable baseline', () => {
    expect(atlasPredicateLabels([wire], 'a')).toEqual(['flows into →'])
    expect(atlasPredicateLabels([wire], 'b')).toEqual(['← flows into'])
  })
  it('counts only the same predicate and direction together', () => {
    const reverse = { ...wire, id: 'reverse', source: wire.target, target: wire.source }
    expect(atlasPredicateLabels([wire, { ...wire, id: 'two' }, reverse], 'a').sort()).toEqual(['flows into ×2 →', '← flows into'].sort())
  })
  it('keeps distinct predicates and bidirectional wires visible', () => {
    expect(atlasPredicateLabels([wire, { ...wire, predicate: 'supports', bidirectional: true }], 'a')).toEqual(['flows into →', 'supports ↔'])
  })
})
