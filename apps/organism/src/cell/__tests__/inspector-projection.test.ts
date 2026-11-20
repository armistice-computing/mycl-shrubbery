import { describe, expect, it } from 'vitest'
import type { SelectedObject } from '@shrubbery/nucleus'
import type { WireBundle, WorkspaceComment } from '@shrubbery/runtime'
import {
  activeDocumentSelection,
  chronicleActorLabel,
  projectInspectorActions,
  projectInspectorModel,
  wireCountChip,
} from '../inspector-projection.js'
import type { DocumentChronicle } from '../document-chronicle.js'

const wireBundle: WireBundle = {
  outgoingWires: [
    {
      id: 'wire-out',
      predicate: 'http://mnemosyne.ai/vocab#supports',
      predicateLabel: 'supports',
      otherDocumentId: 'doc-target',
      otherGraphId: 'graph-a',
      otherTitle: 'Target document',
      localBlockId: 'block-a',
      bidirectional: false,
    },
  ],
  incomingWires: [
    {
      id: 'wire-in',
      predicate: 'http://mnemosyne.ai/vocab#references',
      predicateLabel: 'references',
      otherDocumentId: 'doc-source',
      otherGraphId: 'graph-a',
      otherTitle: 'Source document',
      localBlockId: 'block-a',
      bidirectional: true,
    },
  ],
  wiredBlockIds: ['block-a'],
}

const comments: readonly WorkspaceComment[] = [
  {
    id: 'comment-a',
    author: 'Nora',
    text: 'Needs a citation',
    quotedText: 'claim',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    resolved: false,
    blockId: 'block-a',
    documentPosition: 4,
  },
  {
    id: 'comment-b',
    author: 'Shrubbery',
    text: 'Resolved note',
    createdAt: 1700000000001,
    updatedAt: 1700000000001,
    resolved: true,
    blockId: 'block-b',
  },
]

describe('organism inspector projection', () => {
  it('projects the active document identity, with its recent changes instead of wires and comments', () => {
    const model = projectInspectorModel({
      selection: activeDocumentSelection('graph-a', 'doc-a'),
      graphId: 'graph-a',
      activeDocumentId: 'doc-a',
      activeDocumentTitle: 'Garden parity plan',
      wireBundle,
      comments,
    })

    expect(model?.identity).toMatchObject({
      kind: 'document',
      title: 'Garden parity plan',
      typeLabel: 'Document',
    })
    expect(model?.relations?.scope).toBe('active')
    expect(model?.relations?.label).toBe('Recent changes')
    // Wires and comments have their own homes (Eschaton, 2026-11-17).
    expect(model?.relations?.groups ?? []).toEqual([])
    expect(model?.relations?.emptyText).toMatch(/not available/)
  })

  it('lists who changed the document, an agent beside you, most recent first', () => {
    const model = projectInspectorModel({
      selection: activeDocumentSelection('graph-a', 'doc-a'),
      graphId: 'graph-a',
      activeDocumentId: 'doc-a',
      activeDocumentTitle: 'Garden parity plan',
      chronicle: chronicle({
        recentAuthors: [
          { actor: { kind: 'agent', name: 'claude-code-laptop', via: 'client-token:t9', label: 'agent:claude-code-laptop' }, firstAt: 1788742073176, lastAt: 1788742073362, lastRevision: 9, writes: 3 },
          { actor: { kind: 'human', name: 'owner', via: null, label: 'human:owner' }, firstAt: 1788742070000, lastAt: 1788742071000, lastRevision: 6, writes: 1 },
        ],
      }),
    })
    const group = model?.relations?.groups?.[0]
    expect(group?.static).toBe(true)
    expect(group?.items.map((item) => [item.primary, item.icon])).toEqual([
      ['Claude-code-laptop', 'bot'],
      ['You', 'user'],
    ])
    expect(group?.items[0]?.secondary).toMatch(/^3 changes · last /)
    expect(group?.items[1]?.secondary).toMatch(/^1 change · last /)
  })

  it('shows no relations for a block: its wires and comments live elsewhere', () => {
    const selection: SelectedObject = {
      kind: 'block',
      graphId: 'graph-a',
      documentId: 'doc-a',
      blockId: 'block-a',
    }
    const model = projectInspectorModel({
      selection,
      graphId: 'graph-a',
      activeDocumentId: 'doc-a',
      activeDocumentTitle: 'Garden parity plan',
      wireBundle,
      comments,
    })

    expect(model?.identity.title).toBe('Block in Garden parity plan')
    expect(model?.relations).toEqual({ scope: 'none', groups: [] })
  })

  it('projects comment identity and comment actions from loaded Y.Map metadata', () => {
    const selection: SelectedObject = {
      kind: 'comment',
      graphId: 'graph-a',
      documentId: 'doc-a',
      commentId: 'comment-a',
      blockId: 'block-a',
    }
    const input = {
      selection,
      graphId: 'graph-a',
      activeDocumentId: 'doc-a',
      activeDocumentTitle: 'Garden parity plan',
      wireBundle,
      comments,
    }

    expect(projectInspectorModel(input)?.identity).toMatchObject({
      kind: 'comment',
      title: 'Needs a citation',
      typeLabel: 'Comment by Nora',
    })
    expect(projectInspectorActions(input).map((action) => {
      if ('id' in action) return action.id
      return action.type === 'header' ? action.content : 'divider'
    })).toEqual([
      'Comment',
      'comment.resolve',
      'comment.delete',
    ])
  })

  it('marks relations inactive when the selected object is outside the loaded document', () => {
    const model = projectInspectorModel({
      selection: {
        kind: 'document',
        graphId: 'graph-a',
        documentId: 'doc-other',
      },
      graphId: 'graph-a',
      activeDocumentId: 'doc-a',
      activeDocumentTitle: 'Garden parity plan',
      wireBundle,
      comments,
    })

    expect(model?.identity.title).toBe('doc-other')
    expect(model?.relations).toMatchObject({ scope: 'inactive', groups: [] })
    expect(model?.relations?.inactiveText).toMatch(/history/)
  })

  it('projects folder and artifact selections as first-class inspector identities', () => {
    const folder = projectInspectorModel({
      selection: {
        kind: 'folder',
        graphId: 'graph-a',
        folderId: 'folder-a',
        label: 'Research',
      },
      graphId: 'graph-a',
      activeDocumentId: null,
    })
    expect(folder?.identity).toMatchObject({
      kind: 'folder',
      icon: 'folder',
      title: 'Research',
      typeLabel: 'Folder',
    })

    const artifact = projectInspectorModel({
      selection: {
        kind: 'artifact',
        graphId: 'graph-a',
        artifactId: 'artifact-a',
        label: 'Sketch.png',
        mimeType: 'image/png',
        status: 'ready',
      },
      graphId: 'graph-a',
      activeDocumentId: null,
    })
    expect(artifact?.identity).toMatchObject({
      kind: 'artifact',
      icon: 'diamond',
      title: 'Sketch.png',
      typeLabel: 'File',
    })
    expect(artifact?.identity.chips?.map((chip) => [chip.label, chip.value])).toContainEqual(['MIME', 'image/png'])
  })
})

