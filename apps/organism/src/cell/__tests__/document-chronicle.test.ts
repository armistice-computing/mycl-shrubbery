import { describe, expect, it, vi } from 'vitest'
import {
  makeDocumentChronicleReader,
  parseChronicleActor,
  parseChronicleTimestamp,
  parseDocumentChronicle,
} from '../document-chronicle.js'

/**
 * A REAL `read_document` envelope, captured from a gardend built at 85461b2 by
 * `scripts/chronicle-surface-probe.mts` on 2026-09-06. Keeping the recorded
 * shape — including the cell's habit of returning both `created_by` and
 * `createdBy` for the same fact, and epoch-millis as STRINGS — is the point of
 * this fixture: a hand-written approximation would agree with the parser by
 * construction and could not catch the cell changing under us.
 */
const LIVE_ENVELOPE = {
  graph_id: 'chronicle-surface-1788742072897',
  document_id: 'doc-fc5b9c89a6b043d095ef51e93189ac30',
  title: 'A write',
  format: 'markdown',
  content: '#',
  offset: 0,
  nextOffset: 1,
  complete: false,
  totalChars: 39,
  maxChars: 1,
  updated_at: '1788742073362',
  updatedAt: '1788742073362',
  created_at: '1788742073176',
  createdAt: '1788742073176',
  revision: 1,
  created_by: 'human:owner',
  createdBy: 'human:owner',
  updated_by: 'human:owner',
  updatedBy: 'human:owner',
  chronicle: {
    createdBy: { kind: 'human', name: 'owner', via: null, label: 'human:owner' },
    updatedBy: { kind: 'human', name: 'owner', via: 'master-token', label: 'human:owner' },
    recentAuthors: [
      {
        actor: { kind: 'human', name: 'owner', via: 'master-token', label: 'human:owner' },
        label: 'human:owner',
        firstAt: '1788742073176',
        lastAt: '1788742073362',
        lastRevision: 1,
        writes: 2,
      },
    ],
    createdAtSource: null,
    lastForcedAt: null,
    lastForcedBy: null,
    forcedWrites: 0,
  },
  block_count: 2,
  rdfTripleCount: 25,
  schemaVersion: 1,
}

describe('parseDocumentChronicle', () => {
  it('reads a real read_document envelope', () => {
    const chronicle = parseDocumentChronicle(LIVE_ENVELOPE)
    expect(chronicle).not.toBeNull()
    expect(chronicle).toMatchObject({
      title: 'A write',
      createdAt: 1788742073176,
      updatedAt: 1788742073362,
      revision: 1,
      createdAtSource: null,
      lastForcedAt: null,
      lastForcedBy: null,
      forcedWrites: 0,
    })
    // The NESTED actor is preferred over the flat string, because only the
    // nested one carries `via` — the flat `updated_by` drops it.
    expect(chronicle?.updatedBy).toEqual({
      kind: 'human',
      name: 'owner',
      via: 'master-token',
      label: 'human:owner',
    })
    expect(chronicle?.recentAuthors).toEqual([
      {
        actor: { kind: 'human', name: 'owner', via: 'master-token', label: 'human:owner' },
        firstAt: 1788742073176,
        lastAt: 1788742073362,
        lastRevision: 1,
        writes: 2,
      },
    ])
  })

  it('returns null when the envelope carries no chronicle at all', () => {
    // What a hosted gateway sends: a document, no authorship record. This must
    // be distinguishable from a chronicle that answered "I do not know", which
    // is the next test.
    expect(
      parseDocumentChronicle({
        graph_id: 'g',
        document_id: 'd',
        title: 'Hosted document',
        content: 'body',
      }),
    ).toBeNull()
    expect(parseDocumentChronicle(null)).toBeNull()
    expect(parseDocumentChronicle('not an object')).toBeNull()
  })

  it('keeps the clocks and leaves the authors null on a pre-Chronicle document', () => {
    // Legacy records read back with revision and timestamps but no principals.
    // The cell never guesses an author; neither do we.
    const chronicle = parseDocumentChronicle({
      title: 'Older than the Chronicle',
      createdAt: '1756000000000',
      updatedAt: '1757000000000',
      revision: 12,
    })
    expect(chronicle).toMatchObject({
      createdAt: 1756000000000,
      updatedAt: 1757000000000,
      revision: 12,
      createdBy: null,
      updatedBy: null,
      forcedWrites: 0,
    })
    expect(chronicle?.recentAuthors).toEqual([])
  })

  it('carries the forced-write trail', () => {
    const chronicle = parseDocumentChronicle({
      revision: 9,
      chronicle: {
        createdBy: 'human:owner',
        updatedBy: { kind: 'agent', name: 'delta', via: 'client-token:tok-1', label: 'agent:delta' },
        recentAuthors: [],
        createdAtSource: 'import',
        lastForcedAt: '1788700000000',
        lastForcedBy: { kind: 'agent', name: 'delta', via: null, label: 'agent:delta' },
        forcedWrites: 3,
      },
    })
    expect(chronicle).toMatchObject({
      createdAtSource: 'import',
      lastForcedAt: 1788700000000,
      forcedWrites: 3,
    })
    expect(chronicle?.lastForcedBy?.label).toBe('agent:delta')
    // A flat string actor still parses, so the nested/flat mix in the envelope
    // cannot leave a principal on the floor.
    expect(chronicle?.createdBy).toEqual({
      kind: 'human',
      name: 'owner',
      via: null,
      label: 'human:owner',
    })
  })
})

