import { describe, expect, it } from 'vitest'
import { ATLAS_FILE_NODE_PREFIX, atlasSnapshotQuery, decodeAtlasSnapshot } from '../wire-atlas-data.js'

describe('atlas file links', () => {
  it('asks for file links beside document wires', () => {
    expect(atlasSnapshotQuery('g')).toContain('mnemo:targetArtifact ?target')
  })

  it('draws a file link to one labeled stub node per file, never a missing document', () => {
    const doc = (id: string) => `<urn:mnemosyne:local:document:${id}>`
    const snapshot = decodeAtlasSnapshot('g', {
      rows: [
        { kind: '"document"', id: doc('notes'), title: '"Notes"' },
        { kind: '"filewire"', id: '"w1"', source: doc('notes'), target: '<urn:mnemosyne:local:graph:g:artifact:artifact-a>', title: '"draft.md"', predicate: '"supports"' },
        { kind: '"filewire"', id: '"w2"', source: doc('notes'), sourceBlock: '<urn:mnemosyne:local:document:notes#block-b1>', target: '<urn:mnemosyne:local:graph:g:artifact:artifact-a>', title: '"draft.md"' },
      ],
    })
    const fileId = `${ATLAS_FILE_NODE_PREFIX}artifact-a`
    expect(snapshot.documents).toEqual([{ id: 'notes', title: 'Notes' }, { id: fileId, title: 'draft.md (file)' }])
    expect(snapshot.wires.map(wire => [wire.id, wire.source, wire.target.documentId])).toEqual([
      ['w1', { documentId: 'notes' }, fileId],
      ['w2', { documentId: 'notes', blockId: 'b1' }, fileId],
    ])
  })
})