/**
 * A base chronicle for the chip tests. Timestamps are asserted through the
 * projection's own formatter rather than against a literal string, because
 * `toLocaleString` is machine-local and a hard-coded "Sep 5, 6:06 PM" would pass
 * here and fail in CI, or on Eschaton's machine in another timezone.
 */
function chronicle(overrides: Partial<DocumentChronicle> = {}): DocumentChronicle {
  return {
    title: 'Offline Garden — The Short-Term Plan',
    createdAt: 1788742073176,
    updatedAt: 1788742073362,
    revision: 4,
    createdBy: { kind: 'human', name: 'owner', via: null, label: 'human:owner' },
    updatedBy: { kind: 'agent', name: 'delta', via: 'client-token:t1', label: 'agent:delta' },
    recentAuthors: [],
    createdAtSource: null,
    lastForcedAt: null,
    lastForcedBy: null,
    forcedWrites: 0,
    ...overrides,
  }
}

function documentChips(input: Partial<Parameters<typeof projectInspectorModel>[0]> = {}) {
  const model = projectInspectorModel({
    selection: activeDocumentSelection('graph-a', 'doc-a'),
    graphId: 'graph-a',
    activeDocumentId: 'doc-a',
    activeDocumentTitle: 'Offline Garden — The Short-Term Plan',
    ...input,
  })
  return (model?.identity.chips ?? []).map((chip) => [chip.label, chip.value] as const)
}