describe('parseChronicleActor', () => {
  it('splits the cell kind:name label', () => {
    expect(parseChronicleActor('system:archive-import')).toEqual({
      kind: 'system',
      name: 'archive-import',
      via: null,
      label: 'system:archive-import',
    })
  })

  it('keeps an undecomposable label whole rather than dropping it', () => {
    // Provenance is never a reason to fail a read: a label we cannot split is
    // still evidence about who wrote, and losing it would be worse than showing
    // it raw.
    expect(parseChronicleActor('mystery')).toEqual({
      kind: '',
      name: 'mystery',
      via: null,
      label: 'mystery',
    })
    expect(parseChronicleActor('trailing:')).toMatchObject({ kind: '', name: 'trailing:' })
  })

  it('is null for absent or empty input', () => {
    expect(parseChronicleActor(undefined)).toBeNull()
    expect(parseChronicleActor('   ')).toBeNull()
    expect(parseChronicleActor({})).toBeNull()
  })
})

describe('parseChronicleTimestamp', () => {
  it('reads the cell epoch-millis string', () => {
    expect(parseChronicleTimestamp('1788742073362')).toBe(1788742073362)
  })

  it('tolerates a number and an ISO string, and refuses nonsense', () => {
    expect(parseChronicleTimestamp(1788742073362)).toBe(1788742073362)
    expect(parseChronicleTimestamp('2026-09-05T18:06:02Z')).toBe(Date.parse('2026-09-05T18:06:02Z'))
    expect(parseChronicleTimestamp('whenever')).toBeNull()
    expect(parseChronicleTimestamp(null)).toBeNull()
  })
})

describe('makeDocumentChronicleReader', () => {
  it('clips the body away — the read must not scale with document length', () => {
    // The whole reason this is affordable on every selection change. Dropping
    // maxChars turns a ~1KB metadata read into a full-text one; `ids_only` would
    // be smaller still but carries no chronicle at all (verified against a live
    // cell in scripts/chronicle-surface-probe.mts).
    const callTool = vi.fn().mockResolvedValue(LIVE_ENVELOPE)
    void makeDocumentChronicleReader(callTool).load('graph-a', 'doc-a')
    expect(callTool).toHaveBeenCalledWith('read_document', {
      graphId: 'graph-a',
      documentId: 'doc-a',
      format: 'markdown',
      maxChars: 1,
    })
  })

  it('does not call the cell without both ids', async () => {
    const callTool = vi.fn()
    expect(await makeDocumentChronicleReader(callTool).load('', 'doc-a')).toBeNull()
    expect(await makeDocumentChronicleReader(callTool).load('graph-a', '')).toBeNull()
    expect(callTool).not.toHaveBeenCalled()
  })
})
