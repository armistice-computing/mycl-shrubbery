import { describe, expect, it } from 'vitest'
import { rowsToWireBundle } from '../editor-services/index.js'

const doc = (id: string) => `<urn:mnemosyne:local:document:${id}>`
const pred = (name: string) => `<http://mnemosyne.ai/vocab#${name}>`
const lit = (value: string) => `"${value}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`

describe('wire bundle families', () => {
  it('marks dream and record wires and dates a dream wire from its creation when no expiry is projected', () => {
    const bundle = rowsToWireBundle('g', 'source', [
      { wire: '<w-dream>', sourceDoc: doc('g-dream-journal'), targetDoc: doc('source'), predicate: pred('dreamtOf'), wireCreatedAt: lit('2026-10-19T08:04:29.000Z') },
      { wire: '<w-dream-2>', sourceDoc: doc('g-dream-journal'), targetDoc: doc('source'), predicate: pred('dreamtOf'),
        wireCreatedAt: lit('2026-10-19T08:04:29.000Z'), wireExpiresAt: lit('2026-10-20T01:00:00Z') },
      { wire: '<w-cite>', sourceDoc: doc('other'), targetDoc: doc('source'), predicate: pred('cites') },
      { wire: '<w-plain>', sourceDoc: doc('other'), targetDoc: doc('source'), predicate: pred('supports') },
    ])
    const byId = new Map(bundle.incomingWires.map(wire => [wire.id, wire]))
    expect(byId.get('w-dream')).toMatchObject({ family: 'dream', predicateLabel: 'dreamt of', expiresAt: Date.parse('2026-10-20T08:04:29.000Z') })
    expect(byId.get('w-dream-2')?.expiresAt).toBe(Date.parse('2026-10-20T01:00:00.000Z'))
    expect(byId.get('w-cite')).toMatchObject({ family: 'record', predicateLabel: 'cites' })
    expect(byId.get('w-cite')?.expiresAt).toBeUndefined()
    expect(byId.get('w-plain')?.family).toBeUndefined()
  })

  it('lists a file link as an outgoing wire to its file, even with no chip left', () => {
    const bundle = rowsToWireBundle('g', 'source', [
      {
        wire: '<urn:mnemosyne:local:graph:g:wire:w-file>',
        sourceDoc: doc('source'),
        sourceBlock: '<urn:mnemosyne:local:document:source#block-b7>',
        targetArtifact: '<urn:mnemosyne:local:graph:g:artifact:artifact-notes>',
        targetTitle: '"notes.md"',
        predicate: pred('supports'),
      },
    ])
    expect(bundle.incomingWires).toEqual([])
    expect(bundle.outgoingWires).toEqual([expect.objectContaining({
      id: 'w-file',
      otherDocumentId: '',
      otherArtifactId: 'artifact-notes',
      otherTitle: 'notes.md',
      localBlockId: 'b7',
      predicateLabel: 'supports',
    })])
    // The gutter counts the block it comes from.
    expect(bundle.wiredBlockIds).toEqual(['b7'])
  })
})