describe('inspector chronicle chips', () => {
  it('puts provenance above the ids, and keeps both ids', () => {
    const chips = documentChips({ chronicle: chronicle() })
    expect(chips.map(([label]) => label)).toEqual([
      'Revision',
      'Updated',
      'Created',
      'Graph',
      'Document',
    ])
    expect(chips.find(([label]) => label === 'Revision')?.[1]).toBe('4')
    // `agent:delta` reads as a name, `human:owner` as "you" — the one human on a
    // local node is the person looking at the screen.
    expect(chips.find(([label]) => label === 'Updated')?.[1]).toContain('\u00b7 Delta')
    expect(chips.find(([label]) => label === 'Created')?.[1]).toContain('\u00b7 you')
  })

  it('adds nothing when there is no chronicle', () => {
    // The hosted lane, and every render before the read lands. The panel must
    // look exactly as it did rather than flashing empty provenance rows.
    expect(documentChips()).toEqual([
      ['Graph', 'graph-a'],
      ['Document', 'doc-a'],
    ])
  })

  it('shows a bare date rather than inventing an author', () => {
    const chips = documentChips({
      chronicle: chronicle({ createdBy: null, updatedBy: null }),
    })
    const updated = chips.find(([label]) => label === 'Updated')?.[1] ?? ''
    expect(updated).not.toContain('\u00b7')
    expect(updated).not.toMatch(/unknown/i)
    expect(updated.length).toBeGreaterThan(0)
  })

  it('drops the row entirely when a chronicle knows nothing', () => {
    expect(
      documentChips({
        chronicle: chronicle({
          createdAt: null,
          updatedAt: null,
          revision: null,
          createdBy: null,
          updatedBy: null,
        }),
      }).map(([label]) => label),
    ).toEqual(['Graph', 'Document'])
  })

  it('says Imported when the created clock is the import instant', () => {
    // createdAtSource 'import' means the machine guessed the birthday. Calling
    // that "Created" would launder a guess into a fact.
    const chips = documentChips({ chronicle: chronicle({ createdAtSource: 'import' }) })
    expect(chips.map(([label]) => label)).toContain('Imported')
    expect(chips.map(([label]) => label)).not.toContain('Created')
  })

  it('shows the forced-write trail only when there is one', () => {
    expect(documentChips({ chronicle: chronicle() }).map(([label]) => label)).not.toContain('Forced')

    const forced = documentChips({
      chronicle: chronicle({
        forcedWrites: 3,
        lastForcedBy: { kind: 'agent', name: 'delta', via: null, label: 'agent:delta' },
      }),
    })
    expect(forced.find(([label]) => label === 'Forced')?.[1]).toBe('3\u00d7 \u00b7 last by Delta')

    const once = documentChips({ chronicle: chronicle({ forcedWrites: 1 }) })
    expect(once.find(([label]) => label === 'Forced')?.[1]).toBe('once')
  })

  it('does not lend the open document authorship to another document', () => {
    // The host loads ONE chronicle, for the document that is open. Selecting a
    // different document in the sidebar must not decorate it with the open
    // document's revision count.
    const chips = documentChips({
      selection: { kind: 'document', documentId: 'doc-other', graphId: 'graph-a' },
      chronicle: chronicle(),
    })
    expect(chips.map(([label]) => label)).toEqual(['Graph', 'Document'])
  })
})

describe('chronicleActorLabel', () => {
  it('renders each actor kind the way it should be read', () => {
    expect(chronicleActorLabel({ kind: 'human', name: 'owner', via: null, label: 'human:owner' })).toBe('you')
    expect(chronicleActorLabel({ kind: 'agent', name: 'delta', via: null, label: 'agent:delta' })).toBe('Delta')
    expect(
      chronicleActorLabel({ kind: 'system', name: 'archive-import', via: null, label: 'system:archive-import' }),
    ).toBe('archive import')
    // An unrecognised kind keeps its raw label rather than disappearing.
    expect(chronicleActorLabel({ kind: '', name: 'mystery', via: null, label: 'mystery' })).toBe('mystery')
    expect(chronicleActorLabel(null)).toBeNull()
  })
})

describe('inspector wire count', () => {
  it('counts outgoing plus incoming, and a wire inside the document once', () => {
    expect(wireCountChip(wireBundle)).toEqual({ label: 'Wires', value: '2 \u00b7 1 out, 1 in' })
    const selfWire = { ...wireBundle.outgoingWires[0]!, id: 'wire-self', otherDocumentId: 'doc-a' }
    const bundle: WireBundle = {
      ...wireBundle,
      outgoingWires: [...wireBundle.outgoingWires, selfWire],
      incomingWires: [...wireBundle.incomingWires, selfWire],
    }
    expect(wireCountChip(bundle)?.value).toBe('3 \u00b7 2 out, 2 in')
    expect(wireCountChip({ outgoingWires: [], incomingWires: [], wiredBlockIds: [] })?.value).toBe('none yet')
    expect(wireCountChip(null)).toBeNull()
  })

  it('shows the count on the open document, above the ids', () => {
    const model = projectInspectorModel({
      selection: activeDocumentSelection('graph-a', 'doc-a'),
      graphId: 'graph-a',
      activeDocumentId: 'doc-a',
      wireBundle,
    })
    expect(model?.identity.chips?.map((chip) => chip.label)).toEqual(['Wires', 'Graph', 'Document'])
  })
})
